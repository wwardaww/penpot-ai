import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { CleanupHeuristics, CleanupScripts, PixelDiff, type Box, type CleanupNode, type CleanupScan } from "./index";
import { FakePenpot, FakeShape } from "./testing/FakePenpot";
import { cardListScene } from "./testing/scenes";

/** Reads a scan of the fake page through the real plan and read scripts. */
async function scanOf(penpot: FakePenpot, nodeIds: string[] = []): Promise<CleanupScan> {
    const plan = JSON.parse(
        (await penpot.execute(CleanupScripts.plan({ pageId: penpot.page.id, nodeIds }))) as string
    ) as { pageId: string; pageName: string; units: { id: string }[]; scopeRoots: string[]; commented: string[] };
    const nodes = new Map<string, CleanupNode>();
    for (const unit of plan.units) {
        const data = JSON.parse(
            (await penpot.execute(CleanupScripts.read({ pageId: plan.pageId, unitId: unit.id }))) as string
        ) as { nodes: CleanupNode[] };
        data.nodes.forEach((node) => nodes.set(node.id, node));
    }
    const scope = new Set<string>();
    const add = (id: string) => {
        scope.add(id);
        nodes.get(id)?.children.forEach(add);
    };
    (nodeIds.length > 0 ? plan.scopeRoots : plan.units.map((unit) => unit.id)).forEach(add);
    return {
        pageId: plan.pageId,
        pageName: plan.pageName,
        units: plan.units.map((unit) => unit.id),
        nodes,
        scope,
        truncated: false,
        commented: new Set(plan.commented),
    };
}

const box = (id: string, x: number, y: number, width: number, height: number): Box => ({ id, x, y, width, height });

describe("CleanupHeuristics.stack", () => {
    it("finds a column with equal gaps and start alignment", () => {
        const match = CleanupHeuristics.stack([
            box("b", 10, 60, 100, 30),
            box("a", 10, 10, 80, 30),
            box("c", 10.4, 110.6, 50, 30),
        ]);
        assert.deepEqual(match, { dir: "column", gap: 20.3, align: "start", order: ["a", "b", "c"] });
    });

    it("finds a centered row", () => {
        const match = CleanupHeuristics.stack([
            box("a", 0, 10, 40, 40),
            box("b", 50, 20, 40, 20),
            box("c", 100, 0, 40, 60),
        ]);
        assert.equal(match?.dir, "row");
        assert.equal(match?.align, "center");
        assert.equal(match?.gap, 10);
    });

    it("refuses unequal gaps, overlaps and mixed alignment", () => {
        assert.equal(
            CleanupHeuristics.stack([box("a", 0, 0, 10, 10), box("b", 0, 20, 10, 10), box("c", 0, 50, 10, 10)]),
            null
        );
        assert.equal(CleanupHeuristics.stack([box("a", 0, 0, 10, 10), box("b", 5, 5, 10, 10)]), null);
        assert.equal(
            CleanupHeuristics.stack([box("a", 0, 0, 10, 10), box("b", 3, 20, 20, 10), box("c", 9, 40, 30, 10)]),
            null
        );
    });

    it("computes paddings that keep the children in place", () => {
        const container = box("p", 0, 0, 200, 100);
        const boxes = [box("a", 20, 30, 40, 20), box("b", 70, 30, 40, 20)];
        const match = CleanupHeuristics.stack(boxes)!;
        assert.deepEqual(CleanupHeuristics.stackPadding(container, boxes, match), {
            top: 30,
            right: 90,
            bottom: 50,
            left: 20,
        });
        const centered = [box("a", 0, 10, 40, 40), box("b", 50, 20, 40, 20)];
        const c = CleanupHeuristics.stack(centered)!;
        // center 30 in a 100 high container: top - bottom = 2 * 30 - 100
        assert.deepEqual(CleanupHeuristics.stackPadding(box("p", 0, 0, 90, 100), centered, c), {
            top: 0,
            right: 0,
            bottom: 40,
            left: 0,
        });
    });
});

