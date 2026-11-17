import type { Workflow, WorkflowContext, WorkflowResult } from "@penpot/mcp-common";
import { AiReview } from "../audit/AiReview";
import { AuditComments } from "../audit/AuditComments";
import type { CanvasThread } from "../audit/AuditComments";
import { AuditConfig } from "../audit/AuditConfig";
import type { AuditConfigOverrides } from "../audit/AuditConfig";
import type { AuditFinding } from "../audit/AuditFinding";
import { AuditReport } from "../audit/AuditReport";
import type { WrittenReport } from "../audit/AuditReport";
import { DesignAuditor } from "../audit/DesignAuditor";
import { DesignTree } from "../audit/DesignTree";
import { DesignReader, TreeLoader } from "../audit/TreeLoader";

/** Params of the `audit` workflow. */
export interface AuditParams {
    /** "audit" (default) checks the design; "fix" lets Claude fix the open `[Audit]` comments */
    mode?: "audit" | "fix";
    /** page to audit or fix (default: the tab's page) */
    pageId?: string;
    /** audit only these nodes (default: every top-level board of the page) */
    nodeIds?: string[];
    /** also ask Claude to review hierarchy, alignment and consistency (default false) */
    ai?: boolean;
    /** post findings as canvas comments (default true) */
    comments?: boolean;
    /** write and commit `design/audits/<date>.md` (default true) */
    report?: boolean;
    /** fix mode: only these threads (default: every open audit thread of the page) */
    threadIds?: string[];
}

/** Finding as sent to the client in the `result` event. */
export interface AuditResultFinding extends AuditFinding {
    /** thread holding the finding's comment (new or already open), if any */
    threadId: string | null;
    /** the comment was already open from an earlier audit */
    duplicate: boolean;
}

/**
 * One run of the `audit` workflow.
 */
