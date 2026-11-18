import assert from "node:assert/strict";
import { test } from "node:test";
import { CliProcessRunner } from "./CliProcessRunner";

/** The `--allowedTools` value the runner would pass to `claude -p`. */
function allowedTools(allowed?: readonly string[]): string {
    const runner = new CliProcessRunner({ mcpUrl: "http://127.0.0.1:4401/mcp" });
    const args: string[] = (runner as any).args(
        { id: "c1" },
        {
            cwd: ".",
            systemPromptAppend: "",
            permissions: { decide: async () => ({ allow: true }) },
            allowedTools: allowed,
        }
    );
    return args[args.indexOf("--allowedTools") + 1];
}

test("a turn without a tool list keeps the default approvals", () => {
    assert.match(allowedTools(), /^mcp__penpot,Read,/);
});

test("a workflow's tool list replaces the default approvals", () => {
    assert.equal(
        allowedTools(["Read", "Edit(app-src/**)", "mcp__penpot__list_boards"]),
        "Read,Edit(app-src/**),mcp__penpot__list_boards"
    );
});