describe("CleanupHeuristics.grid", () => {
    it("finds a 3 x 2 grid with a partial last row", () => {
        const boxes = [
            box("a", 0, 0, 50, 40),
            box("b", 60, 0, 50, 40),
            box("c", 120, 0, 50, 40),
            box("d", 0, 50, 50, 40),
            box("e", 60, 50, 50, 40),
        ];
        const grid = CleanupHeuristics.grid(boxes)!;
        assert.deepEqual(grid.columns, [50, 50, 50]);
        assert.deepEqual(grid.rows, [40, 40]);
        assert.equal(grid.columnGap, 10);
        assert.equal(grid.rowGap, 10);
        assert.deepEqual(
            grid.cells.find((cell) => cell.id === "e"),
            { id: "e", row: 2, column: 2 }
        );
        assert.deepEqual(CleanupHeuristics.gridPadding(box("p", -10, -10, 200, 120), grid), {
            top: 10,
            left: 10,
            right: 20,
            bottom: 20,
        });
    });

    it("refuses holes before the last row and unequal gaps", () => {
        const holes = [
            box("a", 0, 0, 50, 40),
            box("c", 120, 0, 50, 40),
            box("d", 0, 50, 50, 40),
            box("e", 60, 50, 50, 40),
        ];
        assert.equal(CleanupHeuristics.grid([...holes, box("x", 0, 100, 50, 40)]), null);
        const uneven = [
            box("a", 0, 0, 50, 40),
            box("b", 60, 0, 50, 40),
            box("c", 0, 50, 50, 40),
            box("d", 75, 50, 50, 40),
        ];
        assert.equal(CleanupHeuristics.grid(uneven), null);
    });
});

