import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
    WorkflowClaudeRequest,
    WorkflowContext,
    WorkflowEventKind,
    WorkflowQuestion,
    WorkflowToolResult,
} from "@penpot/mcp-common";
import { CleanupLock, type CleanupResult } from "../cleanup";
import { FakePenpot } from "../cleanup/testing/FakePenpot";
import { cardListScene } from "../cleanup/testing/scenes";
import { ImportCleaner, describeCleanup, type CleanupParams, type CleanupTuning } from "./cleanup-import";

interface Harness {
    ctx: WorkflowContext;
    events: { kind: WorkflowEventKind; payload: any }[];
    requests: WorkflowClaudeRequest[];
    questions: WorkflowQuestion[];
    /** answer to the hidden-layers question */
    answer: { value: string };
    /** distorts the screenshot when it returns true */
    distort: { when: ((penpot: FakePenpot) => boolean) | null };
    checkpoints: string[];
    abort: AbortController;
}

let fileCounter = 0;

/** Workflow context whose `execute_code` runs on a fake canvas. */
function harness(penpot: FakePenpot, answer = "{}"): Harness {
    const events: Harness["events"] = [];
    const requests: WorkflowClaudeRequest[] = [];
    const questions: WorkflowQuestion[] = [];
    const distort: Harness["distort"] = { when: null };
    const reply = { value: "keep" };
    const abort = new AbortController();
    const ok = (text: string, content: unknown[] = [{ type: "text", text }]): WorkflowToolResult => ({
        isError: false,
        text,
        content,
    });
    const ctx = {
        runId: "run-1",
        context: {
            fileId: `file-${++fileCounter}`,
            fileName: "File",
            projectId: "p",
            teamId: "t",
            pageId: penpot.page.id,
            persona: "designer",
            platform: "web",
        },
        signal: abort.signal,
        emit: (kind: WorkflowEventKind, payload: unknown) => events.push({ kind, payload }),
        ask: async (question: WorkflowQuestion) => {
            questions.push(question);
            return reply.value;
        },
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
    return { ctx, events, requests, questions, answer: reply, distort, checkpoints: [], abort };
}

async function run(h: Harness, params: CleanupParams, tuning: CleanupTuning = {}): Promise<CleanupResult> {
    return new ImportCleaner(h.ctx, params, {
        settleMs: 0,
        checkpoint: async (_ctx, label) => {
            h.checkpoints.push(label);
            return { id: `cp-${h.checkpoints.length}`, n: h.checkpoints.length };
        },
        ...tuning,
    }).run();
}

describe("cleanup-import workflow", () => {
    it("turns an absolute card list into a flex column of component copies, unchanged on screen", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const before = await penpot.render(scene.screen.id);
        const h = harness(penpot, `{"skip": [], "names": {"C:${scene.cards[0].id}": "Task Card"}, "notes": ""}`);
        const result = await run(h, { steps: { names: false } });

        assert.deepEqual(h.checkpoints, ["Before tidying up Page 1"]);
        assert.equal(result.checkpoint?.n, 1);
        assert.equal(result.totals.junk, 2, "empty group and zero-size layer; the hidden one is kept");
        assert.deepEqual(result.hidden, { count: 1, removed: 0, names: ["Old header"] });
        assert.equal(h.questions.length, 1, "the user was asked about the hidden layer");
        assert.ok(scene.hidden.parent, "hidden layer kept");
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
        assert.ok(cards.every((card) => card.getSharedPluginData("penforge", "cleanupStep") === ""));
        assert.deepEqual(
            scene.screen.items.map((shape) => shape.name),
            ["Old header", "Board"]
        );
        const review = h.requests.find((request) => request.promptName === "cleanup-import")!;
        assert.match(review.prompt, /"kind":"component"/);
        assert.equal(review.attachments?.length, 1);
        assert.ok(review.toolFilter?.check("mcp__penpot__execute_code", {}));
        assert.match(describeCleanup(result), /Removed 2 unused layers, added 4 layouts, made 1 components/);
        assert.match(describeCleanup(result), /kept 1 hidden layers/);
        const steps = h.events.filter((event) => event.kind === "progress").map((event) => event.payload.step);
        assert.deepEqual([...new Set(steps)], ["scan", "review", "checkpoint", "junk", "layout", "components"]);
    });

    it("deletes hidden layers only when the user says so", async () => {
        const scene = cardListScene();
        const h = harness(scene.penpot);
        h.answer.value = "delete";
        const result = await run(h, { review: false, steps: { names: false, layouts: false, components: false } });
        assert.equal(result.totals.junk, 3);
        assert.equal(result.hidden.removed, 1);
        assert.equal(scene.hidden.parent, null);
        const plan = h.events.find((event) => event.kind === "plan");
        assert.deepEqual(plan?.payload, { code: "hidden", count: 1, names: ["Old header"] });
        // with the param set, nobody is asked
        const other = cardListScene();
        const h2 = harness(other.penpot);
        await run(h2, { review: false, removeHidden: false, steps: { names: false } });
        assert.equal(h2.questions.length, 0);
        assert.ok(other.hidden.parent);
    });

    it("changes nothing when the checkpoint cannot be saved", async () => {
        const scene = cardListScene();
        const before = await scene.penpot.render(scene.screen.id);
        const h = harness(scene.penpot);
        await assert.rejects(
            run(h, { review: false, removeHidden: false }, { checkpoint: async () => null }),
            /cleanup\/checkpoint-failed/
        );
        await assert.rejects(
            run(h, { review: false, removeHidden: false }, { checkpoint: ImportCleaner.designCheckpoint }),
            /cleanup\/checkpoint-failed: the file is not in a Penforge project/
        );
        assert.equal(scene.penpot.undoBlocks, 0);
        assert.equal(await scene.penpot.render(scene.screen.id), before);
    });

    it("refuses a second run on the same file and a plan that changed", async () => {
        const scene = cardListScene();
        const h = harness(scene.penpot);
        const release = CleanupLock.acquire(h.ctx.context.fileId)!;
        try {
            await assert.rejects(run(h, { review: false }), /cleanup\/busy/);
        } finally {
            release();
        }
        const listing = await run(h, { dryRun: true });
        scene.cards[2].items[0].fills = [{ fillColor: "#00FF00", fillOpacity: 1 }];
        await assert.rejects(run(h, { review: false, expectedPlan: listing.planId }), /cleanup\/plan-changed/);
        assert.equal(scene.penpot.undoBlocks, 0);
    });

    it("skips what the review rejects, by layer id", async () => {
        const scene = cardListScene();
        const skip = [`J:${scene.emptyGroup.id}`, `C:${scene.cards[0].id}`, `L:${scene.list.id}`];
        const h = harness(scene.penpot, JSON.stringify({ skip }));
        const result = await run(h, { removeHidden: false, steps: { names: false } });
        assert.equal(result.totals.junk, 1);
        assert.equal(result.totals.layouts, 3);
        assert.equal(result.totals.components, 0);
        assert.ok(scene.emptyGroup.parent, "skipped junk kept");
        assert.deepEqual(result.skipped.sort(), skip.sort());
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

    it("keeps the layouts that pass when only some change the screenshot, in small chunks", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const h = harness(penpot);
        // only the list's own layout distorts the picture
        h.distort.when = (p) =>
            p.page.root.all().some((shape) => shape.flex !== null && shape.parent?.id === scene.screen.id);
        const result = await run(
            h,
            { review: false, steps: { names: false, components: false, junk: false } },
            { layoutChunk: 1 }
        );
        assert.equal(result.totals.layouts, 3);
        assert.equal(result.totals.layoutsReverted, 1);
        const list = scene.screen.items.find((shape) => shape.name === "Group 4")!;
        assert.equal(list.type, "group");
        assert.ok(list.items.every((card) => card.type === "board" && card.flex?.dir === "column"));
    });

    it("takes the component step back when making a copy fails, and reports it", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const before = await penpot.render(scene.screen.id);
        const h = harness(penpot);
        penpot.failInstanceAfter = 1;
        const result = await run(h, { review: false, removeHidden: false, steps: { names: false, layouts: false } });
        assert.equal(result.components[0].outcome, "failed");
        assert.equal(result.totals.components, 0);
        assert.equal(penpot.components.length, 0);
        assert.equal(penpot.openBlocks, 0);
        assert.ok(h.events.some((event) => event.kind === "log" && event.payload.code === "component-failed"));
        assert.equal(await penpot.render(scene.screen.id), before);
    });

    it("stops starting steps when the time is up", async () => {
        const scene = cardListScene();
        const h = harness(scene.penpot);
        const result = await run(h, { review: false, removeHidden: false }, { budgetMs: 0 });
        assert.equal(result.stopped, "time-budget");
        assert.equal(result.totals.layouts + result.totals.junk + result.totals.components, 0);
        assert.match(describeCleanup(result), /stopped early/);
    });

    it("stops when cancelled", async () => {
        const scene = cardListScene();
        const h = harness(scene.penpot);
        h.abort.abort();
        await assert.rejects(run(h, { review: false, removeHidden: false }), /cancelled/);
        assert.equal(scene.penpot.openBlocks, 0);
    });

    it("reports proposals with a plan id and stable ids, without changing anything, in a dry run", async () => {
        const scene = cardListScene();
        const h = harness(scene.penpot);
        const result = await run(h, { dryRun: true });
        assert.equal(result.dryRun, true);
        assert.equal(result.proposals?.length, 8);
        assert.ok(result.proposals?.some((proposal) => proposal.id === `L:${scene.list.id}`));
        assert.equal(result.planId, (await run(h, { dryRun: true })).planId);
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

    it("compares big boards at a smaller scale and reads Claude's review answer defensively", () => {
        assert.equal(ImportCleaner.unitScale({ width: 1440, height: 1024 }), 1);
        const scale = ImportCleaner.unitScale({ width: 1440, height: 20000 });
        assert.ok(scale < 1 && 1440 * 20000 * scale * scale <= ImportCleaner.MAX_SHOT_PIXELS);
        const proposals = [
            { id: "J:n", kind: "junk" as const, unitId: "u", nodeId: "n", name: "x", reason: "empty-group" as const },
        ];
        const review = ImportCleaner.parseReview(
            'Sure: {"skip": ["J:n", "X9"], "names": {"J:n": "A/B"}, "notes": " ok "}',
            proposals
        );
        assert.deepEqual([...review.skip], ["J:n"]);
        assert.equal(review.names.get("J:n"), "A B");
        assert.equal(review.notes, "ok");
        assert.equal(ImportCleaner.parseReview("no json", proposals).skip.size, 0);
        assert.equal(ImportCleaner.componentName("Frame 12"), "Item");
        assert.equal(ImportCleaner.componentName("Task Card"), "Task Card");
    });
});
