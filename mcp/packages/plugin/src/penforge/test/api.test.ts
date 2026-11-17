import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PenforgeApi } from "../PenforgeApi.ts";
import { fakeBoard, fakePage, fakePenpot, fakeShape } from "./fakes.ts";

const ROOT_ID = "00000000-0000-0000-0000-000000000000";

function install(api: any): any {
    (globalThis as any).penpot = api;
    return api;
}

afterEach(() => {
    delete (globalThis as any).penpot;
});

/**
 * Builds a thread as the released Plugin API returns it: id only as non-enumerable `$id`.
 */
function legacyThread(id: string, seq: number, boardId: string, resolved: boolean, comments: any[]): any {
    const thread: any = {
        seqNumber: seq,
        board: { id: boardId },
        position: { x: 10, y: 20 },
        resolved,
        replies: [] as string[],
        async findComments() {
            return comments;
        },
        async reply(content: string) {
            this.replies.push(content);
            return { content };
        },
    };
    Object.defineProperty(thread, "$id", { enumerable: false, get: () => id });
    return thread;
}

test("getNodeProperties finds a node on any page and adds its page id", () => {
    const rect = fakeShape({ name: "Rect" });
    const page1 = fakePage("One", []);
    const page2 = fakePage("Two", [rect]);
    install(fakePenpot([page1, page2]));
    const result: any = PenforgeApi.getNodeProperties({ nodeId: rect.id });
    assert.equal(result.pageId, page2.id);
    assert.equal(result.id, rect.id);
    assert.equal(result.name, "Rect");
});

test("getNodeProperties reports unknown ids clearly", () => {
    install(fakePenpot([fakePage("One", [])]));
    assert.throws(() => PenforgeApi.getNodeProperties({ nodeId: "nope" }), /Node not found in the current file: nope/);
});

test("updateDesignNode opens the node's page, groups the undo step and returns a snapshot", async () => {
    const rect = fakeShape({ name: "Rect" });
    const page1 = fakePage("One", []);
    const page2 = fakePage("Two", [rect]);
    const api = install(fakePenpot([page1, page2]));
    const result: any = await PenforgeApi.updateDesignNode({
        nodeId: rect.id,
        mutations: { name: "Renamed", fills: [{ color: "#123456" }] },
    });
    assert.deepEqual(api.calls, [`openPage:${page2.id}`, "undoBlockBegin", "undoBlockFinish"]);
    assert.deepEqual(result.applied, ["name", "fills"]);
    assert.equal(result.undoGrouped, true);
    assert.equal(result.node.name, "Renamed");
    assert.equal(result.node.pageId, page2.id);
    assert.equal((result.node.fills as any[])[0].color, "#123456");
});

test("updateDesignNode rejects unknown keys before opening the page", async () => {
    const rect = fakeShape();
    const api = install(fakePenpot([fakePage("One", []), fakePage("Two", [rect])]));
    await assert.rejects(
        PenforgeApi.updateDesignNode({ nodeId: rect.id, mutations: { rotation: 10 } }),
        /Unknown mutation key\(s\): rotation/
    );
    assert.deepEqual(api.calls, []);
});

test("updateDesignNode closes the undo block when a change fails", async () => {
    const rect = fakeShape({
        resize() {
            throw new Error("boom");
        },
    });
    const api = install(fakePenpot([fakePage("One", [rect])]));
    await assert.rejects(PenforgeApi.updateDesignNode({ nodeId: rect.id, mutations: { width: 10 } }), /boom/);
    assert.deepEqual(api.calls, ["undoBlockBegin", "undoBlockFinish"]);
});

test("listCanvasComments works with the released API: page from board, unresolved only, sorted", async () => {
    const boardA = fakeBoard({ name: "A" });
    const boardB = fakeBoard({ name: "B" });
    const page1 = fakePage("One", [boardA]);
    const page2 = fakePage("Two", [boardB]);
    const comment = { user: { name: "Ana" }, date: new Date("2026-01-02T03:04:05Z"), content: "Make it blue" };
    const threads = [
        legacyThread("t2", 2, boardB.id, false, [comment]),
        legacyThread("t1", 1, boardA.id, false, []),
        legacyThread("t3", 3, boardA.id, true, []),
        legacyThread("t4", 4, ROOT_ID, false, []),
    ];
    // the released API returns all threads of the file from any page
    page1.threads = threads;
    page2.threads = threads;
    install(fakePenpot([page1, page2]));

    const all: any[] = await PenforgeApi.listCanvasComments({ status: "unresolved" });
    assert.deepEqual(
        all.map((t) => [t.threadId, t.pageId, t.boardId]),
        [
            ["t1", page1.id, boardA.id],
            ["t2", page2.id, boardB.id],
            ["t4", null, null],
        ]
    );
    assert.deepEqual(all[1].comments, [{ author: "Ana", date: "2026-01-02T03:04:05.000Z", content: "Make it blue" }]);
    assert.equal(all[1].nodeId, null);
    assert.deepEqual(all[1].position, { x: 10, y: 20 });

    const onPage2: any[] = await PenforgeApi.listCanvasComments({ pageId: page2.id, status: "all" });
    assert.deepEqual(
        onPage2.map((t) => t.threadId),
        ["t2"]
    );

    const withResolved: any[] = await PenforgeApi.listCanvasComments({ pageId: page1.id, status: "all" });
    assert.deepEqual(
        withResolved.map((t) => [t.threadId, t.resolved]),
        [
            ["t1", false],
            ["t3", true],
        ]
    );
});

