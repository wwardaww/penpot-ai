import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import {
    ClaudeAnswer,
    DesignMdBody,
    DesignMdFromPenpot,
    DesignMdRepository,
    DesignMdRun,
    DesignMdSerializer,
    DtcgTokens,
    parseDesignMd,
    PenpotScripts,
    type DesignMdDocument,
} from "../designmd";
import type { PenpotSnapshot } from "../designmd/PenpotScripts";

/** Params of the `design-md-export` workflow. */
export interface DesignMdExportParams {
    /** let Claude write usage notes for components without notes (default true) */
    notes?: boolean;
    /** drop DESIGN.md values the file does not have (default false: keep and report them) */
    prune?: boolean;
}

/**
 * Regenerates DESIGN.md from the open Penpot file ("Update from file").
 *
 * Commits edits made outside Penforge first, then reads tokens, library colors and typographies
 * and components, and merges them with the current DESIGN.md: its prose and spelling are kept
 * where the file agrees, and values the file lacks stay (listed in `notInFile`) unless `prune`.
 * Claude adds usage notes for components that have none. Writes DESIGN.md and `tokens.json` and
 * commits. Emits `result` `{outcome, content, commit, hash, issues, notInFile, pruned}` with
 * `outcome` `created`, `updated` or `unchanged`.
 */
export const workflow: Workflow<DesignMdExportParams> = {
    name: "design-md-export",
    description: "Updates DESIGN.md from the open file's tokens, library and components.",
    run: (ctx, params) =>
        new DesignMdRun(ctx).guard(async () => {
            const run = new DesignMdRun(ctx);
            const repository = new DesignMdRepository(ctx.workspace);
            const check = await repository.prepareWrite();
            const previous = check.current === null ? null : parseDesignMd(check.current).document;
            run.progress("read-file", "Reading the design system of the file");
            const snapshot = await new PenpotScripts(ctx.tools).run<PenpotSnapshot>(PenpotScripts.snapshotScript());
            const prune = params?.prune === true;
            const merged = DesignMdFromPenpot.merge(snapshot, previous, prune);
            let document = merged.document;
            if (params?.notes !== false) {
                document = await addNotes(ctx, run, document);
            }
            const text = DesignMdSerializer.serialize(document);
            const { issues } = parseDesignMd(text);
            await repository.write(text, DtcgTokens.fromDocument(document));
            const commit = await repository.commit(
                previous === null ? "create DESIGN.md from the file" : "update from the file"
            );
            ctx.emit("result", {
                outcome: previous === null ? "created" : commit === null ? "unchanged" : "updated",
                content: text,
                commit,
                hash: DesignMdRepository.hash(text),
                issues,
                notInFile: merged.notInFile,
                pruned: prune,
            });
            return {
                summary: commit === null ? "DESIGN.md already matches the file" : "DESIGN.md updated from the file",
            };
        }),
};

/**
 * Asks Claude for the missing prose: usage notes of components without a `###` subsection, and
 * the overview when it is empty. Leaves the document as it is when the answer is not usable.
 */
async function addNotes(ctx: WorkflowContext, run: DesignMdRun, document: DesignMdDocument): Promise<DesignMdDocument> {
    const known = DesignMdBody.componentNoteKeys(document);
    const missing = Object.keys(document.tokens.components).filter((key) => !known.has(key));
    const overview = DesignMdBody.section(document, "Overview");
    const needsOverview = overview === undefined || overview.body.trim().length === 0;
    if (missing.length === 0 && !needsOverview) {
        return document;
    }
    run.progress("write-notes", "Writing usage notes");
    const answer = await ctx.runner.run({
        prompt: [
            "DESIGN.md as generated from the file:",
            "",
            "````markdown",
            DesignMdSerializer.serialize(document).trimEnd(),
            "````",
            "",
            `Components that need usage notes: ${missing.length > 0 ? missing.join(", ") : "none"}.`,
            `Overview needed: ${needsOverview ? "yes" : "no"}.`,
        ].join("\n"),
    });
    const json = ClaudeAnswer.json(answer.text);
    if (json === null) {
        ctx.emit("log", { text: "Usage notes skipped: the answer had no JSON" });
        return document;
    }
    let result = document;
    if (needsOverview && typeof json.overview === "string") {
        result = DesignMdBody.fillSection(result, "Overview", json.overview);
    }
    const notes: Record<string, string> = {};
    const components = typeof json.components === "object" && json.components !== null ? json.components : {};
    for (const key of missing) {
        const note = (components as Record<string, unknown>)[key];
        if (typeof note === "string") {
            notes[key] = note;
        }
    }
    return DesignMdBody.addComponentNotes(result, notes);
}
