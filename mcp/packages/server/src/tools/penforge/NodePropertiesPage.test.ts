import assert from "node:assert/strict";
import { test } from "node:test";
import { NodePropertiesPage } from "./NodePropertiesPage";

function board(childCount: number, childPadding = 0): Record<string, unknown> {
    return {
        id: "board",
        name: "Big board",
        type: "board",
        childCount,
        children: Array.from({ length: childCount }, (_, i) => ({
            id: `c${i}`,
            name: `Child ${i}`,
            type: "rectangle",
            visible: true,
            fills: [{ fillColor: "#ffffff", note: "x".repeat(childPadding) }],
            children: [{ id: `g${i}`, name: "grandchild", type: "text" }],
        })),
    };
}

test("a small node is returned unchanged, without page info", () => {
    const data = board(3);
    assert.deepEqual(JSON.parse(NodePropertiesPage.render(data)), data);
});

test("a node without children is returned unchanged", () => {
    assert.deepEqual(JSON.parse(NodePropertiesPage.render({ id: "r", type: "rect" })), { id: "r", type: "rect" });
    assert.equal(NodePropertiesPage.render(null), "null");
});

test("children come in pages that chain through nextOffset", () => {
    const data = board(250);
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
        const page = JSON.parse(NodePropertiesPage.render(data, offset, 100));
        seen.push(...page.children.map((child: { id: string }) => child.id));
        assert.equal(page.childrenPage.total, 250);
        offset = page.childrenPage.nextOffset;
        pages++;
    }
    assert.equal(pages, 3);
    assert.deepEqual(
        seen,
        Array.from({ length: 250 }, (_, i) => `c${i}`)
    );
});

test("an offset past the end returns no children", () => {
    const page = JSON.parse(NodePropertiesPage.render(board(5), 99, 10));
    assert.deepEqual(page.children, []);
    assert.equal(page.childrenPage.nextOffset, null);
});

test("a page too large for the limit is cut to summaries, then to fewer children", () => {
    const data = board(400, 400);
    const text = NodePropertiesPage.render(data, 0, 400, 20_000);
    assert.ok(text.length <= 20_000, `answer has ${text.length} characters`);
    const page = JSON.parse(text);
    assert.equal(page.childrenPage.summarized, true);
    assert.deepEqual(Object.keys(page.children[0]).sort(), ["childCount", "id", "name", "type", "visible"]);
    assert.equal(page.children[0].childCount, 1);
    assert.ok(page.childrenPage.returned < 400);
    assert.equal(page.childrenPage.nextOffset, page.childrenPage.returned);
});

test("every answer stays under the default size limit", () => {
    for (const [count, padding] of [
        [10, 0],
        [500, 50],
        [2000, 1000],
    ]) {
        const text = NodePropertiesPage.render(board(count, padding), 0, NodePropertiesPage.MAX_LIMIT);
        assert.ok(text.length <= NodePropertiesPage.MAX_CHARS + 200, `${count} children: ${text.length}`);
        JSON.parse(text);
    }
});

test("a node too large on its own is truncated with a note", () => {
    const text = NodePropertiesPage.render({ id: "t", type: "text", content: "y".repeat(80_000) });
    assert.ok(text.startsWith('{"id":"t"'));
    assert.match(text, /\[truncated: \d+ more characters/);
});

test("a page the plugin already cut keeps the plugin's range", () => {
    const data = board(100);
    data.childrenPage = { offset: 200, returned: 100, total: 450, nextOffset: 300 };
    const page = JSON.parse(NodePropertiesPage.render(data, 200, 100));
    assert.equal(page.children.length, 100);
    assert.equal(page.children[0].id, "c0");
    assert.deepEqual(page.childrenPage, { offset: 200, returned: 100, total: 450, nextOffset: 300 });
});

test("a plugin page that is still too large is shrunk from the plugin's offset", () => {
    const data = board(100, 2000);
    data.childrenPage = { offset: 300, returned: 100, total: 400, nextOffset: null };
    const page = JSON.parse(NodePropertiesPage.render(data, 300, 100, 3_000));
    assert.ok(page.childrenPage.returned < 100);
    assert.equal(page.childrenPage.offset, 300);
    assert.equal(page.childrenPage.summarized, true);
    assert.equal(page.childrenPage.nextOffset, 300 + page.childrenPage.returned);
});
