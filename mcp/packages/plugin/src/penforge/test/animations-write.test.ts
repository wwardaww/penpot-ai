import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PenforgeApi } from "../PenforgeApi.ts";
import { ANIMATION_KEY, ANIMATION_NAMESPACE } from "../animations.ts";
import { AnimationExporter } from "../animations-export.ts";
import { AnimationWriter } from "../animations-write.ts";
import { fakeBoard, fakePage, fakePenpot, fakeShape } from "./fakes.ts";

function install(api: any): any {
    (globalThis as any).penpot = api;
    return api;
}

afterEach(() => {
    delete (globalThis as any).penpot;
});

/**
 * Gives a fake shape shared plugin data; `writes` records every `setSharedPluginData` call.
 */
function withPluginData(shape: any, stored?: object | string): any {
    const data = new Map<string, string>();
    if (stored !== undefined) {
        data.set(
            `${ANIMATION_NAMESPACE}/${ANIMATION_KEY}`,
            typeof stored === "string" ? stored : JSON.stringify(stored)
        );
    }
    shape.writes = [] as string[];
    shape.getSharedPluginData = (namespace: string, key: string) => data.get(`${namespace}/${key}`) ?? "";
    shape.setSharedPluginData = (namespace: string, key: string, value: string) => {
        shape.writes.push(value);
        data.set(`${namespace}/${key}`, value);
    };
    for (const child of shape.children ?? []) {
        withPluginData(child);
    }
    return shape;
}

function stored(shape: any): any {
    const raw = shape.getSharedPluginData(ANIMATION_NAMESPACE, ANIMATION_KEY);
    return raw === "" ? null : JSON.parse(raw);
}

/**
 * An onboarding screen with three cards in a list and a "Get started" button, on the second
 * page; the first (current) page holds an unrelated board.
 */
function onboardingFile(): any {
    const cards = [1, 2, 3].map((n) => fakeBoard({ name: `Card ${n}`, children: [fakeShape({ name: "Title" })] }));
    const list = fakeBoard({ name: "Card List", children: cards });
    const button = fakeShape({ name: "Get Started Button" });
    const label = fakeShape({ name: "Label", type: "text" });
    const screen = withPluginData(fakeBoard({ name: "Onboarding", children: [list, button, label] }));
    const home = withPluginData(fakeBoard({ name: "Home" }));
    const page = fakePage("App", [screen, home]);
    const other = withPluginData(fakeBoard({ name: "Elsewhere" }));
    const page0 = fakePage("Scratch", [other]);
    const api = install(fakePenpot([page0, page]));
    api.currentFile.id = "file-1";
    api.currentFile.name = "Todo";
    return { api, page, page0, screen, list, cards, button, label, home };
}

const fadeUp = {
    effects: [{ type: "fade" }, { type: "slide", direction: "up", distance: 16 }],
    duration: 300,
    easing: "ease-out",
    stagger: { each: 60 },
};

test("updateAnimations sets a staggered entrance in one undo step on the node's page", async () => {
    const f = onboardingFile();
    const result: any = await PenforgeApi.updateAnimations({
        operations: [{ op: "set", nodeId: f.list.id, entrance: fadeUp }],
    });
    assert.deepEqual(f.api.calls, [`openPage:${f.page.id}`, "undoBlockBegin", "undoBlockFinish"]);
    assert.equal(result.pageId, f.page.id);
    assert.equal(result.undoGrouped, true);
    assert.deepEqual(result.results, [
        {
            nodeId: f.list.id,
            name: "Card List",
            type: "board",
            status: "set",
            animations: { v: 1, entrance: fadeUp },
        },
    ]);
    assert.deepEqual(stored(f.list), { v: 1, entrance: fadeUp });
    assert.equal(f.list.writes.length, 1);
});

test("several operations on one layer add up and the layer is written once", async () => {
    const f = onboardingFile();
    const result: any = await PenforgeApi.updateAnimations({
        operations: [
            { op: "set", nodeId: f.button.id, states: { press: { scale: 0.97, duration: 100 } } },
            { op: "update", nodeId: f.button.id, states: { hover: { scale: 1.03 } } },
            { op: "set", nodeId: f.screen.id, entrance: { effects: [{ type: "fade" }], duration: 250 } },
        ],
    });
    assert.deepEqual(
        result.results.map((r: any) => [r.name, r.status]),
        [
            ["Get Started Button", "set"],
            ["Onboarding", "set"],
        ]
    );
    assert.equal(f.button.writes.length, 1);
    assert.deepEqual(stored(f.button), {
        v: 1,
        states: { press: { scale: 0.97, duration: 100 }, hover: { scale: 1.03 } },
    });
});

