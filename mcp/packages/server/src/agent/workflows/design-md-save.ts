import type { Workflow } from "@penpot/mcp-common";
import { DesignMdRepository, DtcgTokens, parseDesignMd } from "../designmd";

/** Params of the `design-md-save` workflow. */
export interface DesignMdSaveParams {
    /** the new DESIGN.md text */
    content: string;
    /** short description of the change, used in the commit message */
    message?: string;
}

/** largest DESIGN.md the daemon accepts */
const MAX_LENGTH = 512 * 1024;

/**
 * Saves DESIGN.md text written by the user and commits it to the design repository.
 *
 * Text with errors is saved too (it may be work in progress); `tokens.json` is only rewritten when
 * the file has no errors. Emits `result` `{commit, issues}`.
 */
export const workflow: Workflow<DesignMdSaveParams> = {
    name: "design-md-save",
    description: "Saves an edited DESIGN.md and records it in the project's design history.",
    run: async (ctx, params) => {
        if (typeof params?.content !== "string") {
            throw new Error("design-md-save needs the DESIGN.md content");
        }
        if (params.content.length > MAX_LENGTH) {
            throw new Error("DESIGN.md is too large");
        }
        const text = params.content.replace(/\r\n?/g, "\n");
        const { document, issues } = parseDesignMd(text);
        const hasErrors = issues.some((issue) => issue.severity === "error");
        const repository = new DesignMdRepository(ctx.workspace);
        await repository.write(text, hasErrors ? undefined : DtcgTokens.fromDocument(document));
        const message = typeof params.message === "string" && params.message.trim() ? params.message : "edit DESIGN.md";
        const commit = await repository.commit(message);
        ctx.emit("result", { commit, issues });
        return { summary: commit === null ? "No changes to save" : "DESIGN.md saved" };
    },
};
