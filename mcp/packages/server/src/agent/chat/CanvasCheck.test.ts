import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { AgentContext, DaemonMessage, WorkflowToolResult, WorkflowToolsApi } from "@penpot/mcp-common";
import type { AgentClient } from "../AgentClient";
import { PromptRegistry } from "../prompts/promptRegistry";
import { FakeRunner } from "../runner/FakeRunner";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { type BoardBox, CanvasCheck } from "./CanvasCheck";
import { ChatService } from "./ChatService";
import { TurnRunner } from "./TurnRunner";

const IPHONE: BoardBox = { id: "ios", name: "iPhone", pageId: "p1", x: 0, y: 0, width: 390, height: 844 };
const SEEDED: BoardBox = { id: "seeded", name: "Android", pageId: "p1", x: 490, y: 0, width: 412, height: 915 };
const CLONE: BoardBox = {
    id: "clone",
    name: "Android",
    pageId: "p1",
    x: 490.00003,
    y: 0,
    width: 412.00002,
    height: 915,
};

test("boards on top of each other are reported once they overlap", () => {
    const problems = CanvasCheck.problems([IPHONE, SEEDED], [IPHONE, CLONE, SEEDED]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, "boards-overlap");
    assert.deepEqual(problems[0].boardIds, ["clone", "seeded"]);
    assert.deepEqual(problems[0].params, { names: ["Android", "Android"] });
    assert.match(problems[0].text, /"Android" and "Android" overlap on the canvas/);
});

test("overlaps that were there before the turn are not reported again", () => {
    assert.deepEqual(CanvasCheck.problems([IPHONE, CLONE, SEEDED], [IPHONE, CLONE, SEEDED]), []);
});

test("touching boards, boards on other pages and rounding are no overlap", () => {
    const right: BoardBox = { ...SEEDED, id: "right", x: 390 };
    const otherPage: BoardBox = { ...IPHONE, id: "other", pageId: "p2" };
    const hairline: BoardBox = { ...SEEDED, id: "hair", x: 389.5 };
    assert.deepEqual(CanvasCheck.overlaps([IPHONE, right, otherPage]), []);
    assert.deepEqual(CanvasCheck.overlaps([IPHONE, hairline]), []);
});

test("only design-changing tools trigger the check", () => {
    assert.equal(CanvasCheck.changesDesign("mcp__penpot__execute_code"), true);
    assert.equal(CanvasCheck.changesDesign("mcp__penpot__update_design_node"), true);
    assert.equal(CanvasCheck.changesDesign("mcp__penpot__import_penpot_file"), true);
    assert.equal(CanvasCheck.changesDesign("mcp__penpot__list_boards"), false);
    assert.equal(CanvasCheck.changesDesign("Read"), false);
});

// --- in a chat turn

/** Penpot tools whose `list_boards` answers come from a queue. */
class QueuedBoards implements WorkflowToolsApi {
    public readonly calls: string[] = [];
    public readonly args: unknown[] = [];

    constructor(private readonly answers: (BoardBox[] | "fail")[]) {}

    public async call(toolName: string, args?: Record<string, unknown>): Promise<WorkflowToolResult> {
        this.calls.push(toolName);
        this.args.push(args);
        const answer = this.answers.shift() ?? [];
        if (answer === "fail") {
            return { isError: true, content: [], text: "Tool execution failed: Error: no session" };
        }
        const text = JSON.stringify(answer);
        return { isError: false, content: [{ type: "text", text }], text };
    }

    public async list(): Promise<string[]> {
        return ["list_boards"];
    }
}

const PROJECT_ID = "1c5a2b3d-4e6f-4a8b-9c0d-1e2f3a4b5c6d";
const CONTEXT: AgentContext = {
    fileId: "f",
    fileName: "File",
    projectId: PROJECT_ID,
    teamId: "t",
    pageId: "p1",
    persona: "designer",
    platform: "mobile",
};

let projectsDir: string;

beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-check-"));
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

async function chatTurn(text: string, tools: WorkflowToolsApi): Promise<DaemonMessage[]> {
    const workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    mkdirSync(join(workspace.metaDir, "chat"), { recursive: true });
    const sent: DaemonMessage[] = [];
    const client: AgentClient = {
        id: "c1",
        closed: new AbortController().signal,
        send: (message) => sent.push(message),
        setup: async () => ({
            context: CONTEXT,
            workspace,
            tools,
            permissions: { decide: async () => ({ allow: true }) },
        }),
    };
    const chat = new ChatService(new TurnRunner(new FakeRunner(), PromptRegistry.locate()));
    await chat.send(client, { type: "chat.send", rid: "r1", conversationId: "conv", text });
    return sent;
}

test("a turn that hides a board under another says so in the chat", async () => {
    const tools = new QueuedBoards([
        [IPHONE, SEEDED],
        [IPHONE, CLONE, SEEDED],
    ]);
    const sent = await chatTurn("/tool make an Android version", tools);

    const failed = sent.filter((message) => message.type === "chat.tool" && message.status === "error");
    assert.equal(failed.length, 1);
    assert.equal((failed[0] as { toolName: string }).toolName, ChatService.CANVAS_CHECK);
    assert.equal((failed[0] as { code?: string }).code, "boards-overlap");
    assert.deepEqual((failed[0] as { params?: unknown }).params, { names: ["Android", "Android"] });
    assert.deepEqual(tools.args, [{ pageId: "p1" }, { pageId: "p1" }], "only the tab's page is listed");
    assert.equal(sent[sent.length - 1].type, "chat.done");
});

test("turns that only read the design are not checked after", async () => {
    const tools = new QueuedBoards([
        [IPHONE, SEEDED],
        [IPHONE, CLONE, SEEDED],
    ]);
    const sent = await chatTurn("what is on the canvas?", tools);
    assert.deepEqual(tools.calls, ["list_boards"]);
    assert.equal(sent.filter((message) => message.type === "chat.tool").length, 0);
});

test("without a listing from before the turn nothing is reported", async () => {
    const tools = new QueuedBoards(["fail", [IPHONE, CLONE, SEEDED]]);
    const sent = await chatTurn("/tool change it", tools);
    assert.deepEqual(tools.calls, ["list_boards"], "no listing after when the one before failed");
    assert.equal(sent.filter((message) => message.type === "chat.tool" && message.status === "error").length, 0);
    assert.equal(sent[sent.length - 1].type, "chat.done");
});

test("a design script that failed is checked too", async () => {
    const tools = new QueuedBoards([
        [IPHONE, SEEDED],
        [IPHONE, CLONE, SEEDED],
    ]);
    const sent = await chatTurn("/fail-tool make an Android version", tools);
    assert.ok(sent.some((message) => message.type === "chat.tool" && message.status === "error" && message.code));
});
