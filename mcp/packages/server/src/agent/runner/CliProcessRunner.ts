import { type ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import type { Readable, Writable } from "stream";
import { createLogger } from "../../logger";
import type { ClaudeTurnCommand } from "../claude/ClaudeSource";
import type { ClaudeRunner, RunnerConversation, RunnerEvent, RunnerInput, RunnerOptions } from "./ClaudeRunner";
import { RunnerInputContent } from "./ClaudeRunner";
import { type LocalRunnerSettings, PENPOT_MCP_SERVER_NAME } from "./LocalCliRunner";
import { ClaudeEnvironment } from "./ClaudeEnvironment";
import { SdkMessageMapper } from "./SdkMessageMapper";

/** Claude Code process of a turn. */
interface ClaudeProcess {
    stdin: Writable;
    stdout: Readable;
    /** ends the process and its descendants */
    kill(): void;
    /** why it did not start, if so */
    failure(): string | undefined;
}

/**
 * Fallback runner spawning `claude -p` with `stream-json` input and output.
 *
 * Has no interactive permission channel: only the tools in {@link ALLOWED_TOOLS} are approved, every
 * other tool use is denied by Claude Code. Use {@link LocalCliRunner} where possible.
 */
export class CliProcessRunner implements ClaudeRunner {
    /** Tools approved without asking; Claude Code keeps edits inside the working directory. */
    private static readonly ALLOWED_TOOLS = [
        `mcp__${PENPOT_MCP_SERVER_NAME}`,
        "Read",
        "Glob",
        "Grep",
        "Edit",
        "Write",
        "TodoWrite",
    ];

    public readonly kind = "local-cli-spawn";
    private readonly logger = createLogger("CliProcessRunner");
    private readonly running = new Map<string, ClaudeProcess>();

    constructor(private readonly settings: LocalRunnerSettings) {}

    public async *send(
        conversation: RunnerConversation,
        input: RunnerInput,
        opts: RunnerOptions
    ): AsyncIterable<RunnerEvent> {
        const mapper = new SdkMessageMapper(randomUUID(), true);
        let child: ClaudeProcess;
        try {
            const claude = await this.settings.claude?.forTurn();
            child = this.start(claude, this.args(conversation, opts, claude), opts);
        } catch (error) {
            yield mapper.interrupted(error instanceof Error ? error.message : String(error));
            return;
        }
        this.running.set(conversation.id, child);
        const onAbort = () => child.kill();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        if (opts.signal?.aborted) {
            child.kill();
        }
        child.stdin.on("error", () => {});
        child.stdin.write(JSON.stringify(CliProcessRunner.userMessage(input)) + "\n");

        try {
            for await (const line of createInterface({ input: child.stdout })) {
                if (line.trim().length === 0) {
                    continue;
                }
                let message: unknown;
                try {
                    message = JSON.parse(line);
                } catch {
                    this.logger.debug("Ignoring non-JSON output line: %s", line);
                    continue;
                }
                for (const event of mapper.map(message as Record<string, unknown>)) {
                    yield event;
                }
                if (mapper.isFinished) {
                    break;
                }
            }
        } finally {
            opts.signal?.removeEventListener("abort", onAbort);
            child.stdin.end();
            if (this.running.get(conversation.id) === child) {
                this.running.delete(conversation.id);
            }
            child.kill();
        }
        if (!mapper.isFinished) {
            const reason = opts.signal?.aborted ? "cancelled" : (child.failure() ?? "Claude stopped without a result");
            yield mapper.interrupted(reason);
        }
    }

    public cancel(conversationId?: string): void {
        for (const [id, child] of this.running) {
            if (conversationId === undefined || id === conversationId) {
                child.kill();
            }
        }
    }

    private start(claude: ClaudeTurnCommand | undefined, args: string[], opts: RunnerOptions): ClaudeProcess {
        const env = (opts.env ?? ClaudeEnvironment.forChild()) as NodeJS.ProcessEnv;
        const cwd = opts.cwd;
        const file = (claude ? claude.path : this.settings.claudePath) ?? "claude";
        const onStderr = (text: string) => this.logger.debug("claude stderr: %s", text.trimEnd());
        if (claude?.wrapper) {
            const wrapped = claude.start({ file, args, cwd, env }, onStderr);
            let startError: Error | undefined;
            wrapped.on("error", (error: Error) => (startError = error));
            return {
                stdin: wrapped.stdin,
                stdout: wrapped.stdout,
                kill: () => wrapped.kill(),
                failure: () => claude.startFailure(wrapped) ?? CliProcessRunner.startText(startError),
            };
        }
        const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let spawnError: Error | undefined;
        child.on("error", (error) => (spawnError = error));
        child.stderr.on("data", (data) => onStderr(String(data)));
        return {
            stdin: child.stdin,
            stdout: child.stdout,
            kill: () => CliProcessRunner.killTree(child),
            failure: () => CliProcessRunner.startText(spawnError),
        };
    }

    private static startText(error: Error | undefined): string | undefined {
        return error && `Could not start claude: ${error.message}`;
    }

    private args(conversation: RunnerConversation, opts: RunnerOptions, claude?: ClaudeTurnCommand): string[] {
        const server = {
            type: "http",
            url: this.settings.mcpUrl,
            ...(opts.mcpHeaders ? { headers: opts.mcpHeaders } : {}),
        };
        const mcpConfig = { mcpServers: { [PENPOT_MCP_SERVER_NAME]: server } };
        const args = [
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--setting-sources",
            "project",
            "--strict-mcp-config",
            "--mcp-config",
            JSON.stringify(mcpConfig),
            "--permission-mode",
            "default",
            "--allowedTools",
            (opts.allowedTools ?? CliProcessRunner.ALLOWED_TOOLS).join(","),
            "--append-system-prompt",
            opts.systemPromptAppend,
            // the append changes from turn to turn; a recorded prompt would keep the one of the first turn
            "--system-prompt-snapshot",
            "off",
        ];
        for (const directory of opts.additionalDirectories ?? []) {
            args.push("--add-dir", directory);
        }
        if (conversation.resumeSessionId) {
            args.push("--resume", conversation.resumeSessionId);
        }
        // a wrapper chooses its model itself
        if (this.settings.model && !claude?.wrapper) {
            args.push("--model", this.settings.model);
        }
        return args;
    }

    private static userMessage(input: RunnerInput): unknown {
        const content = RunnerInputContent.blocks(input);
        return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
    }

    /**
     * Kills a child process and its descendants (`taskkill /T /F` on Windows).
     */
    private static killTree(child: ChildProcess): void {
        if (child.exitCode !== null || child.pid === undefined) {
            return;
        }
        if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on(
                "error",
                () => child.kill()
            );
        } else {
            child.kill("SIGTERM");
        }
    }
}
