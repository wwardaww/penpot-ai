import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowClaudeRequest, WorkflowContext, WorkflowToolResult } from "@penpot/mcp-common";
import { PromptRegistry } from "../prompts/promptRegistry";
import { buildOperations, buildPrompt, describeResult, parseProposal, readPageCode, workflow } from "./wire-prototype";
import type { PageInfo } from "./wire-prototype";

function todoPage(): PageInfo {
    return {
        pageId: "p1",
        pageName: "App",
        flows: [],
        screens: [
            {
                id: "home",
                name: "Home",
                width: 390,
                height: 844,
                layers: [
                    { id: "plus", name: "Add Button", type: "board", text: null, boardId: "home", linked: false },
                    { id: "plus-label", name: "Label", type: "text", text: "+", boardId: "home", linked: false },
                    { id: "menu", name: "Menu", type: "board", text: null, boardId: "home", linked: true },
                ],
            },
            {
                id: "add",
                name: "Add Task",
                width: 390,
                height: 844,
                layers: [
                    { id: "back", name: "Back", type: "board", text: null, boardId: "add", linked: false },
                    { id: "save", name: "Save Button", type: "board", text: null, boardId: "add", linked: false },
                ],
            },
        ],
    };
}

const ANSWER = `Here are the links.
{"links": [
  {"sourceId": "plus", "action": "navigate-to", "destinationId": "add", "reason": "+ opens the form"},
  {"sourceId": "plus", "action": "navigate-to", "destinationId": "add", "reason": "duplicate"},
  {"sourceId": "menu", "action": "navigate-to", "destinationId": "add", "reason": "already linked"},
  {"sourceId": "back", "action": "previous-screen", "destinationId": null, "reason": "back"},
  {"sourceId": "save", "action": "navigate-to", "destinationId": "home", "reason": "save returns"},
  {"sourceId": "ghost", "action": "navigate-to", "destinationId": "home"},
  {"sourceId": "plus-label", "action": "navigate-to", "destinationId": "home", "reason": "self link"},
  {"sourceId": "back", "action": "teleport"}
], "flow": {"name": "Tasks", "startingBoardId": "home"}}`;

test("parseProposal keeps valid links on unlinked layers and fills in names", () => {
    const { links, flow } = parseProposal(ANSWER, todoPage());
    assert.deepEqual(
        links.map((l) => [l.sourceId, l.action, l.destinationId, l.boardName, l.destinationName]),
        [
            ["plus", "navigate-to", "add", "Home", "Add Task"],
            ["back", "previous-screen", null, "Add Task", null],
            ["save", "navigate-to", "home", "Add Task", "Home"],
        ]
    );
    assert.deepEqual(flow, { name: "Tasks", startingBoardId: "home", startingBoardName: "Home" });
});

test("parseProposal never proposes a second flow and survives a bad answer", () => {
    const page = todoPage();
    page.flows = [{ name: "Main", startingBoardId: "home" }];
    assert.equal(parseProposal(ANSWER, page).flow, null);
    assert.deepEqual(parseProposal("no json here", page), { links: [], flow: null });
});

test("buildOperations turns confirmed links into update_prototype operations", () => {
    const operations = buildOperations(
        [
            { sourceId: "plus", action: "navigate-to", destinationId: "add" },
            { sourceId: "back", action: "previous-screen" },
        ],
        { name: "Tasks", startingBoardId: "home" }
    );
    assert.deepEqual(operations, [
        {
            op: "add-interaction",
            sourceId: "plus",
            trigger: "click",
            action: {
                type: "navigate-to",
                destinationId: "add",
                animation: { type: "dissolve", duration: 200, easing: "ease-out" },
            },
        },
        { op: "add-interaction", sourceId: "back", trigger: "click", action: { type: "previous-screen" } },
        { op: "set-flow", name: "Tasks", startingBoardId: "home" },
    ]);
    assert.throws(() => buildOperations([{ sourceId: "x", action: "navigate-to" }], null), /needs a destination/);
});

