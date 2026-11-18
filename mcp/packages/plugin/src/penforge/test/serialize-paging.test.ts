import assert from "node:assert/strict";
import test from "node:test";
import { NodeSerializer } from "../serialize.ts";
import { fakeBoard, fakeShape } from "./fakes.ts";

// W11: get_node_properties pages the direct children in the plugin, so a board with thousands
// of children is not walked in full.

function boardWith(count: number): any {
    const children = Array.from({ length: count }, (_, i) => fakeShape({ id: `c${i}`, name: `Child ${i}` }));
    return fakeBoard({ id: "big", name: "Big", children });
}

/** Makes reading the name of children outside [from, to) fail, to prove they are not walked. */
function guardOutside(board: any, from: number, to: number): void {
    board.children.forEach((child: any, i: number) => {
        if (i < from || i >= to) {
            Object.defineProperty(child, "name", {
                get() {
                    throw new Error(`child ${i} was read`);
                },
            });
        }
    });
}

test("without a page every child is listed and no range is reported", () => {
    const result = NodeSerializer.serializeNode(boardWith(3));
    assert.equal((result.children as unknown[]).length, 3);
    assert.equal(result.childrenPage, undefined);
});

test("a page serializes only its children and reports the range", () => {
    const board = boardWith(250);
    guardOutside(board, 100, 200);
    const result: any = NodeSerializer.serializeNode(board, 2, { offset: 100, limit: 100 });
    assert.equal(result.children.length, 100);
    assert.equal(result.children[0].id, "c100");
    assert.equal(result.childCount, 250);
    assert.deepEqual(result.childrenPage, { offset: 100, returned: 100, total: 250, nextOffset: 200 });
});

test("the last page has no next offset and a page covering everything reports none", () => {
    const last: any = NodeSerializer.serializeNode(boardWith(250), 1, { offset: 200, limit: 100 });
    assert.deepEqual(last.childrenPage, { offset: 200, returned: 50, total: 250, nextOffset: null });
    const whole: any = NodeSerializer.serializeNode(boardWith(5), 1, { offset: 0, limit: 100 });
    assert.equal(whole.children.length, 5);
    assert.equal(whole.childrenPage, undefined);
});

test("offsets past the end and bad limits are clamped", () => {
    const past: any = NodeSerializer.serializeNode(boardWith(5), 1, { offset: 99, limit: 10 });
    assert.deepEqual(past.children, []);
    assert.deepEqual(past.childrenPage, { offset: 5, returned: 0, total: 5, nextOffset: null });
    const tiny: any = NodeSerializer.serializeNode(boardWith(5), 1, { offset: -3, limit: 0 });
    assert.equal(tiny.children.length, 1);
    assert.equal(tiny.childrenPage.nextOffset, 1);
});
