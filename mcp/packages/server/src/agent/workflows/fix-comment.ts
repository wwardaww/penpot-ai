import type { Persona, Workflow } from "@penpot/mcp-common";
import { CommentFixer, type FixReport } from "./fix-comment-fixer";

/** Params of the `fix-comment` workflow. */
export interface FixCommentParams {
    threadId: string;
    /** page of the thread, to find it faster */
    pageId?: string;
}

/**
 * Wording of the `fix-comment` run for the designer and the developer persona.
 */
class FixCommentWording {
    /**
     * Gets the progress line of the fix.
     *
     * @param persona - the persona
     * @param seqNumber - number of the thread
     */
    public static progress(persona: Persona, seqNumber: number): string {
        return persona === "developer"
            ? `Fixing comment #${seqNumber}: reading its layer, applying the change, checking a screenshot`
            : `Working on comment #${seqNumber}`;
    }

    /**
     * Gets the summary of a finished fix.
     *
     * @param report - the report
     */
    public static summary(report: FixReport): string {
        const note = report.note ? `: ${report.note}` : "";
        switch (report.outcome) {
            case "fixed":
                return report.resolved
                    ? `Fixed comment #${report.seqNumber}${note}`
                    : `Fixed comment #${report.seqNumber}, but could not mark it as resolved${note}`;
            case "no-change":
                return `Comment #${report.seqNumber} asks for no change${note}`;
            default:
                return `Could not fix comment #${report.seqNumber}${note}`;
        }
    }
}

/**
 * Fixes one canvas comment: reads the commented layer fresh from the canvas, lets Claude apply the
 * change and check it on a screenshot, then resolves the thread with a short note. A comment that
 * asks for no change gets the note as a reply and stays open.
 *
 * Events: `progress` `{text, step, threadId, seqNumber}`; `result` = the {@link FixReport}.
 */
export const workflow: Workflow<FixCommentParams> = {
    name: "fix-comment",
    description: "Applies the change a canvas comment asks for and resolves the comment.",
    run: async (ctx, params) => {
        if (typeof params?.threadId !== "string" || params.threadId.length === 0) {
            throw new Error("fix-comment needs a threadId");
        }
        const pageId = typeof params.pageId === "string" && params.pageId ? params.pageId : undefined;
        const fixer = new CommentFixer(ctx);

        const thread = await fixer.findThread(params.threadId, pageId);
        if (!thread) {
            throw new Error(`Comment thread not found: ${params.threadId}`);
        }
        const base = { threadId: thread.threadId, seqNumber: thread.seqNumber };
        if (thread.resolved) {
            const report: FixReport = { ...base, outcome: "no-change", note: "", resolved: true, replied: false };
            ctx.emit("result", report);
            return { summary: `Comment #${thread.seqNumber} is already resolved` };
        }

        ctx.emit("progress", {
            ...base,
            step: "fixing",
            text: FixCommentWording.progress(fixer.persona, thread.seqNumber),
        });
        const report = await fixer.fix(thread);
        ctx.emit("result", report);
        return { summary: FixCommentWording.summary(report) };
    },
};