describe("CleanupHeuristics on a scanned page", () => {
    it("lists hidden, empty and zero-size layers as junk", async () => {
        const scene = cardListScene();
        const heuristics = new CleanupHeuristics(await scanOf(scene.penpot));
        const junk = heuristics.junk();
        assert.deepEqual(
            junk.map((item) => [item.nodeId, item.reason]),
            [
                [scene.hidden.id, "hidden"],
                [scene.emptyGroup.id, "empty-group"],
                [scene.zeroSize.id, "zero-size"],
            ]
        );
    });

    it("proposes a flex column for the list and each card, deepest first, background absolute", async () => {
        const scene = cardListScene();
        const heuristics = new CleanupHeuristics(await scanOf(scene.penpot));
        const junkIds = new Set(heuristics.junk().map((item) => item.nodeId));
        const layouts = heuristics.layouts(junkIds);
        assert.equal(layouts.length, 4);
        const list = layouts.find((item) => item.nodeId === scene.list.id)!;
        assert.equal(layouts.indexOf(list), 3, "outer container comes last");
        assert.equal(list.convert, true);
        assert.equal(list.sizing, "auto");
        assert.deepEqual(list.layout, {
            type: "flex",
            dir: "column",
            gap: 20,
            align: "start",
            order: scene.cards.map((card) => card.id),
            padding: { top: 0, right: 0, bottom: 0, left: 0 },
        });
        const card = layouts.find((item) => item.nodeId === scene.cards[0].id)!;
        assert.deepEqual(card.absoluteBelow, [scene.cards[0].items[0].id]);
        assert.equal(card.layout.type, "flex");
        assert.deepEqual(card.layout.type === "flex" && card.layout.padding, {
            top: 16,
            right: 144,
            bottom: 40,
            left: 16,
        });
    });

    it("groups look-alike cards whose texts differ, outer items first", async () => {
        const scene = cardListScene();
        const components = new CleanupHeuristics(await scanOf(scene.penpot)).components();
        assert.equal(components.length, 1);
        assert.deepEqual(
            components[0].memberIds,
            scene.cards.map((card) => card.id)
        );
        assert.equal(components[0].name, "Group 1");
    });

    it("keeps different-looking items apart and skips component copies", async () => {
        const scene = cardListScene();
        scene.cards[2].items[0].fills = [{ fillColor: "#00FF00", fillOpacity: 1 }];
        const heuristics = new CleanupHeuristics(await scanOf(scene.penpot));
        // two look-alikes left; groups of 3 layers need only 2
        assert.deepEqual(heuristics.components()[0].memberIds, [scene.cards[0].id, scene.cards[1].id]);
        scene.cards[0].copyHead = true;
        scene.cards[0].copyOf = scene.penpot.components[0] ?? ({} as never);
        const again = new CleanupHeuristics(await scanOf(scene.penpot));
        assert.equal(again.components().length, 0);
        assert.equal(again.junk().length, 3);
    });

    it("never makes components of items with their own links, exports, comments or mixed texts", async () => {
        for (const mark of [
            (s: ReturnType<typeof cardListScene>) => (s.cards[1].items[1].interactions = [{ trigger: "click" }]),
            (s: ReturnType<typeof cardListScene>) => (s.cards[2].items[2].exports = [{ type: "png" }]),
            (s: ReturnType<typeof cardListScene>) =>
                s.penpot.page.threads.push({ board: null, nodeId: s.cards[0].items[1].id }),
            (s: ReturnType<typeof cardListScene>) => (s.cards[1].items[1].fontSize = "mixed"),
        ]) {
            const scene = cardListScene();
            mark(scene);
            const components = new CleanupHeuristics(await scanOf(scene.penpot)).components();
            // the marked card is left out; the two others still match
            assert.equal(components.length, 1);
            assert.equal(components[0].memberIds.length, 2);
        }
    });

    it("keeps hidden layers with content, links or comments, and lists every hidden layer", async () => {
        const scene = cardListScene();
        const state = new FakeShape("group", "Error state", 0, 0, 100, 40).add(
            new FakeShape("text", "Error", 0, 0, 100, 40)
        );
        state.visible = false;
        scene.screen.add(state);
        const linked = new FakeShape("rectangle", "Hover", 0, 0, 10, 10);
        linked.visible = false;
        linked.interactions = [{ trigger: "click" }];
        scene.screen.add(linked);
        const heuristics = new CleanupHeuristics(await scanOf(scene.penpot));
        const junk = heuristics.junk();
        assert.deepEqual(
            junk.filter((item) => item.reason === "hidden").map((item) => item.nodeId),
            [scene.hidden.id]
        );
        assert.equal(junk[0].id, `J:${scene.hidden.id}`);
        assert.deepEqual(
            heuristics
                .hiddenLayers()
                .map((node) => node.name)
                .sort(),
            ["Error state", "Hover", "Old header"]
        );
        scene.penpot.page.threads.push({ board: null, nodeId: scene.emptyGroup.id });
        const again = new CleanupHeuristics(await scanOf(scene.penpot)).junk();
        assert.ok(!again.some((item) => item.nodeId === scene.emptyGroup.id), "commented layer kept");
    });

    it("leaves containers with pinned children or exports alone", async () => {
        const scene = cardListScene();
        scene.cards[0].items[1].constraintsHorizontal = "right";
        scene.list.exports = [{ type: "png" }];
        const heuristics = new CleanupHeuristics(await scanOf(scene.penpot));
        const ids = heuristics.layouts().map((item) => item.nodeId);
        assert.ok(!ids.includes(scene.cards[0].id));
        assert.ok(!ids.includes(scene.list.id));
        assert.ok(ids.includes(scene.cards[1].id));
        assert.ok(CleanupHeuristics.pinned("left/bottom") && !CleanupHeuristics.pinned("scale/top"));
    });

    it("limits the scope to the selection", async () => {
        const scene = cardListScene();
        const heuristics = new CleanupHeuristics(await scanOf(scene.penpot, [scene.cards[1].id]));
        assert.equal(heuristics.junk().length, 0);
        assert.deepEqual(
            heuristics.layouts().map((item) => item.nodeId),
            [scene.cards[1].id]
        );
        assert.equal(heuristics.components().length, 0);
    });
});

