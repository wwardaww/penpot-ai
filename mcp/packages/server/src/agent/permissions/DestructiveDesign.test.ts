import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PathGuard } from "../workspace/pathGuard";
import { DestructiveDesign } from "./DestructiveDesign";
import type { PermissionAnswer, PermissionAsker, PermissionPrompt } from "./PermissionBroker";
import { ToolPermissionPolicy } from "./ToolPermissionPolicy";

const signal = new AbortController().signal;
let root: string;

before(() => {
    root = mkdtempSync(join(tmpdir(), "penforge-destructive-"));
});

after(() => {
    rmSync(root, { recursive: true, force: true });
});

class RecordingAsker implements PermissionAsker {
    public readonly prompts: PermissionPrompt[] = [];

    constructor(private readonly answer: PermissionAnswer) {}

    public async ask(prompt: PermissionPrompt): Promise<PermissionAnswer> {
        this.prompts.push(prompt);
        return this.answer;
    }
}

const code = (value: string) => DestructiveDesign.check("execute_code", { code: value });

test("deleting pages is detected", () => {
    assert.equal(code("penpot.currentPage.remove();"), "pages");
    assert.equal(code("const page = penpot.currentFile.pages[1];\npage.remove()"), "pages");
    assert.equal(code("pages[0]?.remove()"), "pages");
    assert.equal(code("penpot.removePage(p)"), "pages");
});

test("deleting library items, tokens and comments is detected", () => {
    const single = "library items, tokens or comments";
    const bulk = "items of pages, the library or comments";
    assert.equal(code("penpot.library.local.components[0].remove()"), single);
    assert.equal(code("const set = catalog.sets[0]; set.remove();"), single);
    assert.equal(code("thread.remove()"), single);
    assert.equal(code("for (const c of penpot.library.local.colors) { c.remove(); }"), bulk);
    assert.equal(code("penpot.library.local.typographies.forEach((t) => t.remove())"), bulk);
    assert.equal(code("for (const p of penpot.currentFile.pages) { p.remove(); }"), bulk);
});

test("ordinary design edits are not flagged", () => {
    assert.equal(code("penpot.currentPage.getShapeById('a').remove()"), null);
    assert.equal(code("const shape = penpot.selection[0]; shape.remove();"), null);
    assert.equal(code("board.flex?.remove(); board.grid?.remove();"), null);
    assert.equal(code("return penpot.library.local.components.map((c) => c.name)"), null);
    assert.equal(code("// pages.forEach((p) => p.remove())\nreturn 1"), null);
    assert.equal(code("/* page.remove() */ return 'http://x'"), null);
});

test("only execute_code with code is checked", () => {
    assert.equal(DestructiveDesign.check("get_node_properties", { code: "page.remove()" }), null);
    assert.equal(DestructiveDesign.check("execute_code", {}), null);
});

test("the policy asks before Claude deletes pages and keeps the session id", async () => {
    const asker = new RecordingAsker({ allow: true, remember: false });
    const policy = new ToolPermissionPolicy(new PathGuard(root), asker, () => "tab-1");
    const decision = await policy.decide({
        toolName: "mcp__penpot__execute_code",
        input: { code: "penpot.currentPage.remove()" },
        signal,
    });
    assert.deepEqual(decision, {
        allow: true,
        updatedInput: { code: "penpot.currentPage.remove()", sessionId: "tab-1" },
    });
    assert.equal(asker.prompts.length, 1);
    assert.equal(asker.prompts[0].risk, "high");
    assert.match(asker.prompts[0].description, /delete pages/);
});

test("a refused deletion is denied", async () => {
    const asker = new RecordingAsker({ allow: false, remember: false });
    const policy = new ToolPermissionPolicy(new PathGuard(root), asker, () => "tab-1");
    const decision = await policy.decide({
        toolName: "mcp__penpot__execute_code",
        input: { code: "penpot.library.local.components[0].remove()" },
        signal,
    });
    assert.equal(decision.allow, false);
});

test("a remembered answer covers later deletions of the same kind only", async () => {
    const asker = new RecordingAsker({ allow: true, remember: true });
    const policy = new ToolPermissionPolicy(new PathGuard(root), asker, () => "tab-1");
    const pages = { toolName: "mcp__penpot__execute_code", input: { code: "page.remove()" }, signal };
    await policy.decide(pages);
    await policy.decide(pages);
    await policy.decide({ toolName: "mcp__penpot__execute_code", input: { code: "thread.remove()" }, signal });
    assert.equal(asker.prompts.length, 2);
});

test("ordinary Penpot tool uses are not put to the user", async () => {
    const asker = new RecordingAsker({ allow: false, remember: false });
    const policy = new ToolPermissionPolicy(new PathGuard(root), asker, () => "tab-1");
    const decision = await policy.decide({
        toolName: "mcp__penpot__execute_code",
        input: { code: "penpot.selection[0].remove()" },
        signal,
    });
    assert.equal(decision.allow, true);
    assert.equal(asker.prompts.length, 0);
});
