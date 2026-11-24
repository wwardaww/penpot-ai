import assert from "node:assert/strict";
import { test } from "node:test";
import { CliProcessRunner } from "./CliProcessRunner";
import { LocalCliRunner } from "./LocalCliRunner";

/** The arguments the runner would pass to `claude -p`. */
function argsFor(allowed?: readonly string[]): string[] {
    const runner = new CliProcessRunner({ mcpUrl: "http://127.0.0.1:4401/mcp" });
    return (runner as any).args(
        { id: "c1" },
        {
            cwd: ".",
            systemPromptAppend: "",
            permissions: { decide: async () => ({ allow: true }) },
            allowedTools: allowed,
        }
    );
}

/** The `--allowedTools` value the runner would pass to `claude -p`. */
function allowedTools(allowed?: readonly string[]): string {
    const args = argsFor(allowed);
    return args[args.indexOf("--allowedTools") + 1];
}

test("a later turn of a session sends its own system prompt, not the recorded one", () => {
    const args = argsFor();
    assert.equal(args[args.indexOf("--system-prompt-snapshot") + 1], "off");
    const sdk = new LocalCliRunner({ mcpUrl: "http://127.0.0.1:4401/mcp" });
    const options = (sdk as any).options(
        { id: "c1", resumeSessionId: "s1" },
        { cwd: ".", systemPromptAppend: "tab", permissions: { decide: async () => ({ allow: true }) } },
        new AbortController()
    );
    assert.deepEqual(options.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: "tab",
        snapshot: false,
    });
});

test("a turn without a tool list keeps the default approvals", () => {
    assert.match(allowedTools(), /^mcp__penpot,Read,/);
});

test("a workflow's tool list replaces the default approvals", () => {
    assert.equal(
        allowedTools(["Read", "Edit(app-src/**)", "mcp__penpot__list_boards"]),
        "Read,Edit(app-src/**),mcp__penpot__list_boards"
    );
});
