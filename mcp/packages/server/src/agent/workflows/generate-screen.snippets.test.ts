import assert from "node:assert/strict";
import { test } from "node:test";
import {
    type BoardInspection,
    type CreatedBoard,
    type DesignSystemSnapshot,
    SNAPSHOT_LIMITS,
    createBoardCode,
    inspectBoardCode,
    readDesignSystemCode,
} from "./generate-screen.snippets";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** Runs a snippet the way the MCP plugin does: as an async function body with `penpot` in scope. */
function run<T>(code: string, penpot: unknown): Promise<T> {
    return new AsyncFunction("penpot", "penpotUtils", "storage", code)(penpot, {}, {});
}

/** Minimal shape of the Plugin API. */
function shape(props: Record<string, any>): any {
    return {
        children: [],
        tokens: {},
        fills: [],
        isComponentInstance: () => false,
        component: () => null,
        ...props,
    };
}

function page(id: string, name: string, roots: any[], extra: any[] = []): any {
    const all = [...roots, ...extra];
    const find = (list: any[], id: string): any =>
        list.reduce((found, s) => found ?? (s.id === id ? s : find(s.children ?? [], id)), null);
    return { id, name, root: { children: roots }, getShapeById: (shapeId: string) => find(all, shapeId) };
}

test("readDesignSystemCode reads tokens of active sets, libraries, free space and references", async () => {
    const screens = page("page-1", "Screens", [
        shape({ id: "a", x: 0, y: 100, width: 390, height: 844 }),
        shape({ id: "b", x: 500, y: 40, width: 1440, height: 1024 }),
    ]);
    const other = page("page-2", "Parts", [
        shape({ id: "ref", name: "Card", type: "board", x: 0, y: 0, width: 1, height: 1 }),
    ]);
    const token = (name: string, type: string, value: string | undefined) => ({
        name,
        type,
        resolvedValueString: value,
    });
    const penpot = {
        currentPage: screens,
        currentFile: { id: "file-1", pages: [screens, other] },
        library: {
            local: {
                tokens: {
                    sets: [
                        {
                            name: "base",
                            active: true,
                            tokens: [token("color.primary", "color", "#3D5AFE"), token("x", "spacing", undefined)],
                        },
                        { name: "dark", active: false, tokens: [token("color.primary", "color", "#000")] },
                    ],
                },
                colors: [{ id: "c1", name: "Brand", path: "Core", color: "#3D5AFE", opacity: 1 }],
                typographies: [
                    {
                        id: "t1",
                        name: "Body",
                        path: "",
                        fontFamily: "Inter",
                        fontSize: 16,
                        fontWeight: 400,
                        lineHeight: 1.5,
                    },
                ],
                components: [{ id: "k1", name: "Button", path: "Actions" }],
            },
            connected: [
                { name: "UI Kit", colors: [], typographies: [], components: [{ id: "k2", name: "Input", path: "" }] },
            ],
        },
    };
    const snapshot = await run<DesignSystemSnapshot>(
        readDesignSystemCode({ pageId: "page-1", referenceNodeIds: ["ref", "missing"] }),
        penpot
    );
    assert.deepEqual(snapshot.page, { id: "page-1", name: "Screens" });
    assert.equal(snapshot.freeX, 1940);
    assert.equal(snapshot.topY, 40);
    assert.deepEqual(snapshot.tokens, [
        { name: "color.primary", type: "color", value: "#3D5AFE", set: "base" },
        { name: "x", type: "spacing", value: null, set: "base" },
    ]);
    assert.deepEqual(snapshot.colors, [
        { id: "c1", name: "Brand", path: "Core", color: "#3D5AFE", opacity: 1, library: "local" },
    ]);
    assert.deepEqual(snapshot.typographies[0], {
        id: "t1",
        name: "Body",
        path: "",
        fontFamily: "Inter",
        fontSize: "16",
        fontWeight: "400",
        lineHeight: "1.5",
        library: "local",
    });
    assert.deepEqual(
        snapshot.components.map((c) => `${c.library}:${c.name}`),
        ["local:Button", "UI Kit:Input"]
    );
    assert.deepEqual(snapshot.references, [{ id: "ref", name: "Card", type: "board", pageId: "page-2" }]);
    assert.equal(snapshot.truncated, false);
});

test("readDesignSystemCode falls back to the current page, handles an empty page and cuts long lists", async () => {
    const empty = page("page-1", "Empty", []);
    const many = Array.from({ length: SNAPSHOT_LIMITS.components + 5 }, (_, i) => ({
        id: `k${i}`,
        name: `C${i}`,
        path: "",
    }));
    const penpot = {
        currentPage: empty,
        currentFile: { id: "file-1", pages: [empty] },
        library: { local: { tokens: { sets: [] }, colors: [], typographies: [], components: many }, connected: [] },
    };
    const snapshot = await run<DesignSystemSnapshot>(
        readDesignSystemCode({ pageId: "unknown", referenceNodeIds: [] }),
        penpot
    );
    assert.equal(snapshot.page.id, "page-1");
    assert.equal(snapshot.freeX, null);
    assert.equal(snapshot.topY, null);
    assert.equal(snapshot.components.length, SNAPSHOT_LIMITS.components);
    assert.equal(snapshot.truncated, true);
});

