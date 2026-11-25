import { EventEmitter } from "events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import type { Readable, Writable } from "stream";
import type { ClaudeCommandProblem } from "@penpot/mcp-common";
import { ProcessTree } from "../process/ProcessTree";
import type { ClaudeCommand } from "./ClaudeCommands";
import { LoginShell } from "./LoginShell";

/** How Claude Code has to be started: what the Agent SDK would spawn. */
export interface ClaudeStart {
    /** Claude Code itself (or the JavaScript runtime that runs it) */
    file: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
}

/**
 * Claude Code started through a wrapper; has the shape the Agent SDK expects of a process.
 *
 * Ends with {@link problem} set when the wrapper never got to `claude`.
 */
export class WrappedClaude extends EventEmitter {
    private static readonly POLL_MS = 50;
    private static readonly running = new Set<WrappedClaude>();

    public readonly stdin: Writable;
    public readonly stdout: Readable;
    public killed = false;
    public exitCode: number | null = null;
    public signalCode: NodeJS.Signals | null = null;
    /** why Claude Code did not start, if so */
    public problem: ClaudeCommandProblem | null = null;

    private started = false;
    private readonly poll: NodeJS.Timeout;

    /**
     * @param tree - the wrapper, with Claude's input on descriptor 4 and its output on 3
     * @param folder - private folder of the `claude` stand-in, removed at the end
     * @param marker - file the stand-in makes when it is reached
     * @param startTimeoutMs - time the wrapper has to reach it
     * @param onStderr - receives what Claude Code writes to standard error
     */
    constructor(
        private readonly tree: ProcessTree,
        private readonly folder: string,
        private readonly marker: string,
        startTimeoutMs: number,
        onStderr?: (text: string) => void
    ) {
        super();
        WrappedClaude.killAtExit();
        WrappedClaude.running.add(this);
        this.stdout = tree.child.stdio[3] as Readable;
        this.stdin = tree.child.stdio[4] as Writable;
        // writing to a wrapper that ended is no error of its own: the exit tells
        this.stdin.on("error", () => {});
        // what the wrapper itself prints may hold secrets: it is dropped
        tree.child.stderr?.on("data", (chunk: Buffer) => {
            if (this.hasStarted()) {
                onStderr?.(chunk.toString());
            }
        });
        const deadline = Date.now() + startTimeoutMs;
        this.poll = setInterval(() => {
            if (this.hasStarted()) {
                clearInterval(this.poll);
            } else if (Date.now() > deadline) {
                this.problem = "timeout";
                this.kill("SIGTERM");
            }
        }, WrappedClaude.POLL_MS);
        tree.child.once("error", (error) => {
            this.end();
            this.emit("error", error);
        });
        tree.child.once("exit", (code, signal) => {
            if (!this.hasStarted() && !this.killed) {
                this.problem = "not-started";
            }
            this.end();
            // a wrapper that ended well without Claude Code did not do its work
            this.exitCode = this.problem !== null && code === 0 ? 1 : code;
            this.signalCode = signal;
            this.emit("exit", this.exitCode, signal);
        });
    }

    /** Whether the wrapper reached Claude Code. */
    public hasStarted(): boolean {
        this.started ||= existsSync(this.marker);
        return this.started;
    }

    /**
     * Ends the wrapper and every process it started.
     */
    public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        if (this.tree.hasExited) {
            return false;
        }
        this.killed = true;
        clearInterval(this.poll);
        if (signal === "SIGKILL") {
            this.tree.killSync();
        } else {
            void this.tree.kill();
        }
        return true;
    }

    private end(): void {
        clearInterval(this.poll);
        WrappedClaude.running.delete(this);
        rmSync(this.folder, { recursive: true, force: true });
    }

    /** The wrapper leads its own process group, so it would outlive the daemon. */
    private static readonly killAtExit = (() => {
        let installed = false;
        return () => {
            if (!installed) {
                installed = true;
                process.on("exit", () => {
                    for (const claude of WrappedClaude.running) {
                        claude.tree.killSync();
                        rmSync(claude.folder, { recursive: true, force: true });
                    }
                });
            }
        };
    })();
}

