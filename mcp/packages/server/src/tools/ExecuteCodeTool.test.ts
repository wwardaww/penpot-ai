import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecuteCodeTool } from "./ExecuteCodeTool";

test("a short call gets no note", () => {
    assert.equal(ExecuteCodeTool.slowCallNote(ExecuteCodeTool.SLOW_CALL_MS - 1), null);
});

test("a slow call tells the AI how long the tab was frozen and to split the work", () => {
    const note = ExecuteCodeTool.slowCallNote(68_500);
    assert.match(note!, /frozen for 69 s/);
    assert.match(note!, /at most one screen per call/);
});
