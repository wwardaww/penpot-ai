import assert from "node:assert/strict";
import test from "node:test";
import { CanvasSnapshot } from "../canvasSnapshot.ts";
import { LayoutCheck } from "../layoutCheck.ts";
import { fakeLayout, fakePage, fakePenpot, fakeShape } from "./fakes.ts";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const fill = (fillColor: string, fillOpacity = 1) => [{ fillColor, fillOpacity }];

function layer(type: string, name: string, bounds: object, more: Record<string, any> = {}): any {
    const shape = fakeShape({ type, name, bounds, fills: [], strokes: [], hidden: false, ...more });
    for (const child of shape.children ?? []) {
        child.parent = shape;
    }
    return shape;
}

const text = (name: string, bounds: object, more: Record<string, any> = {}) =>
    layer("text", name, bounds, { fontSize: "16", fills: fill("#1a1a1a"), ...more });

function penpotWith(...shapes: any[]): any {
    const page = fakePage("Page", shapes);
    for (const shape of shapes) {
        shape.parent = page.root;
    }
    return fakePenpot([page]);
}

const check = (boards: any[], added: any[] = [], others: any[] = []) =>
    new LayoutCheck(penpotWith(...boards, ...others)).run(boards, added).map((line) => line.replace(/ [\w]+-\d+/g, ""));

test("a clean board has no problems", () => {
    const card = layer("board", "Card", box(40, 40, 300, 120), {
        fills: fill("#ffffff"),
        flex: fakeLayout("column", { rowGap: 12 }),
        children: [text("Title", box(64, 64, 200, 24)), text("Body", box(64, 100, 200, 24))],
    });
    const board = layer("board", "Home", box(0, 0, 400, 300), { fills: fill("#f6f1e7"), children: [card] });
    assert.deepEqual(check([board]), []);
});

test("a flex layout without gap is named with the property to set", () => {
    const row = (more: object) =>
        layer("board", "Cards", box(40, 40, 300, 100), {
            flex: fakeLayout("row", more),
            children: [layer("board", "A", box(40, 40, 100, 100)), layer("board", "B", box(140, 40, 100, 100))],
        });
    const found = (more: object) =>
        check([layer("board", "Home", box(0, 0, 400, 300), { fills: fill("#ffffff"), children: [row(more)] })]);
    assert.deepEqual(found({}), ['board "Cards" has no gap between its 2 children: set columnGap']);
    assert.deepEqual(found({ columnGap: 24 }), []);
    assert.deepEqual(found({ justifyContent: "space-between" }), []);
});

test("sections stacked directly on the board need no gap", () => {
    const board = layer("board", "Home", box(0, 0, 400, 300), {
        fills: fill("#ffffff"),
        flex: fakeLayout("column"),
        children: [layer("board", "Hero", box(0, 0, 400, 100)), layer("board", "Cards", box(0, 100, 400, 100))],
    });
    assert.deepEqual(check([board]), []);
});

test("text at the edge of a drawn box is found, also through boxes that show nothing", () => {
    const column = layer("board", "Column", box(0, 0, 200, 100), { children: [text("Title", box(0, 40, 90, 20))] });
    const hero = layer("board", "Hero", box(0, 0, 400, 100), { fills: fill("#f6f1e7"), children: [column] });
    const board = layer("board", "Home", box(0, 0, 400, 300), { fills: fill("#ffffff"), children: [hero] });
    assert.deepEqual(check([board]), ['text "Title" touches the edge of "Hero": give padding']);
});

