import { randomUUID } from "crypto";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logger";
import type {
    ClaudeRunner,
    RunnerConversation,
    RunnerEvent,
    RunnerInput,
    RunnerOptions,
    ToolPermissionHandler,
} from "./ClaudeRunner";
import { ClaudeEnvironment } from "./ClaudeEnvironment";
import { SdkMessageMapper } from "./SdkMessageMapper";

/** Settings of the local Claude Code runners. */
export interface LocalRunnerSettings {
    /** URL of the Penpot MCP endpoint Claude connects to */
    mcpUrl: string;
    /** path of the `claude` executable; the SDK's bundled one when omitted */
    claudePath?: string;
    /** Claude model override */
    model?: string;
}

/** Name under which the Penpot MCP server is given to Claude; its tools are `mcp__penpot__<tool>`. */
export const PENPOT_MCP_SERVER_NAME = "penpot";

/**
 * Runner driving the user's local Claude Code login through the Claude Agent SDK.
 *
 * Each turn is a `query()` in streaming input mode, so that images can be sent and tool permissions
 * are decided by the {@link ToolPermissionHandler} of the turn. Claude's working directory is the
 * project folder; its only MCP server is the Penpot MCP endpoint of this daemon. User-level Claude
 * Code settings are not loaded, so that the user's own allow rules and hooks do not bypass the
 * daemon's permission policy.
 */
export class LocalCliRunner implements ClaudeRunner {
    public readonly kind = "local-cli";
    private readonly logger = createLogger("LocalCliRunner");
    private readonly running = new Map<string, AbortController>();

    constructor(private readonly settings: LocalRunnerSettings) {}

    public async *send(
        conversation: RunnerConversation,
        input: RunnerInput,
        opts: RunnerOptions
    ): AsyncIterable<RunnerEvent> {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        const abort = this.register(conversation.id, opts.signal);
        const mapper = new SdkMessageMapper(randomUUID(), true);
        let resultSeen!: () => void;
        const resultReceived = new Promise<void>((resolve) => (resultSeen = resolve));
        abort.signal.addEventListener("abort", () => resultSeen(), { once: true });

        const stream = query({
            prompt: LocalCliRunner.userMessages(input, resultReceived),
            options: this.options(conversation, opts, abort),
        });
        try {
            for await (const message of stream) {
                if (message.type === "system" && message.subtype === "init") {
                    this.logger.info(
                        "Claude session %s started; MCP servers: %s",
                        message.session_id,
                        message.mcp_servers.map((server) => `${server.name}=${server.status}`).join(", ")
                    );
                }
                for (const event of mapper.map(message)) {
                    yield event;
                }
                if (mapper.isFinished) {
                    break;
                }
            }
        } catch (error) {
            if (!mapper.isFinished) {
                yield mapper.interrupted(abort.signal.aborted ? "cancelled" : LocalCliRunner.describe(error));
            }
        } finally {
            resultSeen();
            this.unregister(conversation.id, abort);
            stream.close();
        }
        if (!mapper.isFinished) {
            yield mapper.interrupted(abort.signal.aborted ? "cancelled" : "Claude stopped without a result");
        }
    }

    public cancel(conversationId?: string): void {
        for (const [id, abort] of this.running) {
            if (conversationId === undefined || id === conversationId) {
                abort.abort();
            }
        }
    }

    private options(conversation: RunnerConversation, opts: RunnerOptions, abort: AbortController): Options {
        const permissions = opts.permissions;
        return {
            cwd: opts.cwd,
            env: ClaudeEnvironment.forChild(),
            model: this.settings.model,
            pathToClaudeCodeExecutable: this.settings.claudePath,
            abortController: abort,
            includePartialMessages: true,
            resume: conversation.resumeSessionId,
            settingSources: ["project"],
            permissionMode: "default",
            mcpServers: {
                [PENPOT_MCP_SERVER_NAME]: { type: "http", url: this.settings.mcpUrl },
            },
            systemPrompt: { type: "preset", preset: "claude_code", append: opts.systemPromptAppend },
            canUseTool: async (toolName, toolInput, { signal }) => {
                const decision = await permissions.decide({ toolName, input: toolInput, signal });
                return decision.allow
                    ? { behavior: "allow", updatedInput: decision.updatedInput ?? toolInput }
                    : { behavior: "deny", message: decision.message };
            },
            stderr: (data) => this.logger.debug("claude stderr: %s", data.trimEnd()),
        };
    }

    /**
     * Streams the user's message, then keeps the input open until the turn's result arrives, so
     * that permission requests can still be answered.
     */
    private static async *userMessages(input: RunnerInput, done: Promise<void>): AsyncIterable<SDKUserMessage> {
        const content: any[] = [{ type: "text", text: input.text }];
        for (const image of input.images ?? []) {
            content.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } });
        }
        yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null } as SDKUserMessage;
        await done;
    }

    private register(conversationId: string, signal: AbortSignal | undefined): AbortController {
        const abort = new AbortController();
        if (signal) {
            if (signal.aborted) {
                abort.abort();
            } else {
                signal.addEventListener("abort", () => abort.abort(), { once: true });
            }
        }
        this.running.set(conversationId, abort);
        return abort;
    }

    private unregister(conversationId: string, abort: AbortController): void {
        if (this.running.get(conversationId) === abort) {
            this.running.delete(conversationId);
        }
    }

    private static describe(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
