import assert from "node:assert/strict";
import test from "node:test";
import { NodeSerializer } from "../serialize.ts";
import { fakeBoard, fakeLayout, fakeShape, fakeText } from "./fakes.ts";

const TOP_LEVEL_KEYS = [
    "id",
    "name",
    "type",
    "parentId",
    "visible",
    "blocked",
    "geometry",
    "constraints",
    "opacity",
    "blendMode",
    "radius",
    "fills",
    "strokes",
    "shadows",
    "blur",
    "layout",
    "layoutChild",
    "layoutCell",
    "text",
    "tokens",
    "component",
    "interactions",
    "childCount",
    "children",
];

test("serializeNode emits a stable key order and rounds numbers to 2 decimals", () => {
    const shape = fakeShape({
        x: 10.123456,
        y: -0.0001,
        width: 99.999,
        height: 20.005,
        rotation: 12.3456,
        opacity: 0.333333,
        fills: [{ fillColor: "#FF0000", fillOpacity: 0.55555 }],
    });
    const result = NodeSerializer.serializeNode(shape);
    assert.deepEqual(Object.keys(result), TOP_LEVEL_KEYS);
    assert.deepEqual(result.geometry, {
        x: 10.12,
        y: 0,
        width: 100,
        height: 20.01,
        parentX: 0,
        parentY: 0,
        rotation: 12.35,
        flipX: false,
        flipY: false,
    });
    assert.equal(result.opacity, 0.33);
    assert.deepEqual(result.fills, [{ color: "#FF0000", opacity: 0.56, gradient: null, image: null, colorRef: null }]);
});

test("serializeNode is deterministic for equal input", () => {
    const make = () =>
        fakeShape({
            id: "same",
            tokens: { fill: "brand.primary", "stroke-color": "brand.border", r1: "radius.sm" },
            strokes: [{ strokeColor: "#000000", strokeWidth: 1.234 }],
        });
    assert.equal(
        JSON.stringify(NodeSerializer.serializeNode(make())),
        JSON.stringify(NodeSerializer.serializeNode(make()))
    );
});

test("serializeNode sorts applied tokens by property", () => {
    const shape = fakeShape({ tokens: { fill: "brand", r1: "radius.sm", "border-width": "bw" } });
    const result = NodeSerializer.serializeNode(shape);
    assert.deepEqual(Object.keys(result.tokens as object), ["border-width", "fill", "r1"]);
});

test("text nodes expose content, typography with numbers and one span when uniform", () => {
    const text = fakeText([
        {
            text: "Hello world",
            style: {
                fontFamily: "Inter",
                fontId: "gfont-inter",
                fontVariantId: "regular",
                fontSize: "16",
                fontWeight: "400",
                fontStyle: "normal",
                lineHeight: "1.2",
                letterSpacing: "0",
                textTransform: null,
                textDecoration: null,
            },
        },
    ]);
    const result: any = NodeSerializer.serializeNode(text);
    assert.equal(result.text.content, "Hello world");
    assert.equal(result.text.typography.fontFamily, "Inter");
    assert.equal(result.text.typography.fontSize, 16);
    assert.equal(result.text.typography.lineHeight, 1.2);
    assert.equal(result.text.typography.align, "left");
    assert.equal(result.text.spans.length, 1);
    assert.deepEqual(
        { start: result.text.spans[0].start, end: result.text.spans[0].end, text: result.text.spans[0].text },
        { start: 0, end: 11, text: "Hello world" }
    );
});

test("text nodes with mixed styles are split into spans of equal style", () => {
    const regular = { fontFamily: "Inter", fontWeight: "400", fontSize: "14" };
    const bold = { fontFamily: "Inter", fontWeight: "700", fontSize: "14" };
    const text = fakeText([
        { text: "Hi ", style: regular },
        { text: "there", style: bold },
        { text: "!", style: regular },
    ]);
    const result: any = NodeSerializer.serializeNode(text);
    assert.equal(result.text.typography.fontWeight, "mixed");
    assert.deepEqual(
        result.text.spans.map((s: any) => [s.start, s.end, s.text, s.fontWeight]),
        [
            [0, 3, "Hi ", 400],
            [3, 8, "there", 700],
            [8, 9, "!", 400],
        ]
    );
});

test("depth 1 summarizes children, depth 2 serializes them in full", () => {
    const grandChild = fakeShape({ name: "Icon" });
    const child = fakeBoard({ name: "Card", children: [grandChild] });
    const board = fakeBoard({ name: "Screen", children: [child] });

    const shallow: any = NodeSerializer.serializeNode(board, 1);
    assert.equal(shallow.childCount, 1);
    assert.deepEqual(shallow.children, [{ id: child.id, name: "Card", type: "board", visible: true }]);

    const deep: any = NodeSerializer.serializeNode(board, 2);
    assert.equal(deep.children[0].name, "Card");
    assert.equal(deep.children[0].parentId, board.id);
    assert.deepEqual(deep.children[0].children, [
        { id: grandChild.id, name: "Icon", type: "rectangle", visible: true },
    ]);
});