describe("CleanupScripts", () => {
    it("every script compiles as an execute_code body", () => {
        const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
        const scripts = [
            CleanupScripts.plan({ pageId: null, nodeIds: [] }),
            CleanupScripts.read({ pageId: "p", unitId: "u" }),
            CleanupScripts.junkHide("p", []),
            CleanupScripts.junkFinish("p", [], []),
            CleanupScripts.closeStep(),
            CleanupScripts.applyLayouts("p", [], {}),
            CleanupScripts.revertLayouts("p", [], {}),
            CleanupScripts.applyComponent(
                "p",
                { id: "C:x", kind: "component", memberIds: [], unitIds: [], name: "", width: 1, height: 1, size: 1 },
                "Card",
                "run:1"
            ),
            CleanupScripts.recoverComponent("p", "run:1", []),
            CleanupScripts.keepComponent("p", [], []),
            CleanupScripts.revertComponent("p", { componentId: null, backupId: null, pairs: [] }),
        ];
        for (const script of scripts) {
            assert.doesNotThrow(() => new AsyncFunction("penpot", "storage", script));
        }
    });

    it("applies and reverts layouts, turning groups into boards and back", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const before = await penpot.render(scene.screen.id);
        const heuristics = new CleanupHeuristics(await scanOf(penpot));
        const layouts = heuristics.layouts(new Set(heuristics.junk().map((item) => item.nodeId)));
        const applied = JSON.parse(
            (await penpot.execute(CleanupScripts.applyLayouts(penpot.page.id, layouts, {}))) as string
        );
        assert.ok(
            applied.results.every((result: { ok: boolean }) => result.ok),
            JSON.stringify(applied.results)
        );
        assert.equal(penpot.openBlocks, 0);
        const listBoard = penpot.page.getShapeById(applied.remap[scene.list.id])!;
        assert.equal(listBoard.type, "board");
        assert.equal(listBoard.name, "Group 4");
        assert.equal(listBoard.flex?.dir, "column");
        assert.equal(listBoard.flex?.rowGap, 20);
        assert.equal(listBoard.flex?.horizontalSizing, "auto");
        assert.deepEqual(listBoard.fills, []);
        assert.equal(penpot.page.getShapeById(scene.list.id), null);
        // visual order of the flex column = card order
        assert.deepEqual(
            listBoard.children.map((child) => child.name),
            ["Group 1", "Group 2", "Group 3"]
        );
        const card = penpot.page.getShapeById(applied.remap[scene.cards[0].id])!;
        assert.equal(card.flex?.topPadding, 16);
        assert.equal(card.items[0].name, "Rectangle", "background stays at the bottom");
        assert.equal(card.items[0].absolute, true);
        assert.deepEqual(card.children.map((child) => child.name).slice(0, 2), ["Title", "Subtitle"]);
        assert.equal(await penpot.render(scene.screen.id), before);

        const undos = applied.results.map((result: { undo: unknown }) => result.undo);
        const reverted = JSON.parse(
            (await penpot.execute(CleanupScripts.revertLayouts(penpot.page.id, undos, applied.remap))) as string
        );
        assert.equal(reverted.reverted, 4);
        assert.deepEqual(reverted.errors, []);
        const group = penpot.page.getShapeById(reverted.remap[scene.list.id])!;
        assert.equal(group.type, "group");
        assert.equal(group.name, "Group 4");
        assert.equal(group.parent?.id, scene.screen.id);
        assert.ok(penpot.page.root.all().every((shape) => !shape.flex));
        assert.equal(await penpot.render(scene.screen.id), before);
    });

    it("makes a component and copies that keep their texts, and takes it back", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const before = await penpot.render(scene.screen.id);
        const [proposal] = new CleanupHeuristics(await scanOf(penpot)).components();
        const step = JSON.parse(
            (await penpot.execute(
                CleanupScripts.applyComponent(penpot.page.id, proposal, "Task Card", "r:1")
            )) as string
        );
        assert.equal(penpot.openBlocks, 1, "the step's undo block stays open until keep or take back");
        assert.deepEqual(step.errors, []);
        assert.equal(step.pairs.length, 2);
        assert.equal(penpot.components[0].name, "Task Card");
        const copy = penpot.page.getShapeById(step.pairs[1].copyId)!;
        assert.equal(copy.parent?.id, scene.list.id);
        assert.equal(copy.y, 340);
        assert.equal(copy.all().find((shape) => shape.name === "Title")?.characters, "Book flights");
        assert.equal(await penpot.render(scene.screen.id), before);

        await penpot.execute(CleanupScripts.revertComponent(penpot.page.id, step));
        assert.equal(penpot.openBlocks, 0);
        assert.equal(penpot.undoBlocks, 1, "one undo block for the whole step");
        assert.equal(penpot.components.length, 0);
        assert.equal(penpot.page.getShapeById(step.pairs[0].copyId), null);
        assert.ok(scene.cards[1].visible && scene.cards[2].visible);
        assert.equal(await penpot.render(scene.screen.id), before);
    });

    it("takes a component step back by itself when it fails half way", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const before = await penpot.render(scene.screen.id);
        const shapes = penpot.page.root.all().length;
        const [proposal] = new CleanupHeuristics(await scanOf(penpot)).components();
        penpot.failInstanceAfter = 1;
        const step = JSON.parse(
            (await penpot.execute(CleanupScripts.applyComponent(penpot.page.id, proposal, "Card", "r:2"))) as string
        );
        assert.match(step.failed, /instance failed/);
        assert.equal(penpot.openBlocks, 0);
        assert.equal(penpot.components.length, 0);
        assert.equal(penpot.page.root.all().length, shapes, "the main is gone, its backup is back");
        assert.ok(scene.cards[1].visible && scene.cards[2].visible);
        assert.equal(await penpot.render(scene.screen.id), before);
    });

    it("recovers a component step whose script did not answer, by its marks", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const before = await penpot.render(scene.screen.id);
        const [proposal] = new CleanupHeuristics(await scanOf(penpot)).components();
        await penpot.execute(CleanupScripts.applyComponent(penpot.page.id, proposal, "Card", "r:3"));
        await penpot.execute(CleanupScripts.recoverComponent(penpot.page.id, "r:3", proposal.memberIds));
        assert.equal(penpot.openBlocks, 0);
        assert.equal(penpot.components.length, 0);
        assert.ok(penpot.page.root.all().every((shape) => shape.copyOf === null));
        assert.equal(await penpot.render(scene.screen.id), before);
    });
});

