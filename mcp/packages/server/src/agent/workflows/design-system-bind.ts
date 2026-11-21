import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import { ensureCheckpoint } from "../checkpoints";
import { designSystemWorkspace } from "../designsystem";
import {
    BindingFailure,
    BindingRun,
    BindingStore,
    ConformanceChecker,
    ConformanceScripts,
    DesignMdPointer,
    DesignSystemConformance,
    DesignSystemTurnCheck,
    MissingItems,
    siblingWorkspace,
    sourceMapFixes,
    type DesignSystemBinding,
    type LinkReport,
    type PointerReport,
} from "../designsystem/conformance";
import { SourceMapFile, type SourceMap } from "../designsystem/extract";
import { applyDesignSystem, type DesignSystemRedesignResult } from "./design-system-redesign";

/** Params of `design-system-bind`. */
export type DesignSystemBindParams =
    | { action: "status" }
    | {
          action: "link";
          /** the design system file (a shared library) */
          fileId: string;
          name: string;
          /** the team project that holds it */
          projectId: string;
          /** library version the client saw (Penpot `revn`) */
          version?: string | number;
          /** answer to the re-design question given in advance */
          redesign?: "ask" | "now" | "later";
      }
    | { action: "unlink" };

/** Options of the re-design question. */
export const REDESIGN_OPTIONS = [
    { id: "apply", label: "Apply now" },
    { id: "later", label: "Later" },
];

const ID = /^[0-9a-fA-F-]{8,64}$/;

/**
 * `design-system-bind` (W30): the project's design system.
 *
 * - `status` → `result {action, binding, fileLinked, missing}` (read only; the client runs it
 *   silently when the AI session starts).
 * - `link` → links the library to the open file and makes it the tokens source, records
 *   `designSystem` in `.penforge/project.json`, points DESIGN.md at it. A system made from this
 *   very file (W36 `source-map.json`) swaps the project's items for the system's 1:1. Otherwise,
 *   when the file already has a design or another system was used, asks once whether to apply the
 *   system now (`design-system-redesign`) or later (then "Apply design system" shows in the AI menu).
 * - `unlink` → forgets the binding (the Penpot library stays linked).
 */
export const workflow: Workflow<DesignSystemBindParams> = {
    name: "design-system-bind",
    description: "Pick, switch or read the project's design system",
    run: async (ctx, params) => {
        const run = new BindingRun(ctx);
        const result = await run.guard(async () => {
            switch (params?.action) {
                case "status":
                    return status(ctx);
                case "link":
                    return link(ctx, run, params);
                case "unlink":
                    await new BindingStore(ctx.workspace).clear();
                    return { action: "unlink" as const, binding: null };
                default:
                    throw new BindingFailure("bad-params", "Unknown action");
            }
        });
        ctx.emit("result", result);
        return { summary: summaryOf(result) };
    },
};

async function status(ctx: WorkflowContext) {
    const binding = await DesignSystemConformance.binding(ctx.workspace);
    let fileLinked: boolean | null = null;
    if (binding) {
        try {
            fileLinked = await new ConformanceScripts(ctx.tools).run<boolean>(
                ConformanceScripts.linkedScript(binding.fileId)
            );
        } catch {
            fileLinked = null;
        }
    }
    const missing = binding ? await new MissingItems(ctx.workspace, binding.fileId).open() : [];
    return {
        action: "status" as const,
        binding,
        fileLinked,
        isSystem: binding?.fileId === ctx.context.fileId,
        missing: DesignSystemTurnCheck.itemsPayload(missing),
    };
}

