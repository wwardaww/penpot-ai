import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { WorkflowToolResult, WorkflowToolsApi } from "@penpot/mcp-common";
import { ImportCleaner } from "../workflows/cleanup-import";
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

    it("lists proposals, then applies the kept ones and lists layers left to name", async () => {
        const scene = cardListScene();
        const { penpot } = scene;
        const args = { fileId: "f-1", pageId: penpot.page.id };
        const ctx = await TidyUpTool.context(args, fakeTools(penpot), join(tmpdir(), "penforge-no-projects"));
        const params = { pageId: penpot.page.id, review: false, steps: { names: false } };

        const listing = await new ImportCleaner(ctx, { ...params, dryRun: true }, { settleMs: 0 }).run();
        const text = TidyUpTool.describeProposals(listing);
        assert.match(text, /"id":"C1","kind":"component"/);
        assert.match(text, /apply: true/);
        assert.equal(penpot.undoBlocks, 0);

        const cleaner = new ImportCleaner(
            ctx,
            { ...params, skip: ["J1"], componentNames: { C1: "Task Card" } },
            { settleMs: 0 }
        );
        const result = await cleaner.run();
        assert.equal(result.totals.junk, 2);
        assert.equal(result.totals.components, 1);
        assert.equal(result.components[0].name, "Task Card");
        assert.ok(scene.hidden.parent, "skipped junk kept");
        const unnamed = await cleaner.defaultNamedLayers();
        assert.deepEqual(
            unnamed.map((layer) => layer.name),
            ["Board 1", "Board"],
            "layers inside the component are left to the component"
        );
        const answer = TidyUpTool.describeApplied(result, unnamed, false);
        assert.match(answer, /No checkpoint was saved/);
        assert.match(answer, /unnamed layers/);
    });
});
