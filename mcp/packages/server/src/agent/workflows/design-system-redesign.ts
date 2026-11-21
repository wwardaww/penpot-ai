import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import { ensureCheckpoint } from "../checkpoints";
import {
    BindingFailure,
    BindingRun,
    BindingStore,
    ConformanceChecker,
    DesignSystemConformance,
    DesignSystemTurnCheck,
    type CheckReport,
    type DesignSystemBinding,
    type FixedPayload,
    type Finding,
} from "../designsystem/conformance";

/** Params of `design-system-redesign` ("Apply design system"). */
export interface DesignSystemRedesignParams {
    /** skip the Claude pass over what the script could not map */
    noRestyle?: boolean;
}

/** `result` of `design-system-redesign`. */
export interface DesignSystemRedesignResult extends FixedPayload {
    designSystem: { fileId: string; name: string };
    previous: { fileId: string; name: string } | null;
    checkpoint: { id: string; n: number } | null;
    /** component copies swapped for the system's */
    swapped: number;
    /** the Claude pass ran over the rest */
    restyled: boolean;
    /** what still differs after both passes */
    remaining: Pick<Finding, "code" | "layerId" | "layerName" | "boardName" | "text">[];
    summary: string;
}

/** Findings handed to the Claude pass at most. */
const MAX_RESTYLE_ITEMS = 60;
/** Ops per fix script (one undo step each). */
const OPS_PER_SCRIPT = 400;

/**
 * `design-system-redesign` (W30, label "Apply design system"; not W38's code Re-Design): restyles
 * the whole file with the project's design system after a switch. One W19 checkpoint first; then
 * every color, text style, radius, spacing and component copy maps to the nearest system value or
 * the system twin (scripts, one undo step per page), Claude restyles what is left, a check runs
 * again and the run reports what could not be mapped. Clears the pending re-design.
 */
export const workflow: Workflow<DesignSystemRedesignParams> = {
    name: "design-system-redesign",
    description: "Apply the project's design system to the whole design",
    run: async (ctx, params) => {
        const run = new BindingRun(ctx);
        const result = await run.guard(async () => {
            const binding = await DesignSystemConformance.binding(ctx.workspace);
            if (!binding) {
                throw new BindingFailure("not-linked", "This project uses no design system yet");
            }
            return applyDesignSystem(ctx, run, binding, params ?? {});
        });
        ctx.emit("result", result);
        return { summary: result.summary };
    },
};

/**
 * Restyles the open file with the bound design system (also run by `design-system-bind` when the
 * user answers "Re-design" right away).
 */
