import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowClaudeRequest, WorkflowContext, WorkflowEventKind, WorkflowToolResult } from "@penpot/mcp-common";
import type { CleanupResult } from "../cleanup";
import { FakePenpot } from "../cleanup/testing/FakePenpot";
import { cardListScene } from "../cleanup/testing/scenes";
import { ImportCleaner, describeCleanup, type CleanupParams } from "./cleanup-import";

interface Harness {
    ctx: WorkflowContext;
    events: { kind: WorkflowEventKind; payload: any }[];
    requests: WorkflowClaudeRequest[];
    /** distorts the screenshot when it returns true */
    distort: { when: ((penpot: FakePenpot) => boolean) | null };
}

/** Workflow context whose `execute_code` runs on a fake canvas. */
function harness(penpot: FakePenpot, answer = "{}"): Harness {
    const events: Harness["events"] = [];
    const requests: WorkflowClaudeRequest[] = [];
    const distort: Harness["distort"] = { when: null };
    const ok = (text: string, content: unknown[] = [{ type: "text", text }]): WorkflowToolResult => ({
        isError: false,
        text,
        content,
    });
    const ctx = {
        runId: "run-1",
        context: {
            fileId: "f",
            fileName: "File",
            projectId: "p",
            teamId: "t",
            pageId: penpot.page.id,
            persona: "designer",
            platform: "web",
        },
        signal: new AbortController().signal,
        emit: (kind: WorkflowEventKind, payload: unknown) => events.push({ kind, payload }),
        ask: async () => "ok",
        runner: {
            run: async (request: WorkflowClaudeRequest) => {
                requests.push(request);
                return { text: request.promptName === "cleanup-import" ? answer : "{}" };
            },
        },
        tools: {
            list: async () => ["execute_code", "capture_node_screenshot"],
            call: async (name: string, args: Record<string, unknown> = {}): Promise<WorkflowToolResult> => {
                if (name === "execute_code") {
                    try {
                        const value = await penpot.execute(String(args.code));
                        return ok(JSON.stringify({ result: value }));
                    } catch (error) {
                        return { isError: true, text: String(error), content: [] };
                    }
                }
                if (name === "capture_node_screenshot") {
                    const id = String(args.nodeId);
                    let data = await penpot.render(id, Number(args.scale ?? 1));
                    if (distort.when?.(penpot)) {
                        const shape = penpot.page.getShapeById(id)!;
                        const saved = shape.fills;
                        shape.fills = [{ fillColor: "#123456", fillOpacity: 1 }];
                        data = await penpot.render(id, Number(args.scale ?? 1));
                        shape.fills = saved;
                    }
                    return ok("{}", [{ type: "image", data, mimeType: "image/png" }]);
                }
                return { isError: true, text: `unknown tool ${name}`, content: [] };
            },
        },
    } as unknown as WorkflowContext;
    return { ctx, events, requests, distort };
}

async function run(h: Harness, params: CleanupParams): Promise<CleanupResult> {
    return new ImportCleaner(h.ctx, params, { settleMs: 0 }).run();
}

