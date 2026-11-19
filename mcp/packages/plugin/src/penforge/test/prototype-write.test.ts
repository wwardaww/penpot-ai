import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PenforgeApi } from "../PenforgeApi.ts";
import { fakeBoard, fakePage, fakePenpot, fakeShape } from "./fakes.ts";

function install(api: any): any {
    (globalThis as any).penpot = api;
    return api;
}

afterEach(() => {
    delete (globalThis as any).penpot;
});

/**
 * A to-do app page: Home with a "+" button, an Add task screen with Back and Save, and a
 * second (current) page holding an unrelated board.
 */
function todoFile(): any {
    const plus = fakeShape({ name: "Add button" });
    const home = fakeBoard({ name: "Home", children: [plus] });
    const back = fakeShape({ name: "Back" });
    const save = fakeShape({ name: "Save" });
    const add = fakeBoard({ name: "Add task", children: [back, save] });
    const page = fakePage("App", [home, add]);
    const other = fakeBoard({ name: "Elsewhere" });
    const page2 = fakePage("Other", [other]);
    const api = install(fakePenpot([page2, page]));
    return { api, page, page2, home, add, plus, back, save, other };
}

test("updatePrototype wires a new screen and starts the flow in one undo step", async () => {
    const f = todoFile();
    const result: any = await PenforgeApi.updatePrototype({
        operations: [
            { op: "add-interaction", sourceId: f.plus.id, action: { type: "navigate-to", destinationId: f.add.id } },
            { op: "add-interaction", sourceId: f.back.id, action: { type: "previous-screen" } },
            {
                op: "add-interaction",
                sourceId: f.save.id,
                trigger: "click",
                action: {
                    type: "navigate-to",
                    destinationId: f.home.id,
                    animation: { type: "slide", way: "out", direction: "right", duration: 300 },
                },
            },
            { op: "set-flow", name: "Main", startingBoardId: f.home.id },
        ],
    });
    assert.deepEqual(f.api.calls, [`openPage:${f.page.id}`, "undoBlockBegin", "undoBlockFinish"]);
    assert.equal(result.pageId, f.page.id);
    assert.equal(result.undoGrouped, true);
    assert.deepEqual(
        result.results.map((r: any) => [r.op, r.status]),
        [
            ["add-interaction", "added"],
            ["add-interaction", "added"],
            ["add-interaction", "added"],
            ["set-flow", "added"],
        ]
    );
    assert.equal(f.plus.interactions[0].action.destination, f.add);
    assert.equal(f.save.interactions[0].action.animation.type, "slide");
    assert.deepEqual(
        f.page.flows.map((flow: any) => [flow.name, flow.startingBoard.name]),
        [["Main", "Home"]]
    );
    assert.deepEqual(
        result.graph.edges.map((e: any) => [e.sourceName, e.to]),
        [
            ["Add button", f.add.id],
            ["Save", f.home.id],
        ]
    );
});

test("updatePrototype skips existing links and reports conflicts instead of replacing", async () => {
    const f = todoFile();
    f.plus.addInteraction("click", { type: "navigate-to", destination: f.home });
    f.page.createFlow("Main", f.home);
    const result: any = await PenforgeApi.updatePrototype({
        operations: [
            { op: "add-interaction", sourceId: f.plus.id, action: { type: "navigate-to", destinationId: f.home.id } },
            { op: "add-interaction", sourceId: f.plus.id, action: { type: "navigate-to", destinationId: f.add.id } },
            { op: "set-flow", name: "Main", startingBoardId: f.home.id },
        ],
    });
    assert.deepEqual(
        result.results.map((r: any) => r.status),
        ["skipped", "conflict", "skipped"]
    );
    assert.equal(result.results[1].index, 0);
    assert.equal(result.results[1].existing.action.destinationId, f.home.id);
    assert.equal(f.plus.interactions.length, 1);
    assert.equal(f.page.flows.length, 1);
});

