import { type ChildProcess, spawn, type SpawnOptions, spawnSync } from "child_process";

/**
 * Shell command started as the root of its own process tree, so that the whole tree can be killed.
 *
 * On Windows the tree is killed with `taskkill /T /F`; elsewhere the command leads its own process
 * group, which receives SIGTERM and, after a grace period, SIGKILL.
 */
export class ProcessTree {
    private static readonly IS_WINDOWS = process.platform === "win32";
    private static readonly KILL_GRACE_MS = 3000;

    /** The root process (the shell). */
    public readonly child: ChildProcess;
    private readonly exited: Promise<void>;
    private exitedFlag = false;

    /**
     * Starts a shell command.
     *
     * @param command - the shell command line
     * @param options - spawn options (`shell`, `detached` and `windowsHide` are set here)
     */
    constructor(command: string, options: Omit<SpawnOptions, "shell" | "detached">) {
        this.child = spawn(command, {
            ...options,
            shell: true,
            detached: !ProcessTree.IS_WINDOWS,
            windowsHide: true,
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
     * Kills the whole tree and waits for the root to exit.
     */
    public async kill(): Promise<void> {
        const pid = this.child.pid;
        if (pid === undefined || this.exitedFlag) {
            await this.exited;
            return;
        }
        if (ProcessTree.IS_WINDOWS) {
            await new Promise<void>((resolve) => {
                spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
                    .once("exit", () => resolve())
                    .once("error", () => {
                        this.child.kill();
                        resolve();
                    });
            });
        } else {
            ProcessTree.signalGroup(pid, "SIGTERM");
            const timer = setTimeout(() => ProcessTree.signalGroup(pid, "SIGKILL"), ProcessTree.KILL_GRACE_MS);
            await this.exited;
            clearTimeout(timer);
            // children that ignored SIGTERM must not outlive the shell
            ProcessTree.signalGroup(pid, "SIGKILL");
            return;
        }
        await this.exited;
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
            spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
            ProcessTree.signalGroup(pid, "SIGKILL");
        }
    }

    private static signalGroup(pid: number, signal: NodeJS.Signals): void {
        try {
            process.kill(-pid, signal);
        } catch {
            // the group is gone already
        }
    }
}
