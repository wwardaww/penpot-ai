import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { LogSink } from "./LogSink";
import { isAlive, treeKill } from "./treeKill";

export interface ProcessSpec {
    /** Short service name, used in logs and errors. */
    name: string;
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd?: string;
    /** Log file the output goes to. */
    logFile: string;
}

export interface ExitInfo {
    code: number | null;
    signal: NodeJS.Signals | null;
    /** True when the supervisor asked for the stop. */
    expected: boolean;
}

export interface StopOptions {
    /** Polite stop first (e.g. `pg_ctl stop`); the tree is killed when it does not exit in time. */
    graceful?: () => Promise<void>;
    /** How long to wait for the exit after the polite stop (default 10 s). */
    timeoutMs?: number;
}

/**
 * One child process of the supervisor: spawned without a shell, output to a log file, killed
 * with its whole process tree.
 *
 * Events: `exit` (ExitInfo).
 */
export class ManagedProcess extends EventEmitter {
    private child?: ChildProcess;
    private stopping = false;
    private exitPromise?: Promise<ExitInfo>;
    public readonly log: LogSink;

    constructor(
        public readonly spec: ProcessSpec,
        private readonly platform: NodeJS.Platform = process.platform,
    ) {
        super();
        this.log = new LogSink(spec.logFile);
    }

    public get pid(): number | undefined {
        return this.child?.pid;
    }

    public get running(): boolean {
        return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
    }

    /** Spawns the process; rejects when it cannot be spawned at all (missing binary). */
    public start(): Promise<void> {
        if (this.running) {
            return Promise.resolve();
        }
        this.stopping = false;
        this.log.note(`start ${this.spec.command} ${this.spec.args.join(" ")}`);
        const child = spawn(this.spec.command, this.spec.args, {
            cwd: this.spec.cwd,
            env: this.spec.env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            // own process group on POSIX so the whole tree can be signalled
            detached: this.platform !== "win32",
        });
        this.child = child;
        child.stdout?.on("data", (chunk: Buffer) => this.log.write(chunk));
        child.stderr?.on("data", (chunk: Buffer) => this.log.write(chunk));
        this.exitPromise = new Promise<ExitInfo>((resolve) => {
            child.once("exit", (code, signal) => {
                const info: ExitInfo = { code, signal, expected: this.stopping };
                this.log.note(`exit code=${code} signal=${signal} expected=${info.expected}`);
                resolve(info);
                this.emit("exit", info);
            });
        });
        return new Promise<void>((resolve, reject) => {
            child.once("spawn", () => resolve());
            child.once("error", (error) => {
                this.log.note(`spawn error: ${error.message}`);
                reject(new Error(`${this.spec.name}: cannot start ${this.spec.command}: ${error.message}`));
            });
        });
    }

    /** Resolves when the process exits (immediately when it is not running). */
    public waitForExit(): Promise<ExitInfo> {
        return this.exitPromise ?? Promise.resolve({ code: null, signal: null, expected: true });
    }

    /**
     * Stops the process and its children.
     *
     * With `graceful` (e.g. `pg_ctl stop`): run it, wait up to `timeoutMs`, then kill the tree.
     * Without it: Windows kills the tree at once (`taskkill /T /F` needs the parent alive to find
     * the children); POSIX sends SIGTERM to the process group, then SIGKILL after `timeoutMs`.
     */
    public async stop(options: StopOptions = {}): Promise<ExitInfo> {
        const child = this.child;
        if (!child || !this.running) {
            return this.waitForExit();
        }
        this.stopping = true;
        const pid = child.pid!;
        const timeoutMs = options.timeoutMs ?? 10_000;
        const windows = this.platform === "win32";
        try {
            if (options.graceful) {
                await options.graceful();
            } else if (windows) {
                treeKill(pid, this.platform);
            } else {
                treeKill(pid, this.platform, "SIGTERM");
            }
        } catch (error) {
            this.log.note(`graceful stop failed: ${(error as Error).message}`);
        }
        const exited = await this.exitWithin(timeoutMs);
        if (!exited) {
            this.log.note("still running after the timeout, killing the process tree");
            treeKill(pid, this.platform);
        } else if (!windows) {
            // children that outlived the leader still hold the process group
            treeKill(pid, this.platform);
        }
        return this.waitForExit();
    }

    /** Closes the log file; call once the process is stopped for good. */
    public async dispose(): Promise<void> {
        await this.log.close().catch(() => undefined);
    }

    private exitWithin(ms: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), ms);
            void this.waitForExit().then(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    /** True when the process (or the id it had) is still alive; for checks after stop. */
    public stillAlive(): boolean {
        return this.child?.pid !== undefined && isAlive(this.child.pid);
    }
}
