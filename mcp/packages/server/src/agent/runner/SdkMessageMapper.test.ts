import assert from "node:assert/strict";
import { test } from "node:test";
import { SdkMessageMapper } from "./SdkMessageMapper";

function textDelta(text: string) {
    return {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    };
}

const textBlockStart = {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
};

test("maps the init message to a session event", () => {
    const mapper = new SdkMessageMapper("m1", true);
    assert.deepEqual(mapper.map({ type: "system", subtype: "init", session_id: "s1" }), [
        { kind: "session", sessionId: "s1" },
    ]);
});

test("streams text deltas and ignores the text of the whole assistant message", () => {
    const mapper = new SdkMessageMapper("m1", true);
    const events = [
        ...mapper.map(textBlockStart),
        ...mapper.map(textDelta("Hel")),
        ...mapper.map(textDelta("lo")),
        ...mapper.map({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
    ];
    assert.deepEqual(events, [
        { kind: "text", messageId: "m1", text: "Hel" },
        { kind: "text", messageId: "m1", text: "lo" },
    ]);
});

test("separates text blocks of one turn with a blank line", () => {
    const mapper = new SdkMessageMapper("m1", true);
    mapper.map(textBlockStart);
    mapper.map(textDelta("First."));
    mapper.map(textBlockStart);
    const events = mapper.map(textDelta("Second."));
    assert.deepEqual(events, [{ kind: "text", messageId: "m1", text: "\n\nSecond." }]);
});

test("reports tool calls and their results", () => {
    const mapper = new SdkMessageMapper("m1", true);
    const running = mapper.map({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "mcp__penpot__execute_code", input: { code: "1" } }] },
    });
    const failed = mapper.map({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] },
    });
    assert.deepEqual(running, [
        {
            kind: "tool",
            toolUseId: "t1",
            toolName: "mcp__penpot__execute_code",
            status: "running",
            input: { code: "1" },
        },
    ]);
    assert.deepEqual(failed, [
        { kind: "tool", toolUseId: "t1", toolName: "mcp__penpot__execute_code", status: "error", detail: "boom" },
    ]);
});

test("ignores messages of subagents", () => {
    const mapper = new SdkMessageMapper("m1", true);
    const events = mapper.map({ ...textDelta("hidden"), parent_tool_use_id: "t9" });
    assert.deepEqual(events, []);
});

test("ends the turn with done, usage and the full text", () => {
    const mapper = new SdkMessageMapper("m1", true);
    mapper.map(textDelta("Hi"));
    const events = mapper.map({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hi",
        usage: { input_tokens: 10, output_tokens: 2 },
        total_cost_usd: 0.01,
    });
    assert.deepEqual(events, [
        { kind: "done", messageId: "m1", text: "Hi", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 } },
    ]);
    assert.equal(mapper.isFinished, true);
});

test("takes text from whole assistant messages when partial messages are off", () => {
    const mapper = new SdkMessageMapper("m1", false);
    const events = mapper.map({ type: "assistant", message: { content: [{ type: "text", text: "Whole" }] } });
    assert.deepEqual(events, [{ kind: "text", messageId: "m1", text: "Whole" }]);
});

test("maps an error result to an error event", () => {
    const mapper = new SdkMessageMapper("m1", true);
    const events = mapper.map({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["too many turns"],
    });
    assert.deepEqual(events, [{ kind: "error", message: "too many turns" }]);
});