describe("cleanup-import workflow", () => {
    it("turns an absolute card list into a flex column of component copies, unchanged on screen", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const before = await penpot.render(scene.screen.id);
        const h = harness(penpot, '{"skip": [], "names": {"C1": "Task Card"}, "notes": ""}');
        const result = await run(h, { steps: { names: false } });

        assert.equal(result.totals.junk, 3);
        assert.equal(result.totals.layouts, 4);
        assert.equal(result.totals.layoutsReverted, 0);
        assert.equal(result.totals.components, 1);
        assert.equal(result.totals.instances, 3);
        assert.equal(result.components[0].name, "Task Card");
        assert.equal(await penpot.render(scene.screen.id), before);
        assert.equal(penpot.openBlocks, 0);

        const list = scene.screen.items.find((shape) => shape.name === "Board")!;
        assert.equal(list.type, "board");
        assert.equal(list.flex?.dir, "column");
        assert.equal(list.flex?.rowGap, 20);
        const cards = list.children;
        assert.equal(cards.length, 3, "hidden members and backups are gone");
        assert.ok(cards[0].isComponentMainInstance());
        assert.ok(cards[1].isComponentCopyInstance() && cards[2].isComponentCopyInstance());
        assert.deepEqual(
            cards.map((card) => card.all().find((shape) => shape.name === "Title")?.characters),
            ["Buy milk", "Call Ana", "Book flights"]
        );
        assert.deepEqual(
            scene.screen.items.map((shape) => shape.name),
            ["Board"],
            "junk removed; the default-named group became a board named Board"
        );
        // the review got the proposals and a screenshot, with no tools
        const review = h.requests.find((request) => request.promptName === "cleanup-import")!;
        assert.match(review.prompt, /"kind":"component"/);
        assert.equal(review.attachments?.length, 1);
        assert.ok(review.toolFilter?.check("mcp__penpot__execute_code", {}));
        assert.match(describeCleanup(result), /Removed 3 unused layers, added 4 layouts, made 1 components/);
        const steps = h.events.filter((event) => event.kind === "progress").map((event) => event.payload.step);
        assert.deepEqual([...new Set(steps)], ["scan", "checkpoint", "review", "junk", "layout", "components"]);
    });

    it("skips what the review rejects", async () => {
        const scene = cardListScene();
        const h = harness(scene.penpot, '{"skip": ["J1", "C1", "L4"]}');
        const result = await run(h, { steps: { names: false } });
        assert.equal(result.totals.junk, 2);
        assert.equal(result.totals.layouts, 3);
        assert.equal(result.totals.components, 0);
        assert.ok(scene.hidden.parent, "hidden layer kept");
        assert.deepEqual(result.skipped.sort(), ["C1", "J1", "L4"]);
    });

    it("takes layouts back when the screenshot changes, and leaves the design as it was", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const h = harness(penpot);
        h.distort.when = (p) => p.page.root.all().some((shape) => shape.flex !== null);
        const result = await run(h, { review: false, steps: { names: false, components: false, junk: false } });
        assert.equal(result.totals.layouts, 0);
        assert.equal(result.totals.layoutsReverted, 4);
        assert.ok(penpot.page.root.all().every((shape) => !shape.flex));
        const list = scene.screen.items.find((shape) => shape.name === "Group 4")!;
        assert.equal(list.type, "group");
        assert.deepEqual(
            list.items.map((card) => [card.type, card.name, card.y]),
            [
                ["group", "Group 1", 100],
                ["group", "Group 2", 220],
                ["group", "Group 3", 340],
            ]
        );
        assert.ok(h.events.some((event) => event.kind === "log" && event.payload.code === "reverted"));
        assert.equal(penpot.openBlocks, 0);
    });

    it("keeps the layouts that pass when only some change the screenshot", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const h = harness(penpot);
        // only the list's own layout distorts the picture
        h.distort.when = (p) =>
            p.page.root.all().some((shape) => shape.flex !== null && shape.parent?.id === scene.screen.id);
        const result = await run(h, { review: false, steps: { names: false, components: false, junk: false } });
        assert.equal(result.totals.layouts, 3);
        assert.equal(result.totals.layoutsReverted, 1);
        const list = scene.screen.items.find((shape) => shape.name === "Group 4")!;
        assert.equal(list.type, "group");
        assert.ok(list.items.every((card) => card.type === "board" && card.flex?.dir === "column"));
    });

    it("reports proposals without changing anything in a dry run", async () => {
        const scene = cardListScene();
        const h = harness(scene.penpot);
        const result = await run(h, { dryRun: true });
        assert.equal(result.dryRun, true);
        assert.equal(result.proposals?.length, 8);
        assert.equal(scene.penpot.undoBlocks, 0);
        assert.equal(h.requests.length, 0);
        assert.match(describeCleanup(result), /8 possible changes/);
    });

    it("runs auto-naming last and needs a selection in selection scope", async () => {
        const scene = cardListScene();
        const h = harness(scene.penpot);
        await assert.rejects(run(h, { scope: "selection", nodeIds: [] }), /cleanup\/no-selection/);
        const result = await run(h, { nodeIds: [scene.cards[0].id], review: false });
        assert.equal(result.totals.layouts, 1);
        assert.ok(h.requests.some((request) => request.promptName === "auto-name"));
    });

    it("reads Claude's review answer defensively", () => {
        const proposals = [
            { id: "J1", kind: "junk" as const, unitId: "u", nodeId: "n", name: "x", reason: "hidden" as const },
        ];
        const review = ImportCleaner.parseReview(
            'Sure: {"skip": ["J1", "X9"], "names": {"J1": "A/B"}, "notes": " ok "}',
            proposals
        );
        assert.deepEqual([...review.skip], ["J1"]);
        assert.equal(review.names.get("J1"), "A B");
        assert.equal(review.notes, "ok");
        assert.equal(ImportCleaner.parseReview("no json", proposals).skip.size, 0);
        assert.equal(ImportCleaner.componentName("Frame 12"), "Item");
        assert.equal(ImportCleaner.componentName("Task Card"), "Task Card");
    });
});