test("overlaps, overflow, tiny and pale text are found", () => {
    const card = layer("board", "Card", box(20, 200, 100, 50), { fills: fill("#e0e5ec") });
    const grey = text("Grey", box(30, 210, 50, 20), { fills: fill("#c0c5cc") });
    card.children = [grey];
    grey.parent = card;
    const board = layer("board", "Home", box(0, 0, 400, 300), {
        fills: fill("#ffffff"),
        children: [
            text("Title", box(20, 20, 200, 40)),
            text("Over", box(100, 40, 200, 40)),
            text("Wide", box(300, 100, 200, 20)),
            text("Tiny", box(20, 130, 50, 10), { fontSize: "9" }),
            card,
            layer("board", "Panel", box(100, 220, 100, 50)),
            text("Hidden", box(20, 20, 900, 40), { hidden: true }),
        ],
    });
    assert.deepEqual(check([board]), [
        'text "Wide" sticks out of its board',
        'text "Tiny" is tiny (9px)',
        'text "Grey" has weak contrast (1.4:1, #c0c5cc on #e0e5ec)',
        'text "Title" overlaps "Over"',
        'board "Card" overlaps "Panel"',
    ]);
});

test("letters count, not the box of a text, and a faint fill is no ground", () => {
    const tag = layer("board", "Tag", box(20, 20, 200, 30), { fills: fill("#c43028", 0.08) });
    const label = text("Label", box(20, 20, 200, 30), {
        textBounds: box(60, 25, 100, 20),
        fills: fill("#c43028"),
    });
    tag.children = [label];
    label.parent = tag;
    const board = layer("board", "Home", box(0, 0, 400, 300), { fills: fill("#ffffff"), children: [tag] });
    assert.deepEqual(check([board]), []);
});

test("shapes outside every board, empty boards and equal names are found", () => {
    const home = layer("board", "Landing", box(0, 0, 400, 300), {
        fills: fill("#ffffff"),
        children: [text("Title", box(20, 20, 90, 20))],
    });
    const left = layer("board", "Landing", box(0, 0, 400, 300), { children: [] });
    const lost = layer("rectangle", "Panel", box(900, 0, 10, 10));
    const old = layer("rectangle", "Old", box(950, 0, 10, 10));
    assert.deepEqual(check([home, left], [lost], [lost, old]), [
        'rectangle "Panel" lies on the page, outside every board',
        'board "Landing" has the same name as board; work with ids',
        'board "Landing" is empty; remove it by id if a failed script left it',
        'board "Landing" has the same name as board; work with ids',
    ]);
});

test("a long list is cut", () => {
    const children = Array.from({ length: 20 }, (_, i) =>
        text(`T${i}`, box(20, 20 + 12 * i, 50, 9), { fontSize: "8" })
    );
    const found = check([layer("board", "Home", box(0, 0, 400, 300), { fills: fill("#ffffff"), children })]);
    assert.equal(found.length, 13);
    assert.equal(found[12], "and 8 more problems");
});

test("a snapshot finds the shapes added since, outermost only, and not those that moved", () => {
    const kept = layer("board", "Kept", box(0, 0, 10, 10), { children: [] });
    const moved = layer("rectangle", "Moved", box(0, 0, 10, 10));
    const penpot = penpotWith(kept, moved);
    const before = CanvasSnapshot.take(penpot);
    const inner = text("Inner", box(0, 0, 1, 1));
    const added = layer("board", "Added", box(0, 0, 10, 10), { children: [inner] });
    const nested = text("Nested", box(0, 0, 1, 1));
    kept.children = [moved, nested];
    penpot.currentPage.root.children = [kept, added];
    assert.deepEqual(
        before.added(penpot).map((shape) => shape.name),
        ["Nested", "Added"]
    );
    penpot.currentPage = fakePage("Other", [layer("rectangle", "X", box(0, 0, 1, 1))]);
    assert.deepEqual(before.added(penpot), []);
});

test("on a huge page only top-level shapes count", () => {
    const children = Array.from({ length: 600 }, (_, i) => layer("rectangle", `R${i}`, box(0, 0, 1, 1)));
    const board = layer("board", "Big", box(0, 0, 10, 10), { children });
    const penpot = penpotWith(board);
    const before = CanvasSnapshot.take(penpot);
    board.children = [...children, layer("rectangle", "New", box(0, 0, 1, 1))];
    const top = layer("rectangle", "Top", box(0, 0, 1, 1));
    penpot.currentPage.root.children = [board, top];
    assert.deepEqual(
        before.added(penpot).map((shape) => shape.name),
        ["Top"]
    );
});
