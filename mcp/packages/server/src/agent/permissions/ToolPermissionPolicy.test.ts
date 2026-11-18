import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PathGuard } from "../workspace/pathGuard";
import type { PermissionAnswer, PermissionAsker, PermissionPrompt } from "./PermissionBroker";
import { PermissionBroker } from "./PermissionBroker";
import { ToolPermissionPolicy } from "./ToolPermissionPolicy";

/** Asker answering every question the same way and recording the prompts. */
class RecordingAsker implements PermissionAsker {
    public readonly prompts: PermissionPrompt[] = [];

    constructor(private readonly answer: PermissionAnswer) {}

    public async ask(prompt: PermissionPrompt): Promise<PermissionAnswer> {
        this.prompts.push(prompt);
        return this.answer;
    }
}

let base: string;
let root: string;

before(() => {
    base = mkdtempSync(join(tmpdir(), "penforge-policy-"));
    root = join(base, "project");
    mkdirSync(root, { recursive: true });
});

after(() => {
    rmSync(base, { recursive: true, force: true });
});

const signal = new AbortController().signal;

test("allows Penpot tools and adds the tab's MCP session id", async () => {
    const policy = new ToolPermissionPolicy(
        new PathGuard(root),
        new RecordingAsker({ allow: false, remember: false }),
        () => "tab-1"
    );
    const decision = await policy.decide({ toolName: "mcp__penpot__execute_code", input: { code: "1" }, signal });
    assert.deepEqual(decision, { allow: true, updatedInput: { code: "1", sessionId: "tab-1" } });
});

test("keeps a session id Claude chose itself", async () => {
    const policy = new ToolPermissionPolicy(
        new PathGuard(root),
        new RecordingAsker({ allow: false, remember: false }),
        () => "tab-1"
    );
    const decision = await policy.decide({
        toolName: "mcp__penpot__execute_code",
        input: { sessionId: "other" },
        signal,
    });
    assert.deepEqual(decision, { allow: true, updatedInput: { sessionId: "other" } });
});

test("allows writing inside the project without asking", async () => {
    const asker = new RecordingAsker({ allow: false, remember: false });
    const policy = new ToolPermissionPolicy(new PathGuard(root), asker, () => undefined);
    const decision = await policy.decide({
        toolName: "Write",
        input: { file_path: join(root, "app-src", "a.ts") },
        signal,
    });
    assert.equal(decision.allow, true);
    assert.equal(asker.prompts.length, 0);
});

test("asks before writing outside the project and denies on refusal", async () => {
    const asker = new RecordingAsker({ allow: false, remember: false });
    const policy = new ToolPermissionPolicy(new PathGuard(root), asker, () => undefined);
    const decision = await policy.decide({ toolName: "Edit", input: { file_path: join(base, "other.txt") }, signal });
    assert.equal(decision.allow, false);
    assert.equal(asker.prompts[0]?.risk, "high");
});

test("never lets Claude read the daemon's token store, not even with permission", async () => {
    const asker = new RecordingAsker({ allow: true, remember: true });
    const policy = new ToolPermissionPolicy(new PathGuard(root), asker, () => undefined);
    for (const decision of [
        await policy.decide({ toolName: "Read", input: { file_path: join(base, "secrets.json") }, signal }),
        await policy.decide({ toolName: "Edit", input: { file_path: join(base, "Secrets.JSON") }, signal }),
        await policy.decide({ toolName: "Bash", input: { command: "cat ~/Penforge/secrets.json" }, signal }),
    ]) {
        assert.equal(decision.allow, false);
    }
    assert.equal(asker.prompts.length, 0, "the user is not even asked");
});

test("refuses the Penforge home outside the project without asking", async () => {
    const home = join(base, "penforge-home");
    const project = join(home, "projects", "p1");
    mkdirSync(project, { recursive: true });
    const asker = new RecordingAsker({ allow: true, remember: true });
    const policy = new ToolPermissionPolicy(new PathGuard(project), asker, () => undefined, {
        projectRoot: project,
        penforgeHome: home,
    });
    const denied = [
        { toolName: "Read", input: { file_path: join(home, "config.json") } },
        { toolName: "Read", input: { file_path: join(home, "secrets.json.0a1b2c3d4e5f.tmp") } },
        { toolName: "Grep", input: { pattern: "token", path: join(home, "projects", "other") } },
        { toolName: "Read", input: { file_path: "../../secrets.json" } },
        { toolName: "Bash", input: { command: `type ${join(home, "config.json")}` } },
        { toolName: "Bash", input: { command: "cat ~/Penforge/secret*.json" } },
        { toolName: "PowerShell", input: { command: "Get-Content $env:USERPROFILE\\Penforge\\config.json" } },
    ];
    for (const use of denied) {
        const decision = await policy.decide({ ...use, signal });
        assert.equal(decision.allow, false, JSON.stringify(use));
    }
    assert.equal(asker.prompts.length, 0, "the user is not even asked");
    // files of the project itself stay allowed
    const inside = await policy.decide({ toolName: "Read", input: { file_path: join(project, "a.txt") }, signal });
    assert.equal(inside.allow, true);
});

test("a remembered approval never covers paths outside the project", async () => {
    const asker = new RecordingAsker({ allow: true, remember: true });
    const policy = new ToolPermissionPolicy(new PathGuard(root), asker, () => undefined);
    await policy.decide({ toolName: "Bash", input: { command: "cat /etc/hosts" }, signal });
    await policy.decide({ toolName: "Bash", input: { command: "cat ~/notes.txt" }, signal });
    await policy.decide({ toolName: "Read", input: { file_path: join(base, "other.txt") }, signal });
    await policy.decide({ toolName: "Read", input: { file_path: join(base, "other.txt") }, signal });
    assert.equal(asker.prompts.length, 4, "asked every time");
});

test("asks before running a command and remembers the answer for the same program", async () => {
    const asker = new RecordingAsker({ allow: true, remember: true });
    const policy = new ToolPermissionPolicy(new PathGuard(root), asker, () => undefined);
    await policy.decide({ toolName: "Bash", input: { command: "npm install" }, signal });
    const again = await policy.decide({ toolName: "Bash", input: { command: "npm run build" }, signal });
    await policy.decide({ toolName: "Bash", input: { command: "git status" }, signal });
    assert.equal(again.allow, true);
    assert.equal(asker.prompts.length, 2);
});

test("the broker counts an aborted question as denied", async () => {
    const sent: unknown[] = [];
    const broker = new PermissionBroker((message) => sent.push(message));
    const abort = new AbortController();
    const answer = broker.ask({ title: "t", description: "d", risk: "low" }, abort.signal);
    abort.abort();
    assert.deepEqual(await answer, { allow: false, remember: false });
    assert.equal(sent.length, 1);
});

test("the broker matches a response to its request", async () => {
    const sent: { requestId: string }[] = [];
    const broker = new PermissionBroker((message) => sent.push(message));
    const answer = broker.ask({ title: "t", description: "d", risk: "low" }, signal);
    assert.equal(broker.respond(sent[0].requestId, true, true), true);
    assert.deepEqual(await answer, { allow: true, remember: true });
    assert.equal(broker.respond(sent[0].requestId, true, true), false);
});
