import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import {
    BindingFailure,
    BindingRun,
    ConformanceChecker,
    DesignSystemConformance,
    DesignSystemTurnCheck,
    type Finding,
    type FixedPayload,
    type MissingItem,
} from "../designsystem/conformance";

/** Params of `design-system-check`. */
export interface DesignSystemCheckParams {
    /** `fix` (default) applies the fixes; `check` only lists them */
    mode?: "check" | "fix";
    /** pages to check: the current one by default, or `all` */
    pages?: "current" | "all";
    /** only these top-level boards */
    boardIds?: string[];
}

/** `result` of `design-system-check`. */
export interface DesignSystemCheckResult extends FixedPayload {
    mode: "check" | "fix";
    designSystem: { fileId: string; name: string };
    /** English summary (designer wording) */
    summary: string;
    remaining: Pick<Finding, "code" | "layerId" | "layerName" | "boardName" | "text">[];
    missing: ReturnType<typeof DesignSystemTurnCheck.itemsPayload>;
    scanned: number;
    truncated: boolean;
    failed: number;
}

/**
 * `design-system-check` (W30): lists drift from the project's design system (raw colors, fonts,
 * sizes, radius, spacing and shadows that are not from the system; redrawn or local components
 * the system has) and, in `fix` mode, fixes what is close to a system value in one undo step,
 * explaining each change. What the system lacks joins the missing items list.
 */
export const workflow: Workflow<DesignSystemCheckParams> = {
    name: "design-system-check",
    description: "Check the design against the project's design system and fix the drift",
    run: async (ctx, params) => {
        const run = new BindingRun(ctx);
        const result = await run.guard(() => check(ctx, run, params ?? {}));
        ctx.emit("result", result);
        return { summary: result.summary };
    },
};

async function check(
    ctx: WorkflowContext,
    run: BindingRun,
    params: DesignSystemCheckParams
): Promise<DesignSystemCheckResult> {
    const mode = params.mode === "check" ? "check" : "fix";
    const binding = await DesignSystemConformance.binding(ctx.workspace);
    if (!binding) {
        throw new BindingFailure("not-linked", "This project uses no design system yet");
    }
    if (binding.fileId === ctx.context.fileId) {
        throw new BindingFailure("not-allowed", "This file is the design system itself");
    }
    const boardIds = Array.isArray(params.boardIds)
        ? params.boardIds.filter((id) => typeof id === "string").slice(0, 200)
        : undefined;
    run.progress("scan", "Checking the design against the design system");
    const conformance = new DesignSystemConformance(ctx.tools, ctx.workspace, ctx.context.fileId);
    const outcome = await conformance.run(binding, {
        mode: "check",
        fix: mode === "fix",
        scope: { pages: params.pages === "all" ? "all" : "current", boardIds },
    });
    if (!outcome.catalog.linked) {
        throw new BindingFailure("link-failed", "The design system library could not be linked to this file");
    }
    if (outcome.applied && outcome.applied.failed.length > 0) {
        run.log("fix-failed", `${outcome.applied.failed.length} changes could not be made`, {
            count: outcome.applied.failed.length,
        });
    }
    const payload = DesignSystemTurnCheck.fixedPayload(outcome);
    return {
        mode,
        designSystem: { fileId: binding.fileId, name: binding.name },
        ...payload,
        summary: ConformanceChecker.summary(outcome.report),
        remaining: outcome.report.findings.map(({ code, layerId, layerName, boardName, text }) => ({
            code,
            layerId,
            layerName,
            boardName,
            text,
        })),
        missing: DesignSystemTurnCheck.itemsPayload(outcome.openMissing as MissingItem[]),
        scanned: outcome.report.scanned,
        truncated: outcome.report.truncated,
        failed: outcome.applied?.failed.length ?? 0,
    };
}
