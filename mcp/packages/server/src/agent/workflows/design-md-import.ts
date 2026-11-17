import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import {
    DesignMdBody,
    DesignMdReferences,
    DesignMdRepository,
    DtcgTokens,
    parseDesignMd,
    PenpotImportPlanner,
    PenpotScripts,
    type DesignMdDocument,
} from "../designmd";
import type { ImportReport, TagReport } from "../designmd/PenpotScripts";

/** Params of the `design-md-import` workflow. */
export interface DesignMdImportParams {
    /** DESIGN.md text to apply (saved first); the saved file when missing */
    content?: string;
    /** let Claude build the components of the spec (default true) */
    components?: boolean;
}

/** label of the file version saved before the import */
const CHECKPOINT_LABEL = "Before applying DESIGN.md";

/**
 * Applies DESIGN.md to the open Penpot file ("Apply to file").
 *
 * Saves a version of the file first, then creates or updates library colors, typographies and
 * the `DESIGN.md` token set and theme (deterministic plugin code), then lets Claude build the
 * components of the spec on the "Design System" page and links them to their keys. Emits
 * `result` `{checkpoint, colors, typographies, tokens, warnings, skipped, components}`.
 */
export const workflow: Workflow<DesignMdImportParams> = {
    name: "design-md-import",
    description: "Applies DESIGN.md to the open file: tokens, library colors, text styles and components.",
    run: async (ctx, params) => {
        const repository = new DesignMdRepository(ctx.workspace);
        const saved = await repository.read();
        const text = typeof params?.content === "string" ? params.content.replace(/\r\n?/g, "\n") : saved;
        if (text === null) {
            throw new Error("There is no DESIGN.md yet");
        }
        const { document, issues } = parseDesignMd(text);
        const errors = issues.filter((issue) => issue.severity === "error");
        if (errors.length > 0) {
            throw new Error(
                `DESIGN.md has errors: ${errors
                    .slice(0, 5)
                    .map((issue) => `${issue.path}: ${issue.message}`)
                    .join("; ")}`
            );
        }
        if (text !== saved) {
            await repository.write(text, DtcgTokens.fromDocument(document));
            await repository.commit("save before applying to the file");
        }

        const scripts = new PenpotScripts(ctx.tools);
        const checkpoint = await saveCheckpoint(ctx, scripts);

        ctx.emit("progress", { summary: "Creating tokens, colors and text styles" });
        const plan = PenpotImportPlanner.plan(document);
        const report = await scripts.run<ImportReport>(PenpotScripts.importScript(plan));

        let components: TagReport | null = null;
        const keys = Object.keys(document.tokens.components);
        if (keys.length > 0 && params?.components !== false) {
            ctx.emit("progress", { summary: "Building components" });
            await ctx.runner.run({ prompt: componentBrief(document, keys) });
            components = await scripts.run<TagReport>(PenpotScripts.tagComponentsScript(keys));
        }

        const result = {
            checkpoint,
            colors: report.colors,
            typographies: report.typographies,
            tokens: report.tokens,
            warnings: report.warnings,
            skipped: plan.skipped,
            components,
        };
        ctx.emit("result", result);
        return { summary: summarize(result) };
    },
};

/**
 * Saves a version of the file; asks the user whether to go on when that fails.
 *
 * @returns the version label, or null when the user chose to go on without one
 */
async function saveCheckpoint(ctx: WorkflowContext, scripts: PenpotScripts): Promise<string | null> {
    ctx.emit("progress", { summary: "Saving a version of the file" });
    try {
        return await scripts.run<string>(PenpotScripts.saveVersionScript(CHECKPOINT_LABEL));
    } catch {
        const choice = await ctx.ask({
            text: "Could not save a version of the file before applying DESIGN.md. Apply it anyway?",
            options: [
                { id: "continue", label: "Apply anyway" },
                { id: "stop", label: "Stop" },
            ],
        });
        if (choice !== "continue") {
            throw new Error("Stopped before changing the file");
        }
        return null;
    }
}

/** Prompt that asks Claude to build the components of a spec. */
function componentBrief(document: DesignMdDocument, keys: string[]): string {
    const references = new DesignMdReferences(document.tokens);
    const specs = keys.map((key) => {
        const properties: Record<string, unknown> = {};
        for (const [property, value] of Object.entries(document.tokens.components[key])) {
            const resolved = references.resolve(value);
            const reference = DesignMdReferences.parse(value);
            properties[property] =
                reference && resolved.ok
                    ? { value, resolved: resolved.value, use: penpotName(reference.group, reference.name) }
                    : value;
        }
        return { key, properties };
    });
    const notes = DesignMdBody.section(document, "Components")?.body ?? "";
    return [
        "Build these components from the project's DESIGN.md:",
        "",
        "```json",
        JSON.stringify(specs, null, 2),
        "```",
        "",
        notes.length > 0 ? ["Usage notes from DESIGN.md:", "", notes].join("\n") : "",
    ].join("\n");
}

/** Name of the Penpot library element or token a DESIGN.md reference maps to. */
function penpotName(group: string, name: string): string {
    switch (group) {
        case "colors":
            return `library color "${name}" / token ${PenpotImportPlanner.TOKEN_PREFIX.colors}.${name}`;
        case "typography":
            return `library typography "${name}"`;
        case "rounded":
            return `token ${PenpotImportPlanner.TOKEN_PREFIX.rounded}.${name}`;
        case "spacing":
            return `token ${PenpotImportPlanner.TOKEN_PREFIX.spacing}.${name}`;
        default:
            return `${group}.${name}`;
    }
}

function summarize(result: {
    colors: ImportReport["colors"];
    typographies: ImportReport["typographies"];
    tokens: ImportReport["tokens"];
    components: TagReport | null;
}): string {
    const count = (counts: ImportReport["colors"]) => counts.created.length + counts.updated.length;
    const parts = [
        `${count(result.colors)} colors`,
        `${count(result.typographies)} text styles`,
        `${count(result.tokens)} tokens`,
    ];
    if (result.components) {
        parts.push(`${result.components.tagged.length} components`);
    }
    return `Applied DESIGN.md: ${parts.join(", ")} added or updated`;
}
