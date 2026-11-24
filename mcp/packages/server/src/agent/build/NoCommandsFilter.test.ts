import assert from "node:assert/strict";
import { test } from "node:test";
import { NoCommandsFilter } from "./NoCommandsFilter";

test("build turns may not run commands, and get the reason at once", () => {
    const filter = new NoCommandsFilter();
    for (const tool of ["Bash", "PowerShell", "BashOutput", "KillShell"]) {
        assert.match(filter.check(tool) ?? "", /Do not run commands/, tool);
    }
    for (const tool of ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "mcp__penpot__get_node_properties"]) {
        assert.equal(filter.check(tool), null, tool);
    }
});