export async function applyDesignSystem(
    ctx: WorkflowContext,
    run: BindingRun,
    binding: DesignSystemBinding,
    params: DesignSystemRedesignParams
): Promise<DesignSystemRedesignResult> {
    if (binding.fileId === ctx.context.fileId) {
        throw new BindingFailure("not-allowed", "This file is the design system itself");
    }
    run.progress("checkpoint", "Saving a checkpoint");
    const checkpoint = await ensureCheckpoint(
        ctx,
        `Before applying design system "${binding.name}"`,
        "design-system-redesign"
    );
    if (!checkpoint) {
        run.log("checkpoint-failed", "Could not save a checkpoint first");
    }
    run.stopIfCancelled();

    const conformance = new DesignSystemConformance(ctx.tools, ctx.workspace, ctx.context.fileId);
    run.progress("catalog", "Reading the design system");
    const { catalog } = await conformance.catalog(binding);
    if (!catalog.linked) {
        throw new BindingFailure("link-failed", "The design system library could not be linked to this file");
    }

    run.progress("scan", "Reading the design");
    const scan = await conformance.scan({ pages: "all", maxLayers: 20000 });
    const checker = new ConformanceChecker(catalog, { mode: "redesign", fileId: ctx.context.fileId });
    const planned = checker.check(scan.layers, scan.truncated);
    const pageOf = Object.fromEntries(scan.layers.map((layer) => [layer.id, layer.pageId]));
    const ops = ConformanceChecker.ops(planned.fixes);
    run.progress("fix", `Mapping ${planned.fixes.length} values to the design system`, { count: planned.fixes.length });
    const failedLayers = new Set<string>();
    for (const chunk of chunks(ops, pageOf)) {
        run.stopIfCancelled();
        const report = await conformance.apply(catalog.libraryId, chunk, pageOf);
        report.failed.forEach((failure) => failedLayers.add(failure.layerId));
    }
    if (failedLayers.size > 0) {
        run.log("fix-failed", `${failedLayers.size} layers could not be changed`, { count: failedLayers.size });
    }
    const applied: CheckReport = { ...planned, fixes: planned.fixes.filter((fix) => !failedLayers.has(fix.layerId)) };
    const swapped = applied.fixes.filter((fix) => fix.code === "swap").length;

    let restyled = false;
    const leftovers = [...planned.findings, ...planned.fixes.filter((fix) => failedLayers.has(fix.layerId))];
    if (leftovers.length > 0 && params.noRestyle !== true) {
        run.stopIfCancelled();
        run.progress("restyle", "Restyling what is left", { count: leftovers.length });
        try {
            await ctx.runner.run({
                prompt: restylePrompt(binding, leftovers),
                promptName: "design-system-redesign",
            });
            restyled = true;
        } catch (error) {
            if (ctx.signal.aborted) {
                throw error;
            }
            run.log("restyle-failed", "The AI could not restyle the rest", {
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    run.stopIfCancelled();
    run.progress("recheck", "Checking the result");
    const after = await conformance.run(binding, {
        mode: "check",
        fix: true,
        scope: { pages: "all", maxLayers: 20000 },
    });

    await new BindingStore(ctx.workspace).write({ ...binding, ...(await freshBinding(ctx)), redesignPending: false });

    const payload = DesignSystemTurnCheck.fixedPayload({ report: applied });
    const remaining = after.report.findings.map(({ code, layerId, layerName, boardName, text }) => ({
        code,
        layerId,
        layerName,
        boardName,
        text,
    }));
    const summary =
        `Applied the design system "${binding.name}": ${payload.total} changes` +
        (swapped > 0 ? `, ${swapped} components swapped` : "") +
        (remaining.length > 0 ? `; ${remaining.length} things still differ.` : ".");
    return {
        ...payload,
        designSystem: { fileId: binding.fileId, name: binding.name },
        previous: binding.previous ? { fileId: binding.previous.fileId, name: binding.previous.name } : null,
        checkpoint: checkpoint ? { id: checkpoint.id, n: checkpoint.n } : null,
        swapped,
        restyled,
        remaining,
        summary,
    };
}

/** The binding as stored now (the catalog step may have added a linked file). */
async function freshBinding(ctx: WorkflowContext): Promise<Partial<DesignSystemBinding>> {
    return (await new BindingStore(ctx.workspace).read()) ?? {};
}

/** Ops split per page and in chunks, keeping the run order. */
function chunks<T extends { layerId: string }>(ops: T[], pageOf: Record<string, string>): T[][] {
    const byPage = new Map<string, T[]>();
    for (const op of ops) {
        const page = pageOf[op.layerId] ?? "";
        byPage.set(page, [...(byPage.get(page) ?? []), op]);
    }
    const out: T[][] = [];
    for (const list of byPage.values()) {
        for (let i = 0; i < list.length; i += OPS_PER_SCRIPT) {
            out.push(list.slice(i, i + OPS_PER_SCRIPT));
        }
    }
    return out;
}

function restylePrompt(
    binding: DesignSystemBinding,
    leftovers: { layerId: string; layerName: string; boardName: string; text: string }[]
): string {
    const lines = leftovers
        .slice(0, MAX_RESTYLE_ITEMS)
        .map((item) => `- layer ${item.layerId} "${item.layerName}" on "${item.boardName}": ${item.text}`);
    return [
        `Design system: "${binding.name}" (library ${binding.fileId}).`,
        binding.previous ? `It replaces "${binding.previous.name}".` : "",
        `Left to restyle (${leftovers.length}${leftovers.length > MAX_RESTYLE_ITEMS ? `, first ${MAX_RESTYLE_ITEMS}` : ""}):`,
        ...lines,
    ]
        .filter(Boolean)
        .join("\n");
}