async function link(
    ctx: WorkflowContext,
    run: BindingRun,
    params: Extract<DesignSystemBindParams, { action: "link" }>
) {
    const { fileId, projectId } = params;
    if (typeof fileId !== "string" || !ID.test(fileId) || typeof projectId !== "string" || !ID.test(projectId)) {
        throw new BindingFailure("bad-params", "A design system file and project are needed");
    }
    if (fileId === ctx.context.fileId) {
        throw new BindingFailure("not-allowed", "A design system cannot use itself");
    }
    const name =
        String(params.name ?? "")
            .trim()
            .slice(0, 120) || "Design system";
    const scripts = new ConformanceScripts(ctx.tools);

    run.progress("link", `Linking the design system "${name}"`, { name });
    const linkReport = await scripts.run<LinkReport>(ConformanceScripts.linkScript(fileId));
    if (!linkReport.linked) {
        throw new BindingFailure("link-failed", "The design system library could not be linked", {
            detail: linkReport.warnings.map((w) => w.detail).join("; "),
        });
    }
    if (linkReport.warnings.length > 0) {
        run.log("link-warnings", "Linking reported problems", { warnings: linkReport.warnings });
    }
    if (linkReport.tokensSource && linkReport.ownTokens > 0) {
        run.log(
            "own-tokens-inactive",
            `This file's own ${linkReport.ownTokens} tokens stay in the file but are inactive while the design system provides the tokens`,
            { count: linkReport.ownTokens }
        );
    }

    const store = new BindingStore(ctx.workspace);
    const before = await store.read();
    const switching = before !== null && before.fileId !== fileId;
    const binding: DesignSystemBinding = {
        fileId,
        name,
        projectId,
        version: params.version === undefined || params.version === null ? null : String(params.version),
        linkedAt: new Date().toISOString(),
        previous: switching
            ? { fileId: before.fileId, name: before.name, projectId: before.projectId }
            : (before?.previous ?? null),
        redesignPending: !switching && before !== null ? before.redesignPending : false,
        linkedFiles:
            !switching && before ? [...new Set([...before.linkedFiles, ctx.context.fileId])] : [ctx.context.fileId],
    };
    await store.write(binding);

    const systemWorkspace = siblingWorkspace(ctx.workspace, projectId);
    let designMd: PointerReport | null = null;
    run.progress("design-md", "Pointing DESIGN.md at the design system");
    try {
        designMd = await new DesignMdPointer(ctx.workspace, systemWorkspace).link(binding);
        if (designMd.outcome === "skipped") {
            run.log("design-md-skipped", "The design system has no DESIGN.md yet");
        }
    } catch (error) {
        run.log("design-md-skipped", "DESIGN.md could not be updated", {
            message: error instanceof Error ? error.message : String(error),
        });
    }

    // a system made from this very file: swap 1:1, no question
    const map = await new SourceMapFile(designSystemWorkspace(systemWorkspace, fileId)).read().catch(() => null);
    if (map?.source?.fileId === ctx.context.fileId) {
        const applied = await applySourceMap(ctx, run, binding, map);
        await store.write({ ...((await store.read()) ?? binding), redesignPending: false });
        return {
            action: "link" as const,
            binding: await store.read(),
            link: linkReport,
            designMd,
            sourceMap: applied,
            redesign: "mapped" as const,
            redesignResult: null,
        };
    }

    const hasDesign = await fileHasDesign(ctx);
    let redesign: "none" | "pending" | "done" = "none";
    let redesignResult: DesignSystemRedesignResult | null = null;
    if (switching || hasDesign) {
        let answer = params.redesign === "now" ? "apply" : params.redesign === "later" ? "later" : null;
        if (answer === null) {
            answer = await ctx.ask({
                text: switching
                    ? `Re-design with the new system? This restyles the whole file with "${name}" (a checkpoint is saved first).`
                    : `Apply "${name}" to the existing design now? (A checkpoint is saved first.)`,
                options: REDESIGN_OPTIONS,
            });
        }
        if (answer === "apply") {
            redesignResult = await applyDesignSystem(ctx, run, (await store.read()) ?? binding, {});
            redesign = "done";
        } else {
            await store.write({ ...((await store.read()) ?? binding), redesignPending: true });
            redesign = "pending";
        }
    }
    return {
        action: "link" as const,
        binding: await store.read(),
        link: linkReport,
        designMd,
        sourceMap: null,
        redesign,
        redesignResult,
    };
}

/** Swaps the project's items for the system's with the W36 source map, then fixes the values. */
async function applySourceMap(ctx: WorkflowContext, run: BindingRun, binding: DesignSystemBinding, map: SourceMap) {
    run.progress("checkpoint", "Saving a checkpoint");
    const checkpoint = await ensureCheckpoint(
        ctx,
        `Before linking design system "${binding.name}"`,
        "design-system-bind"
    );
    if (!checkpoint) {
        run.log("checkpoint-failed", "Could not save a checkpoint first");
    }
    const conformance = new DesignSystemConformance(ctx.tools, ctx.workspace, ctx.context.fileId);
    run.progress("source-map", "Swapping the project's items for the design system's");
    const { catalog } = await conformance.catalog(binding);
    const scan = await conformance.scan({ pages: "all", maxLayers: 20000 });
    const fixes = sourceMapFixes(map, scan.layers, catalog, ctx.context.fileId);
    const pageOf = Object.fromEntries(scan.layers.map((layer) => [layer.id, layer.pageId]));
    const report = await conformance.apply(catalog.libraryId, ConformanceChecker.ops(fixes), pageOf);
    const values = await conformance.run(binding, {
        mode: "check",
        fix: true,
        scope: { pages: "all", maxLayers: 20000 },
    });
    const swapped =
        fixes.filter((fix) => fix.code === "swap" || fix.code === "component").length - report.failed.length;
    run.log("source-map-applied", `Swapped ${Math.max(0, swapped)} items for the design system's`, {
        swapped: Math.max(0, swapped),
        values: values.report.fixes.length,
    });
    return {
        checkpoint: checkpoint ? { id: checkpoint.id, n: checkpoint.n } : null,
        swapped: Math.max(0, swapped),
        colors: fixes.filter((fix) => fix.code === "color-linked").length,
        values: values.report.fixes.length,
        failed: report.failed.length,
    };
}

/** Whether the open file has layers inside its boards (a new file has only empty boards). */
async function fileHasDesign(ctx: WorkflowContext): Promise<boolean> {
    try {
        const scan = await new DesignSystemConformance(ctx.tools, ctx.workspace, ctx.context.fileId).scan({
            pages: "all",
            maxLayers: 60,
        });
        return scan.layers.some((layer) => !layer.topLevel);
    } catch {
        return false;
    }
}

function summaryOf(result: { action: string; binding?: DesignSystemBinding | null } & Record<string, unknown>): string {
    if (result.action === "status") {
        return result.binding ? `Uses the design system "${result.binding.name}"` : "No design system";
    }
    if (result.action === "unlink") {
        return "The project no longer follows a design system";
    }
    const name = result.binding?.name ?? "the design system";
    switch (result.redesign) {
        case "done":
            return `Linked "${name}" and applied it to the design`;
        case "pending":
            return `Linked "${name}"; apply it later from the AI menu`;
        case "mapped":
            return `Linked "${name}" and swapped the project's items for it`;
        default:
            return `Linked "${name}"`;
    }
}
