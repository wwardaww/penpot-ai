import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { WorkflowToolResult, WorkflowToolsApi } from "@penpot/mcp-common";
import { TidyUpTool } from "./TidyUpTool";
import type { FakePenpot } from "./testing/FakePenpot";
import { cardListScene } from "./testing/scenes";

/** Penpot tools on a fake canvas. */
function fakeTools(penpot: FakePenpot): WorkflowToolsApi {
    return {
        list: async () => ["execute_code", "capture_node_screenshot"],
        call: async (name: string, args: Record<string, unknown> = {}): Promise<WorkflowToolResult> => {
            if (name === "execute_code") {
                const value = await penpot.execute(String(args.code));
                const text = JSON.stringify({ result: value });
                return { isError: false, text, content: [{ type: "text", text }] };
            }
            const data = await penpot.render(String(args.nodeId), Number(args.scale ?? 1));
            return { isError: false, text: "{}", content: [{ type: "image", data, mimeType: "image/png" }] };
        },
    };
}

describe("TidyUpTool", () => {
    it("finds the project of a file by its project.json", async () => {
        const dir = await mkdtemp(join(tmpdir(), "penforge-tidy-"));
        try {
            for (const [name, fileIds, updatedAt] of [
                ["p-old", ["f-1"], "2026-01-01"],
                ["p-new", ["f-1", "f-2"], "2026-02-01"],
                ["p-other", ["f-3"], "2026-03-01"],
            ] as const) {
                await mkdir(join(dir, name, ".penforge"), { recursive: true });
                await writeFile(join(dir, name, ".penforge", "project.json"), JSON.stringify({ fileIds, updatedAt }));
            }
            const workspace = await TidyUpTool.findWorkspace(dir, "f-1");
            assert.ok(workspace);
            assert.equal(workspace!.root, join(dir, "p-new"));
            assert.equal(await TidyUpTool.findWorkspace(dir, "f-9"), undefined);
            assert.equal(await TidyUpTool.findWorkspace(join(dir, "missing"), "f-1"), undefined);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("lists proposals with a plan id, then applies the kept ones and lists layers left to name", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const base = { fileId: "f-tool", pageId: penpot.page.id };
        const noProject = await TidyUpTool.context(base, fakeTools(penpot), join(tmpdir(), "penforge-no-projects"));
        const tuning = { settleMs: 0, checkpoint: async () => ({ id: "cp-1", n: 1 }) };

        const text = await TidyUpTool.handle(noProject, base, tuning);
        const listing = JSON.parse(text.split("\n")[0]);
        assert.ok(listing.proposals.some((p: { id: string }) => p.id === `C:${scene.cards[0].id}`));
        assert.ok(
            listing.proposals.some(
                (p: { onlyOnRequest?: boolean; layerId: string }) => p.onlyOnRequest && p.layerId === scene.hidden.id
            )
        );
        assert.deepEqual(listing.hiddenLayers, { count: 1, names: ["Old header"] });
        assert.match(text, /removeHidden: true/);
        assert.equal(penpot.undoBlocks, 0);

        // no plan id, or no project to save a checkpoint in: nothing changes
        assert.match(await TidyUpTool.handle(noProject, { ...base, apply: true }, tuning), /plan-missing/);
        assert.match(
            await TidyUpTool.handle(noProject, { ...base, apply: true, planId: listing.planId }, tuning),
            /checkpoint-failed/
        );
        assert.equal(penpot.undoBlocks, 0);

        const ctx = { ...noProject, workspace: {} as never };
        const answer = await TidyUpTool.handle(
            ctx,
            {
                ...base,
                apply: true,
                planId: listing.planId,
                skip: [`J:${scene.zeroSize.id}`],
                componentNames: { [`C:${scene.cards[0].id}`]: "Task Card" },
            },
            tuning
        );
        const report = JSON.parse(answer.split("\n")[0]);
        assert.equal(report.totals.junk, 1, "only the empty group: zero-size skipped, hidden kept");
        assert.equal(report.totals.components, 1);
        assert.equal(report.components[0].name, "Task Card");
        assert.ok(scene.hidden.parent && scene.zeroSize.parent);
        assert.deepEqual(
            report.unnamedLayers.map((layer: { name: string }) => layer.name),
            ["Board 1", "Board", "Rectangle 7"],
            "layers inside the component are left to the component; the skipped one is listed"
        );
        assert.match(answer, /unnamed layers/);
        // the same plan again: the layers changed, so it is refused
        assert.match(
            await TidyUpTool.handle(ctx, { ...base, apply: true, planId: listing.planId }, tuning),
            /plan-changed/
        );
    });
});