describe("PixelDiff", () => {
    const image = async (width: number, height: number, draw: (x: number, y: number) => number[]) => {
        const data = Buffer.alloc(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                data.set(draw(x, y), (y * width + x) * 4);
            }
        }
        return (
            await sharp(data, { raw: { width, height, channels: 4 } })
                .png()
                .toBuffer()
        ).toString("base64");
    };
    const square = (offset: number) => (x: number, y: number) =>
        x >= 10 + offset && x < 30 + offset && y >= 10 && y < 30 ? [0, 0, 0, 255] : [255, 255, 255, 255];

    it("scores identical images 0 and tolerates a one-pixel move", async () => {
        const a = await image(40, 40, square(0));
        assert.equal((await PixelDiff.compareBase64(a, a)).ratio, 0);
        assert.equal((await PixelDiff.compareBase64(a, await image(40, 40, square(1)))).ratio, 0);
    });

    it("counts real changes and different sizes", async () => {
        const a = await image(40, 40, square(0));
        const moved = await PixelDiff.compareBase64(a, await image(40, 40, square(5)));
        assert.ok(moved.ratio > 0.05, String(moved.ratio));
        const bigger = await PixelDiff.compareBase64(a, await image(50, 40, square(0)));
        assert.equal(bigger.ratio, 1);
        assert.equal(bigger.sameSize, false);
    });

    it("catches a small local shift on a tall image through its tiles", async () => {
        // a 20 x 20 square moved down 4 px on a 200 x 2000 image: little of the whole, much of a tile
        const tall = (dy: number) => (x: number, y: number) =>
            x >= 10 && x < 30 && y >= 1000 + dy && y < 1020 + dy ? [0, 0, 0, 255] : [255, 255, 255, 255];
        const score = await PixelDiff.compareBase64(await image(200, 2000, tall(0)), await image(200, 2000, tall(4)));
        assert.ok(score.ratio < 0.002, String(score.ratio));
        assert.ok(score.maxTile > PixelDiff.TILE_LIMIT, String(score.maxTile));
        assert.equal(PixelDiff.passes(score, 0.002), false);
    });
});