test("updatePrototype reports a board that already starts another flow instead of failing", async () => {
    const f = todoFile();
    f.page.createFlow("Flow 1", f.home);
    const result: any = await PenforgeApi.updatePrototype({
        operations: [
            { op: "add-interaction", sourceId: f.plus.id, action: { type: "navigate-to", destinationId: f.add.id } },
            { op: "set-flow", name: "To-Do App", startingBoardId: f.home.id },
            { op: "set-flow", name: "Flow 1", startingBoardId: f.home.id, newName: "To-Do App" },
        ],
    });
    assert.deepEqual(
        result.results.map((r: any) => r.status),
        ["added", "conflict", "updated"]
    );
    assert.equal(result.results[1].existingFlow, "Flow 1");
    assert.deepEqual(
        f.page.flows.map((flow: any) => flow.name),
        ["To-Do App"]
    );
});

test("updatePrototype updates and removes interactions by index without shifting", async () => {
    const f = todoFile();
    f.plus.addInteraction("click", { type: "navigate-to", destination: f.home });
    f.plus.addInteraction("mouse-enter", { type: "open-overlay", destination: f.add });
    f.plus.addInteraction("mouse-leave", { type: "close-overlay" });
    const result: any = await PenforgeApi.updatePrototype({
        operations: [
            { op: "remove-interaction", sourceId: f.plus.id, index: 0 },
            { op: "remove-interaction", sourceId: f.plus.id, index: 1 },
            {
                op: "update-interaction",
                sourceId: f.plus.id,
                index: 2,
                trigger: "click",
                action: { type: "navigate-to", destinationId: f.add.id },
            },
        ],
    });
    assert.deepEqual(
        result.results.map((r: any) => r.status),
        ["removed", "removed", "updated"]
    );
    assert.equal(f.plus.interactions.length, 1);
    assert.equal(f.plus.interactions[0].trigger, "click");
    assert.equal(f.plus.interactions[0].action.destination, f.add);
});

test("updatePrototype moves, renames and removes flows", async () => {
    const f = todoFile();
    f.page.createFlow("Main", f.add);
    f.page.createFlow("Old", f.home);
    const result: any = await PenforgeApi.updatePrototype({
        pageId: f.page.id,
        operations: [
            { op: "remove-flow", name: "Old" },
            { op: "set-flow", name: "Main", startingBoardId: f.home.id, newName: "Tasks" },
            { op: "remove-flow", name: "Missing" },
        ],
    });
    assert.deepEqual(
        result.results.map((r: any) => r.status),
        ["removed", "updated", "skipped"]
    );
    assert.deepEqual(
        f.page.flows.map((flow: any) => [flow.name, flow.startingBoard.name]),
        [["Tasks", "Home"]]
    );
});

test("updatePrototype rejects bad input before any change", async () => {
    const f = todoFile();
    await assert.rejects(
        PenforgeApi.updatePrototype({
            operations: [{ op: "add-interaction", sourceId: f.plus.id, action: { type: "teleport" } }],
        }),
        /operations\[0\]\.action\.type must be one of/
    );
    await assert.rejects(PenforgeApi.updatePrototype({ operations: [] }), /non-empty array/);
    assert.deepEqual(f.api.calls, []);

    // a destination on another page fails while binding, before the undo block opens
    await assert.rejects(
        PenforgeApi.updatePrototype({
            operations: [
                {
                    op: "add-interaction",
                    sourceId: f.plus.id,
                    action: { type: "navigate-to", destinationId: f.add.id },
                },
                {
                    op: "add-interaction",
                    sourceId: f.plus.id,
                    action: { type: "navigate-to", destinationId: f.other.id },
                },
            ],
        }),
        /prototype links stay on one page/
    );
    assert.equal(f.plus.interactions.length, 0);
    assert.ok(!f.api.calls.includes("undoBlockBegin"));

    // a nested shape is not a screen
    await assert.rejects(
        PenforgeApi.updatePrototype({
            operations: [
                {
                    op: "add-interaction",
                    sourceId: f.home.id,
                    action: { type: "navigate-to", destinationId: f.back.id },
                },
            ],
        }),
        /is not a top-level board/
    );
    await assert.rejects(
        PenforgeApi.updatePrototype({ operations: [{ op: "remove-interaction", sourceId: f.plus.id, index: 3 }] }),
        /has no interaction at index 3/
    );
});
