import { spawn, spawnSync } from "child_process";
import type { AbortSignalLike } from "@penpot/mcp-common";
import { CommandSchema } from "./BuildFiles";
import { CommandLauncher } from "../process/CommandLauncher";
import { ChildEnvironment } from "./ChildEnvironment";

/** Options of one command run. */
export interface CommandOptions {
    /** working directory */
    cwd: string;
    /** aborts the command (process tree is killed) */
    signal?: AbortSignalLike;
    /** time limit in milliseconds */
    timeoutMs: number;
}

/** Outcome of one command run. */
export interface CommandOutcome {
    /** exit code; null when killed (abort or timeout) */
    code: number | null;
    /** combined stdout and stderr, cut to the last part */
    output: string;
    timedOut: boolean;
}

/**
 * Executor of stack commands (`stack.json` `commands.*`) in the generated app's folder.
 *
 * A strategy, so tests can replace real processes.
 */
export interface CommandExecutor {
    execute(argv: string[], options: CommandOptions): Promise<CommandOutcome>;
}

/**
 * Executor running commands as child processes.
 *
 * Only argument vectors accepted by {@link CommandSchema} run, and never through a shell: the
 * program is started directly, or a Windows batch shim (`npm.cmd`) through `cmd.exe` with quoted
 * arguments ({@link CommandLauncher}, shared with the dev server manager).
 * What the command then runs (package scripts, dependencies) is code Claude wrote or chose; it
 * gets a scrubbed environment ({@link ChildEnvironment}) without the daemon's secrets. The whole
 * process tree is killed on abort or timeout.
 */
export class ProcessCommandExecutor implements CommandExecutor {
    private static readonly MAX_OUTPUT_CHARS = 64 * 1024;
    private static readonly IS_WINDOWS = process.platform === "win32";

    public execute(argv: string[], options: CommandOptions): Promise<CommandOutcome> {
        const checked = CommandSchema.safeParse(argv);
        if (!checked.success) {
            return Promise.reject(new Error(`Refusing to run ${JSON.stringify(argv)}: ${checked.error.message}`));
        }
        if (options.signal?.aborted) {
            return Promise.reject(new Error("cancelled"));
        }
        const env = ChildEnvironment.scrub(process.env, { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" });
        let spec: ReturnType<CommandLauncher["spawnSpec"]>;
        try {
            spec = new CommandLauncher(env).spawnSpec(argv);
        } catch (error) {
            return Promise.reject(error);
        }
        return new Promise<CommandOutcome>((resolve, reject) => {
            const child = spawn(spec.file, spec.args, {
                cwd: options.cwd,
                env,
                shell: false,
                windowsVerbatimArguments: spec.windowsVerbatimArguments,
                detached: !ProcessCommandExecutor.IS_WINDOWS,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            let timedOut = false;
            const append = (chunk: Buffer) => {
                output += chunk.toString("utf8");
                if (output.length > ProcessCommandExecutor.MAX_OUTPUT_CHARS * 2) {
                    output = output.slice(-ProcessCommandExecutor.MAX_OUTPUT_CHARS);
                }
            };
            child.stdout?.on("data", append);
            child.stderr?.on("data", append);

            const kill = () => ProcessCommandExecutor.killTree(child.pid);
            const onAbort = () => kill();
            options.signal?.addEventListener("abort", onAbort, { once: true });
            const timer = setTimeout(() => {
                timedOut = true;
                kill();
            }, options.timeoutMs);

            const finish = () => {
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", onAbort);
            };
            child.on("error", (error) => {
                finish();
                reject(error);
            });
            child.on("close", (code) => {
                finish();
                if (options.signal?.aborted) {
                    reject(new Error("cancelled"));
                    return;
                }
                resolve({
                    code: timedOut ? null : code,
                    output: output.slice(-ProcessCommandExecutor.MAX_OUTPUT_CHARS),
                    timedOut,
                });
            });
        });
    }

    /** Kills a process and all its children. */
    private static killTree(pid: number | undefined): void {
        if (pid === undefined) {
            return;
        }
        try {
            if (ProcessCommandExecutor.IS_WINDOWS) {
                spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
            } else {
                // detached: the child leads its own process group
                process.kill(-pid, "SIGKILL");
            }
        } catch {
            // already gone
        }
    }
}
