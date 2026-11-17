import { type ChildProcess, spawn, type SpawnOptions, spawnSync } from "child_process";
import type { SpawnSpec } from "./CommandLauncher";

/**
 * Program started without a shell as the root of its own process tree, so that the whole tree can
 * be killed.
 *
 * On Windows the tree is killed with `taskkill /T /F`; elsewhere the program leads its own process
 * group, which receives SIGTERM and, after a grace period, SIGKILL. Killing never waits forever:
 * when the root does not exit in time, it is killed directly and given up.
 */
export class ProcessTree {
    private static readonly IS_WINDOWS = process.platform === "win32";
    private static readonly KILL_GRACE_MS = 3000;
    private static readonly KILL_TIMEOUT_MS = 8000;

    /** The root process. */
    public readonly child: ChildProcess;
    private readonly exited: Promise<void>;
    private exitedFlag = false;

    /**
     * Starts a program.
     *
     * @param spec - the program and its arguments
     * @param options - spawn options (`shell`, `detached`, `windowsHide` and verbatim arguments are set here)
     */
    constructor(spec: SpawnSpec, options: Omit<SpawnOptions, "shell" | "detached" | "windowsVerbatimArguments">) {
        this.child = spawn(spec.file, spec.args, {
            ...options,
            shell: false,
            detached: !ProcessTree.IS_WINDOWS,
            windowsHide: true,
            windowsVerbatimArguments: spec.windowsVerbatimArguments,
        });
        this.exited = new Promise((resolve) => {
            const done = () => {
                this.exitedFlag = true;
                resolve();
            };
            this.child.once("exit", done);
            // a failed spawn emits only `error`
            this.child.once("error", () => {
                if (this.child.pid === undefined) {
                    done();
                }
            });
        });
    }

    /** Process id of the root, if it started. */
    public get pid(): number | undefined {
        return this.child.pid;
    }

    /** Whether the root process has exited. */
    public get hasExited(): boolean {
        return this.exitedFlag;
    }

    /**
     * Resolves once the root process has exited.
     */
    public waitForExit(): Promise<void> {
        return this.exited;
    }

    /**
     * Kills the whole tree and waits (a bounded time) for the root to exit.
     */
    public async kill(): Promise<void> {
        const pid = this.child.pid;
        if (pid === undefined || this.exitedFlag) {
            return;
        }
        if (ProcessTree.IS_WINDOWS) {
            const ok = await ProcessTree.taskkill(pid);
            if (!ok) {
                this.child.kill();
            }
        } else {
            ProcessTree.signalGroup(pid, "SIGTERM");
            if (!(await this.exitedWithin(ProcessTree.KILL_GRACE_MS))) {
                ProcessTree.signalGroup(pid, "SIGKILL");
            }
        }
        if (!(await this.exitedWithin(ProcessTree.KILL_TIMEOUT_MS))) {
            // last resort; never block the caller (daemon shutdown) on a stuck process
            this.child.kill("SIGKILL");
            return;
        }
        if (!ProcessTree.IS_WINDOWS) {
            // children that ignored SIGTERM must not outlive the root
            ProcessTree.signalGroup(pid, "SIGKILL");
        }
    }

    /**
     * Kills the whole tree synchronously; for `process.on("exit")` handlers.
     */
    public killSync(): void {
        const pid = this.child.pid;
        if (pid === undefined || this.exitedFlag) {
            return;
        }
        if (ProcessTree.IS_WINDOWS) {
            const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
                windowsHide: true,
                stdio: "ignore",
                timeout: ProcessTree.KILL_TIMEOUT_MS,
            });
            if (result.status !== 0) {
                this.child.kill();
            }
        } else {
            ProcessTree.signalGroup(pid, "SIGKILL");
        }
    }

    private exitedWithin(ms: number): Promise<boolean> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), ms);
            void this.exited.then(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    private static taskkill(pid: number): Promise<boolean> {
        return new Promise((resolve) => {
            const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            const timer = setTimeout(() => {
                killer.kill();
                resolve(false);
            }, ProcessTree.KILL_TIMEOUT_MS);
            killer.once("exit", (code) => {
                clearTimeout(timer);
                resolve(code === 0);
            });
            killer.once("error", () => {
                clearTimeout(timer);
                resolve(false);
            });
        });
    }

    private static signalGroup(pid: number, signal: NodeJS.Signals): void {
        try {
            process.kill(-pid, signal);
        } catch {
            // the group is gone already
        }
    }
}