test("depth is clamped to the allowed range", () => {
    const board = fakeBoard({ children: [fakeShape()] });
    const result: any = NodeSerializer.serializeNode(board, 0);
    assert.equal(result.children[0].geometry, undefined);
});

test("boards report flex layout, children report layoutChild", () => {
    const child = fakeShape({
        layoutChild: {
            absolute: false,
            zIndex: 0,
            horizontalSizing: "fill",
            verticalSizing: "auto",
            alignSelf: "center",
            topMargin: 4,
            rightMargin: 0,
            bottomMargin: 4,
            leftMargin: 0,
            minWidth: null,
            maxWidth: 320.555,
            minHeight: null,
            maxHeight: null,
        },
    });
    const board = fakeBoard({
        flex: fakeLayout("column", { rowGap: 8, topPadding: 16, leftPadding: 24 }),
        children: [child],
    });
    const result: any = NodeSerializer.serializeNode(board, 2);
    assert.equal(result.layout.type, "flex");
    assert.equal(result.layout.dir, "column");
    assert.equal(result.layout.rowGap, 8);
    assert.deepEqual(result.layout.padding, { top: 16, right: 0, bottom: 0, left: 24 });
    assert.equal(result.children[0].layoutChild.horizontalSizing, "fill");
    assert.deepEqual(result.children[0].layoutChild.margin, { top: 4, right: 0, bottom: 4, left: 0 });
    assert.equal(result.children[0].layoutChild.maxWidth, 320.56);
});

test("grid layouts include tracks; boards without layout report type none", () => {
    const grid = {
        ...fakeLayout("row"),
        rows: [{ type: "flex", value: 1 }],
        columns: [{ type: "fixed", value: 120.333 }],
    };
    const withGrid: any = NodeSerializer.serializeNode(fakeBoard({ grid }));
    assert.equal(withGrid.layout.type, "grid");
    assert.deepEqual(withGrid.layout.columns, [{ type: "fixed", value: 120.33 }]);
    const plain: any = NodeSerializer.serializeNode(fakeBoard());
    assert.equal(plain.layout.type, "none");
    assert.equal(NodeSerializer.serializeNode(fakeShape()).layout, null);
});

test("component instances report component and variant info", () => {
    const main = fakeShape({ id: "main-1" });
    const component = {
        id: "comp-1",
        name: "Button",
        path: "Buttons",
        libraryId: "lib-1",
        mainInstance: () => main,
        isVariant: () => true,
        variantProps: { state: "hover", size: "md" },
    };
    const instance = fakeShape({
        isComponentInstance: () => true,
        isComponentCopyInstance: () => true,
        isComponentRoot: () => true,
        component: () => component,
    });
    const result: any = NodeSerializer.serializeNode(instance);
    assert.deepEqual(result.component, {
        isInstance: true,
        isMainInstance: false,
        isCopy: true,
        isRoot: true,
        isVariantContainer: false,
        componentId: "comp-1",
        componentName: "Button",
        componentPath: "Buttons",
        libraryId: "lib-1",
        mainInstanceId: "main-1",
        variantProps: { size: "md", state: "hover" },
    });
    assert.equal(NodeSerializer.serializeNode(fakeShape()).component, null);
});

test("interactions report trigger, action type and destination", () => {
    const target = fakeBoard({ id: "board-b", name: "Details" });
    const button = fakeShape({
        interactions: [
            { trigger: "click", delay: null, action: { type: "navigate-to", destination: target } },
            { trigger: "click", action: { type: "open-url", url: "https://example.com" } },
        ],
    });
    const result: any = NodeSerializer.serializeNode(button);
    assert.equal(result.interactions[0].action.type, "navigate-to");
    assert.equal(result.interactions[0].action.destinationId, "board-b");
    assert.equal(result.interactions[0].action.destinationName, "Details");
    assert.equal(result.interactions[1].action.url, "https://example.com");
    assert.equal(result.interactions[1].action.destinationId, null);
});

test("shadows, strokes and radius are serialized", () => {
    const shape = fakeShape({
        borderRadius: 8,
        borderRadiusTopLeft: 8,
        borderRadiusTopRight: 8,
        borderRadiusBottomRight: 0,
        borderRadiusBottomLeft: 0,
        strokes: [{ strokeColor: "#111111", strokeWidth: 2, strokeAlignment: "inner", strokeStyle: "dashed" }],
        shadows: [
            {
                style: "drop-shadow",
                offsetX: 0,
                offsetY: 2,
                blur: 4,
                spread: 0,
                color: { color: "#000000", opacity: 0.25 },
            },
        ],
    });
    const result: any = NodeSerializer.serializeNode(shape);
    assert.deepEqual(result.radius, { all: 8, topLeft: 8, topRight: 8, bottomRight: 0, bottomLeft: 0 });
    assert.equal(result.strokes[0].alignment, "inner");
    assert.equal(result.strokes[0].style, "dashed");
    assert.deepEqual(result.shadows[0].color, { color: "#000000", opacity: 0.25, colorRef: null });
});