test("buildPrompt lists screens, layers and flows; readPageCode embeds params as JSON", () => {
    const prompt = buildPrompt(todoPage());
    assert.match(prompt, /## Screen "Home" id=home \(390x844\)/);
    assert.match(prompt, /- plus-label \| text \| Label \| "\+"/);
    assert.match(prompt, /- menu \| board \| Menu \| already linked/);
    assert.match(prompt, /no flow yet/);
    const code = readPageCode('x"); evil(); ("', null);
    assert.match(code, /const params = \{"pageId":"x\\"\); evil\(\); \(\\""/);
});

test("the wire-prototype prompt ships with the daemon", () => {
    const text = PromptRegistry.locate().workflowPrompt("wire-prototype");
    assert.ok(text && /Task: wire the prototype/.test(text));
});

/**
 * Fake workflow context recording tool calls and Claude turns.
 */
function fakeContext(tools: (name: string, args: any) => WorkflowToolResult, answer: string) {
    const calls: { name: string; args: any }[] = [];
    const turns: WorkflowClaudeRequest[] = [];
    const events: { kind: string; payload: any }[] = [];
    const ctx = {
        runId: "r1",
        context: {},
        workspace: { root: "/tmp/project" },
        signal: { aborted: false },
        runner: {
            run: async (request: WorkflowClaudeRequest) => {
                turns.push(request);
                return { text: answer };
            },
        },
        tools: {
            call: async (name: string, args: any) => {
                calls.push({ name, args });
                return tools(name, args);
            },
            list: async () => [],
        },
        emit: (kind: string, payload: any) => events.push({ kind, payload }),
        ask: async () => "",
    } as unknown as WorkflowContext;
    return { ctx, calls, turns, events };
}

function ok(value: unknown): WorkflowToolResult {
    return { isError: false, content: [], text: JSON.stringify(value) };
}

test("the workflow proposes links without changing the design", async () => {
    const { ctx, calls, turns, events } = fakeContext(() => ok({ result: JSON.stringify(todoPage()) }), ANSWER);
    const done = await workflow.run(ctx, { pageId: "p1" });
    assert.deepEqual(
        calls.map((c) => c.name),
        ["execute_code"]
    );
    assert.equal(turns[0].promptName, "wire-prototype");
    assert.ok(turns[0].toolFilter, "the proposal turn may only read");
    const result = events.find((e) => e.kind === "result")!.payload;
    assert.equal(result.mode, "proposal");
    assert.equal(result.links.length, 3);
    assert.deepEqual(done, { summary: "Proposed 3 prototype link(s)" });
});

test("the workflow applies confirmed links with one update_prototype call", async () => {
    const { ctx, calls, turns, events } = fakeContext(
        () =>
            ok({
                pageId: "p1",
                undoGrouped: true,
                results: [
                    { op: "add-interaction", status: "added" },
                    { op: "add-interaction", status: "conflict" },
                    { op: "set-flow", status: "added" },
                ],
                graph: {},
            }),
        ""
    );
    const done = await workflow.run(ctx, {
        apply: true,
        links: [
            { sourceId: "plus", action: "navigate-to", destinationId: "add" },
            { sourceId: "menu", action: "navigate-to", destinationId: "add" },
        ],
        flow: { name: "Tasks", startingBoardId: "home" },
    });
    assert.equal(turns.length, 0);
    assert.deepEqual(
        calls.map((c) => [c.name, c.args.operations.length]),
        [["update_prototype", 3]]
    );
    assert.equal(events.find((e) => e.kind === "result")!.payload.undoGrouped, true);
    assert.deepEqual(done, { summary: "Wired 1 prototype link(s); 1 left as they were; flow set" });
});

test("a page with one screen gets no proposal", async () => {
    const page = todoPage();
    page.screens = page.screens.slice(0, 1);
    const { ctx, turns } = fakeContext(() => ok({ result: JSON.stringify(page) }), "");
    const done = await workflow.run(ctx, {});
    assert.equal(turns.length, 0);
    assert.equal(describeResult({ reason: "needs-two-screens" }), (done as any).summary);
});
