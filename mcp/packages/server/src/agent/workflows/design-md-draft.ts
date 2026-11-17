import type { Workflow } from "@penpot/mcp-common";
import { ClaudeAnswer, DesignMdRepository, DtcgTokens, parseDesignMd, type DesignMdIssue } from "../designmd";

/** Params of the `design-md-draft` workflow. */
export interface DesignMdDraftParams {
    /** what the design system should be like (brand, mood, audience…) */
    prompt: string;
}

/** Claude turns to get a DESIGN.md without errors */
const MAX_ATTEMPTS = 2;

/**
 * Lets Claude write (or rewrite) the project's DESIGN.md from a description, then saves and
 * commits it. Nothing in the Penpot file changes; `design-md-import` applies it.
 *
 * Emits `result` `{content, commit, issues}`.
 */
export const workflow: Workflow<DesignMdDraftParams> = {
    name: "design-md-draft",
    description: "Claude drafts the project's DESIGN.md from a description.",
    run: async (ctx, params) => {
        if (typeof params?.prompt !== "string" || params.prompt.trim().length === 0) {
            throw new Error("design-md-draft needs a description");
        }
        const repository = new DesignMdRepository(ctx.workspace);
        const current = await repository.read();
        ctx.emit("progress", { summary: "Writing DESIGN.md" });

        let prompt = [
            `Request: ${params.prompt.trim()}`,
            "",
            current === null
                ? "The project has no DESIGN.md yet."
                : ["Current DESIGN.md (revise it; keep what the request does not change):", "", current].join("\n"),
            "",
            "Answer with the complete DESIGN.md file only.",
        ].join("\n");
        let sessionId: string | undefined;
        let text: string | null = null;
        let issues: DesignMdIssue[] = [];
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const answer = await ctx.runner.run({ prompt, resumeSessionId: sessionId });
            sessionId = answer.sessionId ?? sessionId;
            text = ClaudeAnswer.designMd(answer.text);
            if (text === null) {
                prompt =
                    "That was not a DESIGN.md file. Answer with the whole file, starting with the --- front matter.";
                continue;
            }
            issues = parseDesignMd(text).issues;
            const errors = issues.filter((issue) => issue.severity === "error");
            if (errors.length === 0) {
                break;
            }
            prompt = [
                "The file has these errors; answer with the corrected complete file:",
                ...errors.map((issue) => `- ${issue.path}: ${issue.message}`),
            ].join("\n");
        }
        if (text === null) {
            throw new Error("Claude did not write a DESIGN.md");
        }
        const { document } = parseDesignMd(text);
        const hasErrors = issues.some((issue) => issue.severity === "error");
        await repository.write(text, hasErrors ? undefined : DtcgTokens.fromDocument(document));
        const commit = await repository.commit(current === null ? "draft DESIGN.md" : "revise DESIGN.md");
        ctx.emit("result", { content: text, commit, issues });
        return { summary: hasErrors ? "DESIGN.md drafted, with errors to fix" : "DESIGN.md drafted" };
    },
};
