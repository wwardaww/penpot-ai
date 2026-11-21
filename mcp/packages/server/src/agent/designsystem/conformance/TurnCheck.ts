import type {
    AgentContext,
    ChatToolMessage,
    WorkflowContext,
    WorkflowToolsApi,
    WorkflowWorkspaceApi,
} from "@penpot/mcp-common";
import { createLogger } from "../../../logger";
import { DesignSystemConformance, type ConformanceOutcome } from "./Conformance";
import { ConformanceChecker } from "./ConformanceChecker";
import type { MissingItem } from "./types";

const logger = createLogger("DesignSystemTurnCheck");

/** Payload codes the client translates. */
export const FIXED_CODE = "design-system-fixed";
export const MISSING_CODE = "design-system-missing";

/** What a client needs to word a pass: codes and params, plus the English summary. */
export interface FixedPayload {
    fixes: { code: string; params: Record<string, string | number> }[];
    /** values that already matched and were only linked */
    linked: number;
    findings: { code: string; params: Record<string, string | number> }[];
    total: number;
}

/**
 * Design system check after AI writes (W30): after a chat turn or one of the design workflows
 * changed the design of a project that uses a design system, the check runs on the tab's page,
 * fixes drift and explains it in one summary; the project's own components the system lacks and
 * the AI's reported items show as one missing items list. Never fails the turn or the run.
 */
export class DesignSystemTurnCheck {
    /** Tool name of the check's lines in `chat.tool`. */
    public static readonly TOOL = "penforge_design_system_check";

    /** Workflows that write design and get the check at their end. */
    public static readonly WORKFLOWS: ReadonlySet<string> = new Set([
        "generate-screen",
        "adapt-responsive",
        "fix-comment",
        "fix-comments",
    ]);

    /** Explained fixes sent to the client. */
    private static readonly MAX_SENT = 20;

    /**
     * Runs the check after a chat turn that changed the design.
     *
     * @param send - sends a daemon message to the tab
     */
    public static async afterChatTurn(
        send: (message: ChatToolMessage) => void,
        conversationId: string,
        setup: { tools: WorkflowToolsApi | null; workspace: WorkflowWorkspaceApi; context: AgentContext }
    ): Promise<void> {
        const outcome = await DesignSystemTurnCheck.pass(setup.tools, setup.workspace, setup.context);
        if (!outcome) {
            return;
        }
        const { report } = outcome;
        if (report.fixes.length > 0 || report.findings.length > 0) {
            send({
                type: "chat.tool",
                conversationId,
                toolName: DesignSystemTurnCheck.TOOL,
                summary: ConformanceChecker.summary(report),
                status: "done",
                code: FIXED_CODE,
                params: DesignSystemTurnCheck.fixedPayload(outcome) as unknown as Record<string, unknown>,
            });
        }
        if (outcome.openMissing.length > 0) {
            send({
                type: "chat.tool",
                conversationId,
                toolName: DesignSystemTurnCheck.TOOL,
                summary: DesignSystemTurnCheck.missingSummary(outcome.openMissing),
                status: "done",
                code: MISSING_CODE,
                params: { items: DesignSystemTurnCheck.itemsPayload(outcome.openMissing) },
            });
        }
    }

    /** Runs the check at the end of a design workflow; reports as `log` events of the run. */
    public static async afterWorkflow(ctx: WorkflowContext, name: string): Promise<void> {
        if (!DesignSystemTurnCheck.WORKFLOWS.has(name) || ctx.signal.aborted) {
            return;
        }
        const outcome = await DesignSystemTurnCheck.pass(ctx.tools, ctx.workspace, ctx.context);
        if (!outcome) {
            return;
        }
        const { report } = outcome;
        if (report.fixes.length > 0 || report.findings.length > 0) {
            ctx.emit("log", {
                code: FIXED_CODE,
                params: DesignSystemTurnCheck.fixedPayload(outcome),
                text: ConformanceChecker.summary(report),
            });
        }
        if (outcome.openMissing.length > 0) {
            ctx.emit("log", {
                code: MISSING_CODE,
                params: { items: DesignSystemTurnCheck.itemsPayload(outcome.openMissing) },
                text: DesignSystemTurnCheck.missingSummary(outcome.openMissing),
            });
        }
    }

    /** Codes and params of a pass. */
    public static fixedPayload(outcome: Pick<ConformanceOutcome, "report">): FixedPayload {
        const explained = outcome.report.fixes.filter((fix) => !fix.quiet);
        return {
            fixes: explained
                .slice(0, DesignSystemTurnCheck.MAX_SENT)
                .map((fix) => ({ code: fix.code, params: fix.params })),
            linked: outcome.report.fixes.length - explained.length,
            findings: outcome.report.findings
                .slice(0, DesignSystemTurnCheck.MAX_SENT)
                .map((finding) => ({ code: finding.code, params: finding.params })),
            total: explained.length,
        };
    }

    /** Items as the client lists them. */
    public static itemsPayload(
        items: MissingItem[]
    ): Pick<MissingItem, "id" | "kind" | "name" | "reason" | "source">[] {
        return items.map(({ id, kind, name, reason, source }) => ({ id, kind, name, reason, source }));
    }

    /** English line for the missing items list. */
    public static missingSummary(items: MissingItem[]): string {
        const names = items
            .slice(0, 6)
            .map((item) => `"${item.name}"`)
            .join(", ");
        return (
            `The design system has no ${names}${items.length > 6 ? ` and ${items.length - 6} more` : ""}. ` +
            "Add them to the design system, or keep the project's own versions?"
        );
    }

    private static async pass(
        tools: WorkflowToolsApi | null,
        workspace: WorkflowWorkspaceApi,
        context: AgentContext
    ): Promise<ConformanceOutcome | null> {
        if (!tools) {
            return null;
        }
        try {
            const binding = await DesignSystemConformance.binding(workspace);
            if (!binding || binding.fileId === context.fileId) {
                return null;
            }
            return await new DesignSystemConformance(tools, workspace, context.fileId).run(binding, {
                mode: "check",
                fix: true,
                scope: { pages: "current" },
            });
        } catch (error) {
            logger.warn("Design system check failed: %s", error instanceof Error ? error.message : String(error));
            return null;
        }
    }
}