test("update merges fields, null removes a field or a section, and set replaces", async () => {
    const f = onboardingFile();
    withPluginData(f.list, { v: 1, entrance: fadeUp, loop: { type: "pulse" } });
    await PenforgeApi.updateAnimations({
        operations: [{ op: "update", nodeId: f.list.id, entrance: { duration: 400, stagger: null }, loop: null }],
    });
    assert.deepEqual(stored(f.list), {
        v: 1,
        entrance: { effects: fadeUp.effects, duration: 400, easing: "ease-out" },
    });

    await PenforgeApi.updateAnimations({
        operations: [
            { op: "set", nodeId: f.list.id, entrance: { effects: [{ type: "scale", from: 0.9 }], duration: 200 } },
        ],
    });
    assert.deepEqual(stored(f.list), { v: 1, entrance: { effects: [{ type: "scale", from: 0.9 }], duration: 200 } });
});

test("an unchanged spec is reported and not written", async () => {
    const f = onboardingFile();
    withPluginData(f.list, { v: 1, entrance: fadeUp });
    const result: any = await PenforgeApi.updateAnimations({
        operations: [{ op: "set", nodeId: f.list.id, entrance: fadeUp }],
    });
    assert.equal(result.results[0].status, "unchanged");
    assert.equal(f.list.writes.length, 0);
});

test("remove drops listed parts or the whole spec", async () => {
    const f = onboardingFile();
    withPluginData(f.button, {
        v: 1,
        entrance: { effects: [{ type: "fade" }], duration: 200 },
        states: { hover: { scale: 1.05 }, press: { scale: 0.95 } },
    });
    await PenforgeApi.updateAnimations({ operations: [{ op: "remove", nodeId: f.button.id, sections: ["hover"] }] });
    assert.deepEqual(stored(f.button), {
        v: 1,
        entrance: { effects: [{ type: "fade" }], duration: 200 },
        states: { press: { scale: 0.95 } },
    });
    await PenforgeApi.updateAnimations({ operations: [{ op: "remove", nodeId: f.button.id, sections: ["press"] }] });
    assert.deepEqual(stored(f.button), { v: 1, entrance: { effects: [{ type: "fade" }], duration: 200 } });

    const result: any = await PenforgeApi.updateAnimations({ operations: [{ op: "remove", nodeId: f.button.id }] });
    assert.equal(result.results[0].status, "removed");
    assert.equal(result.results[0].animations, null);
    assert.equal(stored(f.button), null);
});

test("an invalid spec is refused before any change", async () => {
    const f = onboardingFile();
    await assert.rejects(
        PenforgeApi.updateAnimations({
            operations: [
                { op: "set", nodeId: f.button.id, states: { hover: { scale: 1.05 } } },
                { op: "set", nodeId: f.list.id, entrance: { effects: [{ type: "wobble" }], duration: 300 } },
            ],
        }),
        /operations\[1\] \(Card List\): \$\.entrance\.effects\[0\]\.type/
    );
    await assert.rejects(
        PenforgeApi.updateAnimations({ operations: [{ op: "set", nodeId: f.list.id, entrance: { effects: [] } }] }),
        /\$\.entrance\.duration: required/
    );
    assert.equal(f.button.writes.length, 0);
    assert.equal(f.list.writes.length, 0);
    assert.ok(!f.api.calls.includes("undoBlockBegin"));
});

test("operations that do not fit the tool are refused", () => {
    const cases: [unknown, RegExp][] = [
        [[], /non-empty array/],
        [[{ op: "animate", nodeId: "a" }], /op must be one of/],
        [[{ op: "set", nodeId: "a" }], /at least one of/],
        [[{ op: "set", nodeId: "a", entrance: "fade" }], /entrance must be an object or null/],
        [[{ op: "set", nodeId: "a", hover: { scale: 1 } }], /hover: unknown key/],
        [[{ op: "remove", nodeId: "a", sections: ["glow"] }], /sections items/],
        [[{ op: "set-smart", nodeId: "a", index: -1 }], /index must be an integer/],
        [[{ op: "set", entrance: {} }], /nodeId/],
    ];
    for (const [operations, expected] of cases) {
        assert.throws(() => AnimationWriter.validate(operations), expected, JSON.stringify(operations));
    }
});

test("nodes on two pages are refused", async () => {
    const f = onboardingFile();
    const elsewhere = f.page0.root.children[0];
    await assert.rejects(
        PenforgeApi.updateAnimations({
            operations: [
                { op: "set", nodeId: f.list.id, entrance: fadeUp },
                { op: "set", nodeId: elsewhere.id, loop: { type: "spin" } },
            ],
        }),
        /is not on page "App"/
    );
    assert.equal(f.list.writes.length, 0);
});

