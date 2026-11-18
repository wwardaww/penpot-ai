import { randomUUID } from "crypto";
import type { ClaudeRunner, RunnerConversation, RunnerEvent, RunnerInput, RunnerOptions } from "./ClaudeRunner";

/**
 * Script of a {@link FakeRunner}: produces the events of one turn.
 */
export interface FakeRunnerScript {
    play(
        conversation: RunnerConversation,
        input: RunnerInput,
        opts: RunnerOptions,
        messageId: string
    ): AsyncIterable<RunnerEvent>;
}

/**
 * Default script: echoes the input in two chunks.
 *
 * A text starting with `/tool` reports a Penpot tool call (`/fail-tool` a failed one); `/permission` first asks for permission
 * to run a shell command and reports the decision. Useful to develop the frontend without Claude.
 */
export class EchoScript implements FakeRunnerScript {
    public async *play(
        conversation: RunnerConversation,
        input: RunnerInput,
        opts: RunnerOptions,
        messageId: string
    ): AsyncIterable<RunnerEvent> {
        yield { kind: "session", sessionId: conversation.resumeSessionId ?? `fake-${conversation.id}` };
        if (input.text.startsWith("/tool")) {
            yield { kind: "tool", toolUseId: "t1", toolName: "mcp__penpot__execute_code", status: "running" };
            yield { kind: "tool", toolUseId: "t1", toolName: "mcp__penpot__execute_code", status: "done" };
        }
        if (input.text.startsWith("/fail-tool")) {
            yield { kind: "tool", toolUseId: "t1", toolName: "mcp__penpot__execute_code", status: "running" };
            yield {
                kind: "tool",
                toolUseId: "t1",
                toolName: "mcp__penpot__execute_code",
                status: "error",
                detail: "Tool execution failed: Error: boom",
            };
        }
        let reply = `You said: ${input.text}`;
        if (input.text.startsWith("/permission")) {
            const decision = await opts.permissions.decide({
                toolName: "Bash",
                input: { command: "echo penforge" },
                signal: opts.signal ?? new AbortController().signal,
            });
            reply = decision.allow ? "Permission granted" : "Permission denied";
        }
        const middle = Math.ceil(reply.length / 2);
        yield { kind: "text", messageId, text: reply.slice(0, middle) };
        yield { kind: "text", messageId, text: reply.slice(middle) };
        yield { kind: "done", messageId, text: reply, usage: { inputTokens: 1, outputTokens: 1 } };
    }
}

/**
 * Runner replaying a script instead of calling Claude (tests, frontend development).
 */
export class FakeRunner implements ClaudeRunner {
    public readonly kind = "fake";
    /** inputs received, oldest first */
    public readonly received: { conversation: RunnerConversation; input: RunnerInput; opts: RunnerOptions }[] = [];
    private readonly cancelled = new Set<string>();

    constructor(private readonly script: FakeRunnerScript = new EchoScript()) {}

    public async *send(
        conversation: RunnerConversation,
        input: RunnerInput,
        opts: RunnerOptions
    ): AsyncIterable<RunnerEvent> {
        this.received.push({ conversation, input, opts });
        this.cancelled.delete(conversation.id);
        for await (const event of this.script.play(conversation, input, opts, randomUUID())) {
            if (this.cancelled.has(conversation.id) || opts.signal?.aborted) {
                yield { kind: "error", message: "cancelled" };
                return;
            }
            yield event;
        }
    }

    public cancel(conversationId?: string): void {
        for (const entry of this.received) {
            if (conversationId === undefined || entry.conversation.id === conversationId) {
                this.cancelled.add(entry.conversation.id);
            }
        }
    }
}