class AuditRun {
    private readonly reader: DesignReader;
    private readonly comments: AuditComments;

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly params: AuditParams
    ) {
        this.reader = new DesignReader(ctx.tools);
        this.comments = new AuditComments(this.reader);
    }

    public run(): Promise<WorkflowResult> {
        return this.params.mode === "fix" ? this.fix() : this.audit();
    }

    private async audit(): Promise<WorkflowResult> {
        const { ctx, params } = this;
        this.progress("Reading the design");
        let pageId = params.pageId ?? ctx.context.pageId;
        let pageName: string | undefined;
        let rootIds: string[];
        if (Array.isArray(params.nodeIds) && params.nodeIds.length > 0) {
            rootIds = params.nodeIds.filter((id) => typeof id === "string");
        } else {
            const boards = await this.reader.boards(pageId);
            rootIds = boards.map((board) => board.id);
            pageName = boards[0]?.pageName;
        }
        const loader = new TreeLoader(this.reader);
        const snapshots = await loader.load(rootIds);
        this.checkCancelled();
        pageId = snapshots[0]?.pageId ?? pageId;
        if (pageName === undefined && snapshots.length > 0) {
            // audit of some nodes: only the board list knows the page name
            const boards = await this.reader.boards(pageId).catch(() => []);
            pageName = boards[0]?.pageName;
        }
        pageName ??= pageId;
        // selected nodes: their ancestors tell what is painted behind them
        const tree = new DesignTree(snapshots, await loader.ancestry(snapshots));
        const overrides = await ctx.workspace.readJson<AuditConfigOverrides>("audit.json", {}).catch(() => ({}));
        const config = new AuditConfig(ctx.context.platform, overrides ?? {});

        this.progress("Checking contrast, sizes, spacing and names");
        const auditor = new DesignAuditor();
        let findings = auditor.audit(tree, config);

        const aiReview = params.ai === true && tree.roots.length > 0;
        if (aiReview) {
            this.progress("Looking at the design with AI");
            const review = new AiReview(tree);
            const answer = await ctx.runner.run({ prompt: review.prompt(findings), promptName: "audit" });
            this.checkCancelled();
            const drafts = findings.map(({ id, ref: _ref, ...draft }) => ({ key: id, ...draft }));
            findings = DesignAuditor.finish(tree, [...drafts, ...review.parse(answer.text)]);
        }

        const threads = new Map<string, string>();
        const duplicates = new Set<string>();
        let overLimit = 0;
        if (params.comments !== false && findings.length > 0) {
            this.progress("Adding comments to the canvas");
            const posted = await this.comments.post(pageId, findings, config.maxComments);
            this.checkCancelled();
            posted.posted.forEach((threadId, findingId) => threads.set(findingId, threadId));
            posted.duplicates.forEach((threadId, findingId) => {
                threads.set(findingId, threadId);
                duplicates.add(findingId);
            });
            overLimit = posted.overLimit.length;
        }

        let report: WrittenReport | null = null;
        if (params.report !== false && tree.roots.length > 0) {
            report = await this.writeReport(tree, findings, pageId, pageName, aiReview);
        }

        const results: AuditResultFinding[] = findings.map((finding) => ({
            ...finding,
            threadId: threads.get(finding.id) ?? null,
            duplicate: duplicates.has(finding.id),
        }));
        const newComments = results.filter((f) => f.threadId && !f.duplicate).length;
        ctx.emit("result", {
            mode: "audit",
            pageId,
            pageName,
            boards: tree.roots.map((root) => ({ id: root.id, name: root.name })),
            nodeCount: tree.size,
            truncated: loader.truncated,
            contrastUnchecked: auditor.unknownBackgrounds.length,
            aiReview,
            counts: {
                error: findings.filter((f) => f.severity === "error").length,
                warning: findings.filter((f) => f.severity === "warning").length,
                info: findings.filter((f) => f.severity === "info").length,
            },
            comments: { posted: newComments, duplicates: duplicates.size, overLimit },
            report,
            findings: results,
        });
        if (tree.roots.length === 0) {
            return { summary: "Nothing to audit on this page" };
        }
        const counted = AuditReport.counts(findings);
        const commented = newComments > 0 ? `; added ${newComments} comment${newComments === 1 ? "" : "s"}` : "";
        return { summary: `Audit of ${pageName}: ${counted}${commented}` };
    }

    private async writeReport(
        tree: DesignTree,
        findings: AuditFinding[],
        pageId: string,
        pageName: string,
        aiReview: boolean
    ): Promise<WrittenReport | null> {
        const report = new AuditReport(
            {
                fileName: this.ctx.context.fileName,
                pageId,
                pageName,
                platform: this.ctx.context.platform,
                boards: tree.roots.map((root) => root.name),
                nodeCount: tree.size,
                aiReview,
            },
            findings,
            new Date()
        );
        try {
            return await report.write(
                this.ctx.workspace,
                `penforge(audit): ${AuditReport.counts(findings)} on ${pageName}`
            );
        } catch (error) {
            // the audit result stays useful without the report
            this.ctx.emit("log", { text: `Could not write the audit report: ${AuditRun.describe(error)}` });
            return null;
        }
    }

    private async fix(): Promise<WorkflowResult> {
        const { ctx, params } = this;
        const pageId = params.pageId ?? ctx.context.pageId;
        this.progress("Reading the audit comments");
        const wanted =
            Array.isArray(params.threadIds) && params.threadIds.length > 0 ? new Set(params.threadIds) : null;
        const targets = (await this.comments.openThreads(pageId)).filter(
            (thread) => !wanted || wanted.has(thread.threadId)
        );
        if (targets.length === 0) {
            ctx.emit("result", { mode: "fix", pageId, fixed: [], remaining: [] });
            return { summary: "No open audit comments to fix" };
        }
        this.progress("Fixing the audit comments");
        await ctx.runner.run({ prompt: AuditRun.fixPrompt(targets), promptName: "audit" });
        this.checkCancelled();
        const stillOpen = new Set((await this.comments.openThreads(pageId)).map((thread) => thread.threadId));
        const fixed = targets.filter((thread) => !stillOpen.has(thread.threadId)).map((thread) => thread.threadId);
        const remaining = targets.filter((thread) => stillOpen.has(thread.threadId)).map((thread) => thread.threadId);
        ctx.emit("result", { mode: "fix", pageId, fixed, remaining });
        return { summary: `Fixed ${fixed.length} of ${targets.length} audit comments` };
    }

    private static fixPrompt(threads: CanvasThread[]): string {
        const items = threads.map((thread) =>
            [
                `- threadId: ${thread.threadId}`,
                `  nodeId: ${thread.nodeId ?? "unknown"}${thread.boardId ? ` (board ${thread.boardId})` : ""}`,
                `  comment: ${thread.comments[0].content.replace(/\s+/g, " ")}`,
            ].join("\n")
        );
        return [
            "Fix the problems reported by these open design audit comments:",
            ...items,
            "",
            "Follow the fixing rules of the audit instructions. Resolve each thread you fixed with " +
                "resolve_canvas_comment and a short note; leave the others open and say why.",
        ].join("\n");
    }

    private progress(summary: string): void {
        this.ctx.emit("progress", { summary, status: "running" });
    }

    private checkCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }

    private static describe(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

/**
 * Design audit (W15): checks a page or some boards for contrast, tap target size, spacing, near
 * duplicate colors, type scale, default names, detached components and overflowing text, and
 * optionally asks Claude about hierarchy and alignment. Findings go to the canvas as `[Audit]`
 * comments (de-duplicated against open ones) and to `design/audits/<date>.md`.
 *
 * With `mode: "fix"`, Claude fixes the open `[Audit]` comments of the page and resolves them.
 */
export const workflow: Workflow<AuditParams> = {
    name: "audit",
    description: "Check the design for contrast, tap targets, spacing, colors, type scale and naming issues.",
    run: (ctx, params) => new AuditRun(ctx, params ?? {}).run(),
};
