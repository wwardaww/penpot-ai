import { randomUUID } from "crypto";
import { readFileSync } from "fs";
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

/** One recorded turn of a {@link ReplayScript}. */
export interface RecordedTurn {
    /** regular expression the user text must match; the turn matches any text when omitted */
    match?: string;
    /** events replayed in order; `messageId` of `text` and `done` events is replaced by the turn's id */
    events: RunnerEvent[];
    /** pause before each event, in milliseconds (default 0) */
    delayMs?: number;
}

/** File format of a recording (`PENFORGE_FAKE_RECORDING`). */
export interface Recording {
    turns: RecordedTurn[];
}

/**
 * Script replaying recorded runner events (`PENFORGE_RUNNER=fake` with `PENFORGE_FAKE_RECORDING`).
 *
 * Each turn plays the first recorded turn whose `match` fits the user text; when none does, the
 * echo script answers, so a partial recording still yields a complete turn. End-to-end tests drive
 * the daemon and the frontend with it, without Claude.
 */
export class ReplayScript implements FakeRunnerScript {
    private static readonly KINDS = new Set(["session", "text", "tool", "done", "error"]);
    private readonly turns: { pattern: RegExp; turn: RecordedTurn }[];
    private readonly fallback = new EchoScript();

    /**
     * @param recording - the recorded turns
     * @param sleep - pause function (tests replace it)
     * @throws Error when the recording is malformed
     */
    constructor(
        recording: Recording,
        private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
    ) {
        if (!recording || !Array.isArray(recording.turns)) {
            throw new Error("A fake runner recording needs a `turns` list");
        }
        this.turns = recording.turns.map((turn, index) => {
            if (!Array.isArray(turn.events) || !turn.events.every((e) => ReplayScript.KINDS.has(e?.kind))) {
                throw new Error(`Recorded turn ${index} has an invalid event list`);
            }
            return { pattern: new RegExp(turn.match ?? ""), turn };
        });
    }

    /**
     * Loads a recording file.
     *
     * @param path - the JSON file
     */
    public static fromFile(path: string): ReplayScript {
        return new ReplayScript(JSON.parse(readFileSync(path, "utf8")) as Recording);
    }

    public async *play(
        conversation: RunnerConversation,
        input: RunnerInput,
        opts: RunnerOptions,
        messageId: string
    ): AsyncIterable<RunnerEvent> {
        const found = this.turns.find(({ pattern }) => pattern.test(input.text));
        if (!found) {
            yield* this.fallback.play(conversation, input, opts, messageId);
            return;
        }
        for (const event of found.turn.events) {
            if (found.turn.delayMs) {
                await this.sleep(found.turn.delayMs);
            }
            yield event.kind === "text" || event.kind === "done" ? { ...event, messageId } : event;
        }
    }
}