test("createBoardCode opens the page and creates a flex board with guides", async () => {
    const opened: string[] = [];
    const guides: [string, number][] = [];
    const target = page("page-2", "Flows", []);
    let created: any = null;
    const penpot: any = {
        currentPage: page("page-1", "Screens", []),
        currentFile: { pages: [target] },
        openPage: async (p: any) => {
            opened.push(p.id);
            penpot.currentPage = p;
        },
        createBoard: () => {
            created = {
                id: "board-1",
                width: 100,
                height: 100,
                resize(w: number, h: number) {
                    this.width = w;
                    this.height = h;
                },
                addFlexLayout() {
                    this.flex = {};
                    return this.flex;
                },
                addRulerGuide: (orientation: string, value: number) => guides.push([orientation, value]),
            };
            return created;
        },
    };
    const board = await run<CreatedBoard>(
        createBoardCode({
            pageId: "page-2",
            name: "Draft Login",
            x: 200,
            y: 10,
            width: 390,
            height: 844,
            guides: [47, 810],
        }),
        penpot
    );
    assert.deepEqual(opened, ["page-2"]);
    assert.deepEqual(board, {
        boardId: "board-1",
        pageId: "page-2",
        name: "Draft Login",
        x: 200,
        y: 10,
        width: 390,
        height: 844,
    });
    assert.deepEqual(created.flex, { dir: "column", alignItems: "stretch", justifyContent: "start" });
    assert.equal(created.clipContent, true);
    assert.deepEqual(created.fills, [{ fillColor: "#FFFFFF", fillOpacity: 1 }]);
    assert.deepEqual(guides, [
        ["horizontal", 47],
        ["horizontal", 810],
    ]);

    await assert.rejects(
        run(createBoardCode({ pageId: "nope", name: "x", x: 0, y: 0, width: 1, height: 1, guides: [] }), penpot),
        /Page not found: nope/
    );
});

test("inspectBoardCode counts names, instances, tokens, layouts and raw colors", async () => {
    const button = shape({
        id: "btn",
        name: "Sign In Button",
        type: "board",
        isComponentInstance: () => true,
        component: () => ({ name: "Button" }),
        // inside an instance: not inspected
        children: [shape({ id: "inner", name: "Rectangle", type: "rectangle" })],
    });
    const form = shape({
        id: "form",
        name: "Form",
        type: "board",
        flex: {},
        tokens: { rowGap: "spacing.m" },
        children: [
            shape({
                id: "email",
                name: "Email Field",
                type: "rectangle",
                fills: [{ fillColor: "#fff", fillColorRefId: "c1" }],
            }),
            shape({
                id: "r",
                name: "Rectangle 2",
                type: "rectangle",
                fills: [{ fillColor: "#eee" }],
                layoutChild: { absolute: true },
            }),
            shape({
                id: "t",
                name: "Title",
                type: "text",
                fills: [{ fillColor: "#111" }],
                tokens: { fill: "color.text" },
            }),
            button,
        ],
    });
    const loose = shape({
        id: "loose",
        name: "Board",
        type: "board",
        children: [shape({ id: "l1", name: "A", type: "text" }), shape({ id: "l2", name: "B", type: "text" })],
    });
    const screen = shape({
        id: "board-1",
        name: "Login",
        type: "board",
        width: 390,
        height: 844,
        flex: {},
        fills: [{ fillColor: "#FFFFFF" }],
        children: [form, loose],
    });
    const current = page("page-1", "Screens", [screen]);
    const penpot = { currentPage: current, currentFile: { pages: [current] } };

    const result = await run<BoardInspection>(inspectBoardCode({ boardId: "board-1" }), penpot);
    assert.deepEqual(result, {
        found: true,
        boardId: "board-1",
        name: "Login",
        width: 390,
        height: 844,
        layerCount: 8,
        instanceCount: 1,
        componentNames: ["Button"],
        tokenizedLayerCount: 2,
        tokenNames: ["spacing.m", "color.text"],
        layoutContainerCount: 2,
        containersWithoutLayout: ["Board"],
        genericNames: ["Rectangle 2", "Board"],
        rawColorFillCount: 1,
        absoluteLayerCount: 1,
    });

    const missing = await run<BoardInspection>(inspectBoardCode({ boardId: "nope" }), penpot);
    assert.equal(missing.found, false);
});
