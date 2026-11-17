import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeEnvironment } from "./ClaudeEnvironment";

test("drops the variables of a surrounding Claude Code session", () => {
    const child = ClaudeEnvironment.forChild({
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDE_CODE_HOST_SESSION_ID: "h",
        CLAUDE_AGENT_SDK_VERSION: "1",
        PATH: "/bin",
    });
    assert.deepEqual(child, { PATH: "/bin" });
});

test("keeps the user's API settings in a plain shell", () => {
    const child = ClaudeEnvironment.forChild({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://proxy.test" });
    assert.deepEqual(child, { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://proxy.test" });
});

test("drops the desktop host's proxy URL together with its host login", () => {
    const child = ClaudeEnvironment.forChild({
        CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1234",
    });
    assert.deepEqual(child, {});
});
