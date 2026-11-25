import { tmpdir } from "os";
import { finished } from "stream/promises";
import type { ClaudeCommandProblem } from "@penpot/mcp-common";
import { CommandLauncher } from "../process/CommandLauncher";
import { ProcessTree } from "../process/ProcessTree";
import { ClaudeCommandName } from "./ClaudeCommandName";
import type { ClaudeCommand, ClaudeCommands } from "./ClaudeCommands";
import { ClaudeLauncher, type ClaudeStart, type WrappedClaude } from "./ClaudeLauncher";

/** Outcome of trying a Claude command. */
export interface ClaudeCheck {
    found: boolean;
    command?: ClaudeCommand;
    /** version number Claude Code reports */
    version?: string;
    problem?: ClaudeCommandProblem;
}

/**
 * The Claude command of one turn.
 */
export class ClaudeTurnCommand {
    /**
     * @param command - the user's command
     * @param path - Claude Code itself; undefined for the copy bundled with the Agent SDK
     * @param launcher - starts wrappers
     */
    constructor(
        private readonly command: ClaudeCommand,
        public readonly path: string | undefined,
        private readonly launcher: ClaudeLauncher
    ) {}

    /** Whether the command is a wrapper, which {@link start} has to start. */
    public get wrapper(): boolean {
        return this.command.wrapper;
    }

    /**
     * Starts Claude Code through the wrapper.
     *
     * @param start - how Claude Code has to be started
     * @param onStderr - receives what Claude Code writes to standard error
     */
    public start(start: ClaudeStart, onStderr?: (text: string) => void): WrappedClaude {
        return this.launcher.start(this.command, start, onStderr);
    }

    /**
     * Gets why the wrapper never got to Claude Code, for the user.
     *
     * @param wrapped - the process of {@link start}
     */
    public startFailure(wrapped: WrappedClaude | undefined): string | undefined {
        if (!wrapped || (wrapped.problem === null && wrapped.hasStarted())) {
            return undefined;
        }
        const name = `The Claude command "${this.command.command}"`;
        switch (wrapped.problem ?? "not-started") {
            case "timeout":
                return `${name} took too long and did not start claude. Run it in a terminal to see why.`;
            case "not-started":
                return `${name} ended without starting claude. Run it in a terminal to see why.`;
            default:
                return undefined;
        }
    }
}

/**
 * Source of the Claude command the local runners use, so that a change of the setting holds from
 * the next turn on.
 */
export class ClaudeSource {
    private static readonly CHECK_TIMEOUT_MS = 20_000;
    private static readonly DRAIN_MS = 500;
    private static readonly VERSION = /^\s*v?(\d+\.\d+\.\d+[A-Za-z0-9.+-]*)/;

    private readonly launcher: ClaudeLauncher;

    /**
     * @param commands - finds commands
     * @param current - gets the command that is set
     * @param launcher - starts wrappers
     */
    constructor(
        private readonly commands: ClaudeCommands,
        private readonly current: () => string,
        launcher?: ClaudeLauncher
    ) {
        this.launcher = launcher ?? new ClaudeLauncher(commands.shell);
    }

    /** Whether the next turn runs Claude itself (see `ClaudeCommandName.isClaude`). */
    public get isClaude(): boolean {
        return ClaudeCommandName.isClaude(this.current());
    }

    /**
     * Gets the command of the next turn.
     *
     * @throws Error when this computer has no such command
     */
    public async forTurn(): Promise<ClaudeTurnCommand> {
        const value = this.current();
        const command = await this.commands.find(value);
        if (!command) {
            throw new Error(
                `The Claude command "${value}" was not found on this computer. Change it in Settings > AI.`
            );
        }
        const path = command.wrapper ? await this.commands.findClaude() : command.path;
        return new ClaudeTurnCommand(command, path, this.launcher);
    }

    /**
     * Tries a command: finds it and asks Claude Code for its version.
     *
     * @param value - the command, as `ClaudeCommandName` accepts it
     */
    public async check(value: string): Promise<ClaudeCheck> {
        const command = await this.commands.find(value);
        if (!command) {
            return { found: false, problem: "not-found" };
        }
        if (command.kind === "bundled") {
            return { found: true, command };
        }
        return command.wrapper ? this.checkWrapper(command) : this.checkProgram(command, command.path!);
    }

    private checkProgram(command: ClaudeCommand, path: string): Promise<ClaudeCheck> {
        const env = this.commands.environment;
        const [file, args] = /\.[cm]?js$/.test(path) ? [process.execPath, [path, "--version"]] : [path, ["--version"]];
        return new Promise((resolve) => {
            const tree = new ProcessTree(new CommandLauncher(env).spawnSpec([file, ...args]), {
                cwd: tmpdir(),
                env,
                stdio: ["ignore", "pipe", "ignore"],
            });
            let output = "";
            const timer = setTimeout(() => {
                void tree.kill();
                resolve({ found: true, command, problem: "timeout" });
            }, ClaudeSource.CHECK_TIMEOUT_MS);
            tree.child.stdout?.on("data", (chunk: Buffer) => (output = ClaudeSource.append(output, chunk)));
            tree.child.on("error", () => {
                clearTimeout(timer);
                resolve({ found: true, command, problem: "failed" });
            });
            tree.child.once("close", (code) => {
                clearTimeout(timer);
                resolve(ClaudeSource.result(command, code, output));
            });
        });
    }

    private async checkWrapper(command: ClaudeCommand): Promise<ClaudeCheck> {
        const path = await this.commands.findClaude();
        if (path === undefined) {
            // nothing to ask for its version: the bundled copy has no file of its own
            return { found: true, command };
        }
        const env = this.commands.environment;
        const start = /\.[cm]?js$/.test(path)
            ? { file: process.execPath, args: [path, "--version"] }
            : { file: path, args: ["--version"] };
        return new Promise((resolve) => {
            const wrapped = this.launcher.start(command, { ...start, cwd: tmpdir(), env });
            let output = "";
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                wrapped.kill("SIGTERM");
            }, ClaudeSource.CHECK_TIMEOUT_MS);
            wrapped.stdin.end();
            wrapped.stdout.on("data", (chunk: Buffer) => (output = ClaudeSource.append(output, chunk)));
            wrapped.on("error", () => {
                clearTimeout(timer);
                resolve({ found: true, command, problem: "failed" });
            });
            wrapped.once("exit", async (code: number | null) => {
                clearTimeout(timer);
                // the last output may still be on its way
                await Promise.race([
                    finished(wrapped.stdout).catch(() => {}),
                    new Promise((done) => setTimeout(done, ClaudeSource.DRAIN_MS)),
                ]);
                const problem = wrapped.problem ?? (timedOut ? "timeout" : null);
                resolve(problem ? { found: true, command, problem } : ClaudeSource.result(command, code, output));
            });
        });
    }

    /** Only the version number leaves the daemon: a wrong command may print anything. */
    private static result(command: ClaudeCommand, code: number | null, output: string): ClaudeCheck {
        const version = code === 0 ? ClaudeSource.VERSION.exec(output)?.[1] : undefined;
        return version ? { found: true, command, version } : { found: true, command, problem: "failed" };
    }

    private static append(output: string, chunk: Buffer): string {
        return (output + chunk.toString()).slice(0, 4096);
    }
}
