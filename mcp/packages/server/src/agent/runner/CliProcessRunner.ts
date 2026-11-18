import { type ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { createLogger } from "../../logger";
import type { ClaudeRunner, RunnerConversation, RunnerEvent, RunnerInput, RunnerOptions } from "./ClaudeRunner";
import { RunnerInputContent } from "./ClaudeRunner";
import { type LocalRunnerSettings, PENPOT_MCP_SERVER_NAME } from "./LocalCliRunner";
import { ClaudeEnvironment } from "./ClaudeEnvironment";
import { SdkMessageMapper } from "./SdkMessageMapper";

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
    private readonly running = new Map<string, ChildProcess>();

    constructor(private readonly settings: LocalRunnerSettings) {}

    public async *send(
        conversation: RunnerConversation,
        input: RunnerInput,
        opts: RunnerOptions
    ): AsyncIterable<RunnerEvent> {
        const mapper = new SdkMessageMapper(randomUUID(), true);
        const child = spawn(this.settings.claudePath ?? "claude", this.args(conversation, opts), {
            cwd: opts.cwd,
            env: ClaudeEnvironment.forChild() as NodeJS.ProcessEnv,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        this.running.set(conversation.id, child);
        const onAbort = () => CliProcessRunner.killTree(child);
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        let spawnError: Error | undefined;
        child.on("error", (error) => (spawnError = error));
        child.stderr!.on("data", (data) => this.logger.debug("claude stderr: %s", String(data).trimEnd()));
        child.stdin!.on("error", () => {});
        child.stdin!.write(JSON.stringify(CliProcessRunner.userMessage(input)) + "\n");

        try {
            for await (const line of createInterface({ input: child.stdout! })) {
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
            child.stdin!.end();
            if (this.running.get(conversation.id) === child) {
                this.running.delete(conversation.id);
            }
            if (child.exitCode === null) {
                CliProcessRunner.killTree(child);
            }
        }
        if (!mapper.isFinished) {
            const reason = opts.signal?.aborted
                ? "cancelled"
                : spawnError
                  ? `Could not start claude: ${spawnError.message}`
                  : "Claude stopped without a result";
            yield mapper.interrupted(reason);
        }
    }

    public cancel(conversationId?: string): void {
        for (const [id, child] of this.running) {
            if (conversationId === undefined || id === conversationId) {
                CliProcessRunner.killTree(child);
            }
        }
    }

    private args(conversation: RunnerConversation, opts: RunnerOptions): string[] {
        const mcpConfig = { mcpServers: { [PENPOT_MCP_SERVER_NAME]: { type: "http", url: this.settings.mcpUrl } } };
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
        ];
        if (conversation.resumeSessionId) {
            args.push("--resume", conversation.resumeSessionId);
        }
        if (this.settings.model) {
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
