import type { Workflow } from "@penpot/mcp-common";
import { DesignMdRepository, parseDesignMd } from "../designmd";

/** Params of the `design-md-read` workflow. */
export interface DesignMdReadParams {
    /** commit to read DESIGN.md from; the file on disk when missing */
    ref?: string;
}

/**
 * Reads the project's DESIGN.md (on disk or at a commit) with its git history.
 *
 * Emits one `result` event `{exists, content, hash, path, ref, issues, history}`. `hash` identifies
 * the version read (null when there is no file); writers take it back as `base`. `history` lists
 * the commits that changed DESIGN.md, newest first, as `{commit, date, subject}`.
 */
export const workflow: Workflow<DesignMdReadParams> = {
    name: "design-md-read",
    description: "Reads the project's DESIGN.md and the list of its saved versions.",
    run: async (ctx, params) => {
        const ref = typeof params?.ref === "string" && params.ref.length > 0 ? params.ref : null;
        const repository = new DesignMdRepository(ctx.workspace);
        const text = ref === null ? await repository.read() : await repository.readAt(ref);
        const history = await repository.history();
        const issues = text === null ? [] : parseDesignMd(text).issues;
        ctx.emit("result", {
            exists: text !== null,
            content: text ?? "",
            hash: text === null ? null : DesignMdRepository.hash(text),
            path: repository.path,
            ref,
            issues,
            history,
        });
        return { summary: text === null ? "No DESIGN.md yet" : "DESIGN.md loaded" };
    },
};
