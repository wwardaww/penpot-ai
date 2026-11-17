import assert from "node:assert/strict";
import test from "node:test";
import { MutationError, NodeMutator } from "../mutate.ts";
import type { TokenResolver } from "../mutate.ts";
import { fakeBoard, fakeShape, fakeText } from "./fakes.ts";

class MapTokenResolver implements TokenResolver {
    private readonly names: Set<string>;

    constructor(names: string[]) {
        this.names = new Set(names);
    }

    findByName(name: string): any | null {
        return this.names.has(name) ? { name } : null;
    }
}

const mutator = new NodeMutator(new MapTokenResolver(["brand.primary"]));

test("rejects unknown top-level keys without changing the node", () => {
    const shape = fakeShape({ name: "Before" });
    assert.throws(
        () => mutator.apply(shape, { name: "After", rotation: 45 }),
        (error: Error) => error instanceof MutationError && /Unknown mutation key\(s\): rotation/.test(error.message)
    );
    assert.equal(shape.name, "Before");
});

test("rejects unknown nested keys", () => {
    const shape = fakeShape();
    assert.throws(
        () => mutator.apply(shape, { fills: [{ fillColor: "#FF0000" }] }),
        /Unknown key\(s\) in fills: fillColor/
    );
    assert.throws(() => mutator.apply(shape, { layoutChild: { margin: { middle: 1 } } }), /Unknown key\(s\) in margin/);
});

test("rejects empty and non-object mutations", () => {
    assert.throws(() => NodeMutator.validate({}), /at least one key/);
    assert.throws(() => NodeMutator.validate([]), /must be an object/);
    assert.throws(() => NodeMutator.validate(null), /must be an object/);
});

test("applies fills, strokes, geometry, visibility, opacity and radius", () => {
    const shape = fakeShape();
    const applied = mutator.apply(shape, {
        fills: [{ color: "#00FF00", opacity: 0.5 }],
        strokes: [{ color: "#000000", width: 2, alignment: "inner" }],
        width: 300,
        height: 200,
        x: 10,
        y: 20,
        visible: false,
        opacity: 0.8,
        radius: { all: 4, topLeft: 12 },
    });
    assert.deepEqual(shape.fills, [{ fillColor: "#00FF00", fillOpacity: 0.5 }]);
    assert.deepEqual(shape.strokes, [{ strokeColor: "#000000", strokeWidth: 2, strokeAlignment: "inner" }]);
    assert.deepEqual(shape.resizeCalls, [[300, 200]]);
    assert.equal(shape.x, 10);
    assert.equal(shape.y, 20);
    assert.equal(shape.hidden, true);
    assert.equal(shape.opacity, 0.8);
    assert.equal(shape.borderRadius, 4);
    assert.equal(shape.borderRadiusTopLeft, 12);
    assert.deepEqual(applied, ["fills", "strokes", "width", "height", "x", "y", "visible", "opacity", "radius"]);
});

test("resizing with one dimension keeps the other", () => {
    const shape = fakeShape({ width: 100, height: 50 });
    mutator.apply(shape, { height: 80 });
    assert.deepEqual(shape.resizeCalls, [[100, 80]]);
});

test("sets text content only on text nodes, checked before any change", () => {
    const text = fakeText([{ text: "Old", style: {} }]);
    mutator.apply(text, { text: "New" });
    assert.equal(text.characters, "New");

    const rect = fakeShape({ name: "Rect" });
    assert.throws(() => mutator.apply(rect, { name: "Renamed", text: "x" }), /text can only be set on text nodes/);
    assert.equal(rect.name, "Rect");
});

test("adds a flex layout and maps padding", () => {
    const board = fakeBoard();
    mutator.apply(board, { layout: { type: "flex", dir: "column", rowGap: 12, padding: { top: 8, left: 16 } } });
    assert.equal(board.flex.dir, "column");
    assert.equal(board.flex.rowGap, 12);
    assert.equal(board.flex.topPadding, 8);
    assert.equal(board.flex.leftPadding, 16);
});

test("removes a layout with type none", () => {
    const board = fakeBoard();
    board.addFlexLayout();
    mutator.apply(board, { layout: { type: "none" } });
    assert.equal(board.flex, undefined);
});

test("layout is rejected on non-boards and layoutChild without parent layout", () => {
    assert.throws(() => mutator.apply(fakeShape(), { layout: { type: "flex" } }), /only be set on boards/);
    assert.throws(() => mutator.apply(fakeShape(), { layoutChild: { zIndex: 1 } }), /children of a flex or grid board/);
});

test("applies layoutChild properties and margins", () => {
    const shape = fakeShape({ layoutChild: { horizontalSizing: "fix", topMargin: 0 } });
    mutator.apply(shape, { layoutChild: { horizontalSizing: "fill", margin: { top: 6 } } });
    assert.equal(shape.layoutChild.horizontalSizing, "fill");
    assert.equal(shape.layoutChild.topMargin, 6);
});

test("applies tokens by name and rejects unknown tokens before any change", () => {
    const shape = fakeShape({ name: "Keep" });
    mutator.apply(shape, { tokens: { fill: "brand.primary" } });
    assert.deepEqual(shape.appliedTokens, [["brand.primary", ["fill"]]]);

    const other = fakeShape({ name: "Keep" });
    assert.throws(
        () => mutator.apply(other, { name: "Changed", tokens: { fill: "missing" } }),
        /Token not found: missing/
    );
    assert.equal(other.name, "Keep");
});