test("set-smart needs a link to a board and stores its destination", async () => {
    const f = onboardingFile();
    await assert.rejects(
        PenforgeApi.updateAnimations({ operations: [{ op: "set-smart", nodeId: f.button.id, index: 0 }] }),
        /has no interaction at index 0/
    );
    f.button.addInteraction("click", { type: "open-url", url: "https://example.com" });
    f.button.addInteraction("click", { type: "navigate-to", destination: f.home });
    await assert.rejects(
        PenforgeApi.updateAnimations({ operations: [{ op: "set-smart", nodeId: f.button.id, index: 0 }] }),
        /smart animate needs one of/
    );
    await PenforgeApi.updateAnimations({
        operations: [{ op: "set-smart", nodeId: f.button.id, index: 1, duration: 350, easing: "ease-in-out" }],
    });
    assert.deepEqual(stored(f.button), {
        v: 1,
        smart: [{ index: 1, destination: f.home.id, duration: 350, easing: "ease-in-out" }],
    });

    const read: any = PenforgeApi.getAnimations({ nodeIds: [f.button.id] });
    assert.deepEqual(read.layers[0].smart, [
        {
            index: 1,
            trigger: "click",
            actionType: "navigate-to",
            destinationId: f.home.id,
            destinationName: "Home",
            duration: 350,
            easing: "ease-in-out",
        },
    ]);

    await PenforgeApi.updateAnimations({ operations: [{ op: "remove-smart", nodeId: f.button.id, index: 1 }] });
    assert.equal(stored(f.button), null);
});

test("warnings name parts the players ignore", async () => {
    const f = onboardingFile();
    const result: any = await PenforgeApi.updateAnimations({
        operations: [
            { op: "set", nodeId: f.button.id, entrance: { ...fadeUp } },
            { op: "set", nodeId: f.label.id, states: { hover: { fill: "#ff0000" } } },
        ],
    });
    assert.match(result.results[0].warnings[0], /stagger .* has none/);
    assert.match(result.results[1].warnings[0], /text layers ignore states\.fill/);
});

test("getAnimations lists a node's animated layers with their screen and code hints", async () => {
    const f = onboardingFile();
    withPluginData(f.list, { v: 1, entrance: fadeUp });
    withPluginData(f.cards[1], { v: 1, states: { hover: { scale: 1.02 } } });
    withPluginData(f.button, { v: 1, loop: { type: "pulse" } });

    const byNode: any = PenforgeApi.getAnimations({ nodeIds: [f.list.id] });
    assert.equal(byNode.count, 2);
    assert.deepEqual(
        byNode.layers.map((l: any) => [l.name, l.path, l.boardId, l.boardName, l.codeName, l.childCount]),
        [
            ["Card List", "Card List", f.screen.id, "Onboarding", "cardList", 3],
            ["Card 2", "Card List/Card 2", f.screen.id, "Onboarding", "card2", 1],
        ]
    );

    const byBoard: any = PenforgeApi.getAnimations({ boardId: f.screen.id });
    assert.equal(byBoard.pageId, f.page.id);
    assert.deepEqual(
        byBoard.layers.map((l: any) => l.name),
        ["Card List", "Card 2", "Get Started Button"]
    );

    // no arguments: the current page, which has no animations
    assert.deepEqual(PenforgeApi.getAnimations({}), { pageId: f.page0.id, layers: [], count: 0 });
    assert.equal((PenforgeApi.getAnimations({ pageId: f.page.id }) as any).count, 3);
});

test("getAnimationSpec returns the file's screens and animated layers in a stable order", () => {
    const f = onboardingFile();
    withPluginData(f.list, { v: 1, entrance: fadeUp });
    withPluginData(f.button, { v: 1, states: { press: { scale: 0.96 } } });
    f.button.component = () => ({ id: "comp-1", name: "Button / Primary" });

    const spec: any = PenforgeApi.getAnimationSpec();
    assert.deepEqual(spec, {
        version: 1,
        fileId: "file-1",
        fileName: "Todo",
        layerCount: 2,
        pages: [
            {
                pageId: f.page.id,
                pageName: "App",
                boards: [
                    {
                        boardId: f.screen.id,
                        boardName: "Onboarding",
                        componentName: "Onboarding",
                        layers: [
                            {
                                nodeId: f.list.id,
                                name: "Card List",
                                type: "board",
                                path: "Card List",
                                parentId: f.screen.id,
                                codeName: "cardList",
                                component: null,
                                childCount: 3,
                                animations: { v: 1, entrance: fadeUp },
                            },
                            {
                                nodeId: f.button.id,
                                name: "Get Started Button",
                                type: "rectangle",
                                path: "Get Started Button",
                                parentId: f.screen.id,
                                codeName: "getStartedButton",
                                component: { id: "comp-1", name: "Button / Primary" },
                                childCount: 0,
                                animations: { v: 1, states: { press: { scale: 0.96 } } },
                            },
                        ],
                    },
                ],
                otherLayers: [],
            },
        ],
    });
    assert.deepEqual(PenforgeApi.getAnimationSpec(), spec);
});

test("code name hints", () => {
    assert.equal(AnimationExporter.camelCase("Sign In Button"), "signInButton");
    assert.equal(AnimationExporter.camelCase("taskCard"), "taskCard");
    assert.equal(AnimationExporter.camelCase("2 Columns"), "layer2Columns");
    assert.equal(AnimationExporter.camelCase("✨"), "layer");
    assert.equal(AnimationExporter.pascalCase("order summary"), "OrderSummary");
    assert.equal(AnimationExporter.pascalCase("iPhone 15 - Home"), "IPhone15Home");
    assert.equal(AnimationExporter.pascalCase(""), "Screen");
});
