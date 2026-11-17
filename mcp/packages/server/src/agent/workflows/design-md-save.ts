import type { Workflow } from "@penpot/mcp-common";
import { DesignMdFailure, DesignMdRepository, DesignMdRun, DtcgTokens, parseDesignMd } from "../designmd";

/** Params of the `design-md-save` workflow. */
export interface DesignMdSaveParams {
    /** the new DESIGN.md text */
    content: string;
    /** short description of the change, used in the commit message */
    message?: string;
    /**
     * hash of the version the text is based on (from `design-md-read`); null when the editor saw
     * no file. When the file on disk is another version, nothing is written (`outcome` `conflict`).
     * Omit to overwrite whatever is there (edits made outside Penforge are committed first).
     */
    base?: string | null;
}

/** largest DESIGN.md the daemon accepts */
const MAX_LENGTH = 512 * 1024;

/**
 * Saves DESIGN.md text written by the user and commits it to the design repository.
 *
 * Text with errors is saved too (it may be work in progress); `tokens.json` is only rewritten when
 * the file has no errors. Emits `result` `{outcome, commit, hash, issues, conflict?}` with
 * `outcome` `saved`, `unchanged` or `conflict` (`conflict` = `{content, hash, externalCommit}` of
 * the file on disk).
 */
export const workflow: Workflow<DesignMdSaveParams> = {
    name: "design-md-save",
    description: "Saves an edited DESIGN.md and records it in the project's design history.",
    run: (ctx, params) =>
        new DesignMdRun(ctx).guard(async () => {
            if (typeof params?.content !== "string") {
                throw new DesignMdFailure("missing-content", "design-md-save needs the DESIGN.md content");
            }
            if (params.content.length > MAX_LENGTH) {
                throw new DesignMdFailure("too-large", "DESIGN.md is too large");
            }
            const text = DesignMdRepository.normalize(params.content);
            const repository = new DesignMdRepository(ctx.workspace);
            const check = await repository.prepareWrite(params.base);
            if (check.conflict) {
                ctx.emit("result", {
                    outcome: "conflict",
                    commit: null,
                    hash: check.currentHash,
                    issues: [],
                    conflict: {
                        content: check.current ?? "",
                        hash: check.currentHash,
                        externalCommit: check.externalCommit,
                    },
                });
                return { summary: "DESIGN.md changed outside this editor; nothing was overwritten" };
            }
            const { document, issues } = parseDesignMd(text);
            const hasErrors = issues.some((issue) => issue.severity === "error");
            await repository.write(text, hasErrors ? undefined : DtcgTokens.fromDocument(document));
            const message =
                typeof params.message === "string" && params.message.trim() ? params.message : "edit DESIGN.md";
            const commit = await repository.commit(message);
            ctx.emit("result", {
                outcome: commit === null ? "unchanged" : "saved",
                commit,
                hash: DesignMdRepository.hash(text),
                issues,
            });
            return { summary: commit === null ? "No changes to save" : "DESIGN.md saved" };
        }),
};