/**
 * Launcher of Claude Code through a wrapper: an alias or function of the user's shell, or a script.
 *
 * Wrappers prepare something (environment variables, a local model) and end by running `claude`,
 * often without passing on arguments. So the wrapper gets none: a private folder, first on `PATH`,
 * holds a stand-in named `claude`, which starts Claude Code with the wrapper's own arguments
 * followed by those of the caller. The conversation with Claude Code runs over two descriptors of
 * its own, so nothing the wrapper prints or reads can disturb it.
 */
export class ClaudeLauncher {
    /** Time a wrapper has to reach `claude`; it may start a local server first. */
    public static readonly START_TIMEOUT_MS = 60_000;

    /** uses of `claude` that start no session: a wrapper may check the version or the login first */
    private static readonly OTHER_USES =
        "-v|--version|-h|--help|auth|config|doctor|install|mcp|plugin|setup-token|update|upgrade";

    /**
     * @param shell - the user's shell, for aliases and functions
     * @param startTimeoutMs - time a wrapper has to reach `claude`
     */
    constructor(
        private readonly shell: LoginShell | null,
        private readonly startTimeoutMs: number = ClaudeLauncher.START_TIMEOUT_MS
    ) {}

    /**
     * Starts Claude Code through a wrapper.
     *
     * @param command - the wrapper
     * @param start - how Claude Code has to be started
     * @param onStderr - receives what Claude Code writes to standard error
     */
    public start(command: ClaudeCommand, start: ClaudeStart, onStderr?: (text: string) => void): WrappedClaude {
        // the folder is readable by this user only: the arguments hold the system prompt
        const folder = mkdtempSync(join(tmpdir(), "penforge-claude-"));
        try {
            const marker = join(folder, "started");
            writeFileSync(join(folder, "claude"), ClaudeLauncher.standIn(start, marker), { mode: 0o700 });
            const { file, args } = this.program(command);
            const env = LoginShell.environment({
                ...start.env,
                PATH: [folder, start.env.PATH ?? ""].filter(Boolean).join(delimiter),
                PENFORGE_CLAUDE_SHIM: folder,
            });
            const tree = new ProcessTree(
                { file, args, windowsVerbatimArguments: false },
                { cwd: start.cwd, env, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] }
            );
            return new WrappedClaude(tree, folder, marker, this.startTimeoutMs, onStderr);
        } catch (error) {
            rmSync(folder, { recursive: true, force: true });
            throw error;
        }
    }

    private program(command: ClaudeCommand): { file: string; args: string[] } {
        if (command.path !== undefined) {
            return { file: command.path, args: [] };
        }
        if (this.shell === null) {
            throw new Error("Aliases and functions need bash or zsh");
        }
        // the start files may have put other folders first on PATH; the name is a checked bare
        // name on a line of its own, so the shell expands it when it is an alias
        return this.shell.run(`PATH="$PENFORGE_CLAUDE_SHIM:$PATH"; export PATH\n${command.command}\n`);
    }

    /** Script that takes the place of `claude` for the wrapper. */
    private static standIn(start: ClaudeStart, marker: string): string {
        const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
        // the caller starts a script of Claude Code as `node <script> <arguments>`
        const firstFlag = start.args.findIndex((arg) => arg.startsWith("-"));
        const script = start.args
            .slice(0, firstFlag < 0 ? undefined : firstFlag)
            .findIndex((arg) => /\.[cm]?js$/.test(arg));
        const runtime = [start.file, ...start.args.slice(0, script + 1)].map(quote).join(" ");
        const args = start.args
            .slice(script + 1)
            .map(quote)
            .join(" ");
        return [
            "#!/bin/sh",
            `case "\${1-}" in ${ClaudeLauncher.OTHER_USES}) exec ${runtime} "$@" ;; esac`,
            `: > ${quote(marker)}`,
            `cd ${quote(start.cwd)} || exit 1`,
            `exec ${runtime} "$@" ${args} <&4 >&3 3>&- 4<&-`,
            "",
        ].join("\n");
    }
}
