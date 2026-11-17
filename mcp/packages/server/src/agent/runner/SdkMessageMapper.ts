import type { RunnerEvent } from "./ClaudeRunner";

/** Loosely typed Claude Code stream message (SDK `SDKMessage` or CLI `stream-json` line). */
type StreamMessage = Record<string, any>;

/**
 * Mapper from Claude Code stream messages to runner events, for one turn.
 *
 * Works on both the Agent SDK's `SDKMessage` objects and the CLI's `stream-json` lines, which share
 * one format. With partial messages enabled, text is streamed from `stream_event` deltas; otherwise
 * it is taken from whole assistant messages. Separate text blocks of a turn are joined with a blank
 * line, so that the client sees one message per turn.
 */
export class SdkMessageMapper {
    private readonly toolNames = new Map<string, string>();
    private text = "";
    private blockSeparatorPending = false;
    private finished = false;

    /**
     * @param messageId - id of the turn's assistant message, used for all its text events
     * @param partialMessages - whether `stream_event` partial messages are enabled
     */
    constructor(
        public readonly messageId: string,
        private readonly partialMessages: boolean
    ) {}

    /** Whether a `done` or `error` event was produced. */
    public get isFinished(): boolean {
        return this.finished;
    }

    /**
     * Maps one stream message to runner events.
     *
     * @param message - the stream message
     */
    public map(message: StreamMessage): RunnerEvent[] {
        switch (message?.type) {
            case "system":
                return message.subtype === "init" && typeof message.session_id === "string"
                    ? [{ kind: "session", sessionId: message.session_id }]
                    : [];
            case "stream_event":
                // partial messages of subagents are not shown to the user
                return message.parent_tool_use_id ? [] : this.mapStreamEvent(message.event);
            case "assistant":
                return this.mapAssistant(message);
            case "user":
                return this.mapToolResults(message);
            case "result":
                return this.mapResult(message);
            default:
                return [];
        }
    }

    /**
     * Builds the event that ends a turn that stopped without a result message.
     *
     * @param reason - why the turn stopped
     */
    public interrupted(reason: string): RunnerEvent {
        this.finished = true;
        return { kind: "error", message: reason };
    }

    private mapStreamEvent(event: StreamMessage | undefined): RunnerEvent[] {
        if (!this.partialMessages || !event) {
            return [];
        }
        if (event.type === "content_block_start" && event.content_block?.type === "text") {
            this.blockSeparatorPending = this.text.length > 0;
            return [];
        }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            return this.textEvent(event.delta.text ?? "");
        }
        return [];
    }

    private mapAssistant(message: StreamMessage): RunnerEvent[] {
        if (message.parent_tool_use_id) {
            // messages of subagents are not part of the conversation shown to the user
            return [];
        }
        const events: RunnerEvent[] = [];
        const content: StreamMessage[] = Array.isArray(message.message?.content) ? message.message.content : [];
        for (const block of content) {
            if (block.type === "text" && !this.partialMessages) {
                this.blockSeparatorPending = this.text.length > 0;
                events.push(...this.textEvent(block.text ?? ""));
            } else if (block.type === "tool_use") {
                this.toolNames.set(block.id, block.name);
                events.push({
                    kind: "tool",
                    toolUseId: block.id,
                    toolName: block.name,
                    status: "running",
                    input: block.input,
                });
            }
        }
        return events;
    }

    private mapToolResults(message: StreamMessage): RunnerEvent[] {
        const content = message.message?.content;
        if (!Array.isArray(content)) {
            return [];
        }
        const events: RunnerEvent[] = [];
        for (const block of content as StreamMessage[]) {
            if (block.type !== "tool_result") {
                continue;
            }
            const toolName = this.toolNames.get(block.tool_use_id);
            if (!toolName) {
                continue;
            }
            const isError = block.is_error === true;
            events.push({
                kind: "tool",
                toolUseId: block.tool_use_id,
                toolName,
                status: isError ? "error" : "done",
                detail: isError ? SdkMessageMapper.resultText(block.content) : undefined,
            });
        }
        return events;
    }

    private mapResult(message: StreamMessage): RunnerEvent[] {
        this.finished = true;
        if (message.subtype === "success" && message.is_error !== true) {
            // fall back to the result text if no text was seen (e.g. partial messages lost)
            if (this.text.length === 0 && typeof message.result === "string") {
                this.text = message.result;
            }
            return [
                {
                    kind: "done",
                    messageId: this.messageId,
                    text: this.text,
                    usage: {
                        inputTokens: message.usage?.input_tokens,
                        outputTokens: message.usage?.output_tokens,
                        costUsd: message.total_cost_usd,
                    },
                },
            ];
        }
        const errors: string[] = Array.isArray(message.errors) ? message.errors : [];
        const reason =
            errors.join("; ") ||
            (typeof message.result === "string" && message.result) ||
            message.startup_failure_reason ||
            message.subtype ||
            "Claude stopped with an error";
        return [{ kind: "error", message: String(reason) }];
    }

    private textEvent(text: string): RunnerEvent[] {
        if (text.length === 0) {
            return [];
        }
        const chunk = this.blockSeparatorPending ? `\n\n${text}` : text;
        this.blockSeparatorPending = false;
        this.text += chunk;
        return [{ kind: "text", messageId: this.messageId, text: chunk }];
    }

    private static resultText(content: unknown): string {
        if (typeof content === "string") {
            return content;
        }
        if (Array.isArray(content)) {
            return content
                .filter((part) => part?.type === "text")
                .map((part) => part.text)
                .join("\n");
        }
        return "";
    }
}