test("listCanvasComments uses page-aware threads with id and nodeId when available", async () => {
    const page1 = fakePage("One", []);
    const page2 = fakePage("Two", []);
    const make = (id: string, seq: number) => ({
        ...legacyThread(id, seq, ROOT_ID, false, []),
        id,
        nodeId: `node-${id}`,
    });
    page1.threads = [make("a", 1)];
    page2.threads = [make("b", 2)];
    install(fakePenpot([page1, page2]));
    const result: any[] = await PenforgeApi.listCanvasComments({});
    assert.deepEqual(
        result.map((t) => [t.threadId, t.pageId, t.nodeId]),
        [
            ["a", page1.id, "node-a"],
            ["b", page2.id, "node-b"],
        ]
    );
});

test("resolveCanvasComment replies with the note, then resolves", async () => {
    const page = fakePage("One", []);
    const thread = legacyThread("t1", 1, ROOT_ID, false, []);
    page.threads = [thread];
    install(fakePenpot([page]));
    const result = await PenforgeApi.resolveCanvasComment({
        threadId: "t1",
        resolutionNote: " Changed color to blue ",
    });
    assert.deepEqual(result, { ok: true, threadId: "t1", replied: true, resolved: true });
    assert.deepEqual(thread.replies, ["Changed color to blue"]);
    assert.equal(thread.resolved, true);
});

test("resolveCanvasComment without note only resolves; unknown ids fail", async () => {
    const page = fakePage("One", []);
    const thread = legacyThread("t1", 1, ROOT_ID, false, []);
    page.threads = [thread];
    install(fakePenpot([page]));
    const result: any = await PenforgeApi.resolveCanvasComment({ threadId: "t1" });
    assert.equal(result.replied, false);
    assert.deepEqual(thread.replies, []);
    await assert.rejects(
        PenforgeApi.resolveCanvasComment({ threadId: "missing" }),
        /Comment thread not found: missing/
    );
});

test("listBoards and getPrototypeGraph report flows and navigation edges", () => {
    const details = fakeBoard({ name: "Details", width: 390, height: 844 });
    const button = fakeShape({
        name: "Open",
        interactions: [{ trigger: "click", action: { type: "navigate-to", destination: details } }],
    });
    const home = fakeBoard({ name: "Home", width: 390, height: 844, children: [button] });
    const page = fakePage("App", [home, details, fakeShape({ name: "Loose rect" })]);
    page.flows = [{ name: "Main", startingBoard: home }];
    install(fakePenpot([page]));

    const boards: any[] = PenforgeApi.listBoards({});
    assert.deepEqual(
        boards.map((b) => [b.name, b.width, b.flowsStarted, b.interactions.length]),
        [
            ["Home", 390, ["Main"], 1],
            ["Details", 390, [], 0],
        ]
    );
    assert.equal(boards[0].interactions[0].sourceId, button.id);

    const graph: any = PenforgeApi.getPrototypeGraph();
    assert.deepEqual(graph.pages, [{ id: page.id, name: "App", boardCount: 2 }]);
    assert.deepEqual(graph.flows, [
        { name: "Main", pageId: page.id, startingBoardId: home.id, startingBoardName: "Home" },
    ]);
    assert.deepEqual(graph.edges, [
        {
            from: home.id,
            to: details.id,
            type: "navigate-to",
            trigger: "click",
            sourceId: button.id,
            sourceName: "Open",
            pageId: page.id,
        },
    ]);
});

test("captureNodeScreenshot waits for layout, exports with scale and returns a base64 envelope", async () => {
    const calls: string[] = [];
    const rect = fakeShape({
        name: "Rect",
        async waitForLayoutUpdate() {
            calls.push("wait");
        },
        async export(config: any) {
            calls.push(`export:${config.type}:${config.scale}`);
            return new Uint8Array([1, 2, 3]);
        },
    });
    install(fakePenpot([fakePage("One", [rect])]));
    const result: any = await PenforgeApi.captureNodeScreenshot({ target: rect.id, scale: 3, format: "webp" });
    assert.deepEqual(calls, ["wait", "export:webp:3"]);
    assert.deepEqual(result.image, { __type: "base64", data: Buffer.from([1, 2, 3]).toString("base64") });
    assert.deepEqual(result.node, { id: rect.id, name: "Rect", type: "rectangle" });
});

test("captureNodeScreenshot supports selection and page targets", async () => {
    const exportOf = (label: string) => async () => new TextEncoder().encode(label);
    const selected = fakeShape({ export: exportOf("sel") });
    const page = fakePage("One", [selected]);
    page.root.export = exportOf("page");
    const api = install(fakePenpot([page]));

    await assert.rejects(PenforgeApi.captureNodeScreenshot({ target: "selection" }), /Nothing is selected/);
    api.selection = [selected];
    const sel: any = await PenforgeApi.captureNodeScreenshot({ target: "selection" });
    assert.equal(Buffer.from(sel.image.data, "base64").toString(), "sel");
    const whole: any = await PenforgeApi.captureNodeScreenshot({ target: "page" });
    assert.equal(Buffer.from(whole.image.data, "base64").toString(), "page");
});

test("generateCodeHints returns markup, style and font faces", async () => {
    const card = fakeBoard({ name: "Card" });
    install(fakePenpot([fakePage("One", [card])]));
    const result: any = await PenforgeApi.generateCodeHints({ nodeId: card.id });
    assert.equal(result.html, '<div data-type="html">Card</div>');
    assert.match(result.css, /css prelude=true children=true/);
    assert.equal(result.fontFaces, "@font-face {}");
});
