import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import { ensureCheckpoint } from "../checkpoints";
import {
    ClaudeAnswer,
    DesignMdRepository,
    DtcgTokens,
    parseDesignMd,
    PenpotImportPlanner,
    PenpotScripts,
    type DesignMdDocument,
    type DesignMdIssue,
} from "../designmd";
import type { ImportReport, TagReport } from "../designmd/PenpotScripts";
import {
    componentBrief,
    designSystemWorkspace,
    DesignSystemFailure,
    DesignSystemRun,
    DesignSystemScripts,
    type DesignSystemMarker,
    type DesignSystemSummary,
    type OverviewKind,
    type OverviewReport,
} from "../designsystem";

/** Params of the `design-system-generate` workflow. */
export interface DesignSystemGenerateParams {
    /** `design-md`: `text` is a DESIGN.md file; `prompt`: `text` describes the brand */
    source: "design-md" | "prompt";
    text: string;
    /** name of the uploaded file (`design-md`) */
    fileName?: string;
    /** the file is already a shared library (the publish question is skipped) */
    shared?: boolean;
    /** answer of the publish question given in advance */
    publish?: boolean;
}

/** Payload of the `result` event. */
export interface DesignSystemGenerateResult {
    name: string;
    checkpoint: { id: string; n: number } | null;
    designMd: { path: string; commit: string | null; hash: string; issues: DesignMdIssue[] };
    library: Pick<ImportReport, "colors" | "typographies" | "tokens" | "activation" | "warnings">;
    pages: Partial<Record<OverviewKind, OverviewReport | null>>;
    components: TagReport | null;
    summary: DesignSystemSummary | null;
    /** true: the user wants it published (the client publishes it); false: not now; null: not asked */
    publish: boolean | null;
}

/** Largest DESIGN.md or description accepted, in characters. */
export const MAX_TEXT = 256 * 1024;

/** Claude turns to get a DESIGN.md without errors. */
const MAX_DRAFT_ATTEMPTS = 2;

/** Question option ids of the publish question. */
export const PUBLISH_OPTIONS = { publish: "publish", later: "later" } as const;

/**
 * Builds a full design system in the open (design system) file from a DESIGN.md or a brand
 * description: checkpoint (W19), DESIGN.md saved in `design/systems/<file-id>/` (W22 format),
 * library colors, text styles and tokens (W22 plan + typography tokens), "Colors" and
 * "Typography" pages, components with variants on a "Components" page (Claude), a "Tokens"
 * overview page, then asks once whether to publish the file as a shared library. Every Penpot
 * stage is one undo step (Claude's components: one per component). See `wiki/architecture.md` §7.
 */
export const workflow: Workflow<DesignSystemGenerateParams> = {
    name: "design-system-generate",
    description: "Builds a complete design system (tokens, styles, components, pages) in the open file.",
    run: (ctx, params) =>
        new DesignSystemRun(ctx).guard(async () => {
            const run = new DesignSystemRun(ctx);
            const source = params?.source;
            if (source !== "design-md" && source !== "prompt") {
                throw new DesignSystemFailure("bad-source", "source must be design-md or prompt");
            }
            const input = typeof params.text === "string" ? DesignMdRepository.normalize(params.text).trim() : "";
            if (input.length === 0) {
                throw new DesignSystemFailure(
                    "missing-text",
                    source === "design-md" ? "The DESIGN.md file is empty" : "Describe the brand first"
                );
            }
            if (input.length > MAX_TEXT) {
                throw new DesignSystemFailure("too-large", "The text is too long", { limitKb: MAX_TEXT / 1024 });
            }
            const scripts = new PenpotScripts(ctx.tools);
            const repository = new DesignMdRepository(designSystemWorkspace(ctx.workspace, ctx.context.fileId));
            const before = await scripts.run<DesignSystemMarker | null>(DesignSystemScripts.readMarkerScript());

            run.progress("checkpoint", "Saving a checkpoint");
            const checkpoint = await ensureCheckpoint(
                ctx,
                "Before generating the design system",
                "design-system-generate"
            );
            if (!checkpoint) {
                run.log("checkpoint-failed", "No checkpoint could be saved; going on (the file was empty)");
            }
            stopIfCancelled(ctx);

            let text: string;
            if (source === "design-md") {
                run.progress("design-md", "Reading DESIGN.md", { fileName: params.fileName ?? "DESIGN.md" });
                text = `${input}\n`;
            } else {
                run.progress("draft", "Writing DESIGN.md from your description");
                text = await draftDesignMd(ctx, input);
            }
            const { document, issues } = parseDesignMd(text);
            const errors = issues.filter((issue) => issue.severity === "error");
            if (errors.length > 0) {
                throw new DesignSystemFailure(
                    "has-errors",
                    `DESIGN.md has errors: ${errors
                        .slice(0, 5)
                        .map((issue) => `${issue.path}: ${issue.message}`)
                        .join("; ")}`,
                    { count: errors.length, first: errors[0].path }
                );
            }
            await repository.prepareWrite();
            await repository.write(text, DtcgTokens.fromDocument(document));
            const commit = await repository.commit("save the design system's DESIGN.md");
            const name = designSystemName(document, params.fileName, ctx.context.fileName);
            await scripts.run(DesignSystemScripts.markerScript({ name }, new Date().toISOString()));
            stopIfCancelled(ctx);

            run.progress("library", "Creating tokens, colors and text styles");
            const plan = DesignSystemScripts.extendPlan(PenpotImportPlanner.plan(document));
            const report = await scripts.run<ImportReport>(
                DesignSystemScripts.undoable(PenpotScripts.importScript(plan))
            );
            if (report.warnings.length > 0) {
                run.log("import-warnings", `${report.warnings.length} values could not be applied as they are`, {
                    warnings: report.warnings,
                });
            }

            const pages: DesignSystemGenerateResult["pages"] = {};
            pages.colors = await overview(ctx, run, scripts, "colors", "Building the colors page");
            pages.typography = await overview(ctx, run, scripts, "typography", "Building the typography page");

            stopIfCancelled(ctx);
            run.progress("components", "Building components and their variants");
            let components: TagReport | null = null;
            try {
                await ctx.runner.run({ prompt: componentBrief(document) });
                const keys = Object.keys(document.tokens.components);
                if (keys.length > 0) {
                    components = await scripts.run<TagReport>(PenpotScripts.tagComponentsScript(keys));
                    if (components.missing.length > 0) {
                        run.log(
                            "components-missing",
                            `${components.missing.length} DESIGN.md components were not built`,
                            {
                                keys: components.missing,
                            }
                        );
                    }
                }
            } catch (error) {
                if (ctx.signal.aborted) {
                    throw error;
                }
                run.log("stage-failed", `Building components failed: ${messageOf(error)}`, { stage: "components" });
            }

            pages.tokens = await overview(ctx, run, scripts, "tokens", "Building the tokens overview");
            const summary = await scripts
                .run<DesignSystemSummary>(DesignSystemScripts.summaryScript())
                .catch(() => null);

            let publish: boolean | null = null;
            if (params.shared !== true) {
                if (typeof params.publish === "boolean") {
                    publish = params.publish;
                } else if (!before?.publishAsked) {
                    run.progress("publish", "Asking whether to publish the library");
                    const choice = await ctx.ask({
                        text: `"${name}" is ready. Publish it as a shared library so that projects can use it?`,
                        options: [
                            { id: PUBLISH_OPTIONS.publish, label: "Publish" },
                            { id: PUBLISH_OPTIONS.later, label: "Not now" },
                        ],
                    });
                    publish = choice === PUBLISH_OPTIONS.publish;
                }
            }
            await scripts.run(
                DesignSystemScripts.markerScript(
                    { name, generatedAt: new Date().toISOString(), publishAsked: true },
                    new Date().toISOString()
                )
            );

            const result: DesignSystemGenerateResult = {
                name,
                checkpoint: checkpoint ? { id: checkpoint.id, n: checkpoint.n } : null,
                designMd: {
                    path: DesignMdRepository.FILE_NAME,
                    commit,
                    hash: DesignMdRepository.hash(text),
                    issues,
                },
                library: {
                    colors: report.colors,
                    typographies: report.typographies,
                    tokens: report.tokens,
                    activation: report.activation,
                    warnings: report.warnings,
                },
                pages,
                components,
                summary,
                publish,
            };
            ctx.emit("result", result);
            return { summary: summarize(result) };
        }),
};

/** Lets Claude write the DESIGN.md of a description (W22 draft prompt), fixing errors once. */
async function draftDesignMd(ctx: WorkflowContext, description: string): Promise<string> {
    let prompt = [
        `Request: ${description}`,
        "",
        "This DESIGN.md describes a new design system (a shared library), not an app.",
        "Answer with the complete DESIGN.md file only.",
    ].join("\n");
    let sessionId: string | undefined;
    let text: string | null = null;
    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
        const answer = await ctx.runner.run({ prompt, promptName: "design-md-draft", resumeSessionId: sessionId });
        sessionId = answer.sessionId ?? sessionId;
        const candidate = ClaudeAnswer.designMd(answer.text);
        if (candidate === null) {
            prompt = "That was not a DESIGN.md file. Answer with the whole file, starting with the --- front matter.";
            continue;
        }
        text = candidate;
        const errors = parseDesignMd(candidate).issues.filter((issue) => issue.severity === "error");
        if (errors.length === 0) {
            break;
        }
        prompt = [
            "The file has these errors; answer with the corrected complete file:",
            ...errors.map((issue) => `- ${issue.path}: ${issue.message}`),
        ].join("\n");
    }
    if (text === null) {
        throw new DesignSystemFailure("no-draft", "Claude did not write a DESIGN.md");
    }
    return text.endsWith("\n") ? text : `${text}\n`;
}

/** Runs one overview page stage; a failure is logged and the run goes on. */
async function overview(
    ctx: WorkflowContext,
    run: DesignSystemRun,
    scripts: PenpotScripts,
    kind: OverviewKind,
    text: string
): Promise<OverviewReport | null> {
    stopIfCancelled(ctx);
    run.progress(kind, text);
    try {
        return await scripts.run<OverviewReport>(DesignSystemScripts.overviewScript(kind));
    } catch (error) {
        run.log("stage-failed", `The ${kind} page failed: ${messageOf(error)}`, { stage: kind });
        return null;
    }
}

/** Name of the design system: DESIGN.md `name`, else the uploaded file name, else the Penpot file name. */
export function designSystemName(document: DesignMdDocument, fileName: string | undefined, penpotName: string): string {
    const fromDoc = typeof document.tokens.name === "string" ? document.tokens.name.trim() : "";
    if (fromDoc) {
        return fromDoc.slice(0, 120);
    }
    const fromFile = (fileName ?? "").replace(/\.(md|markdown|txt)$/i, "").trim();
    if (fromFile && fromFile.toUpperCase() !== "DESIGN") {
        return fromFile.slice(0, 120);
    }
    return penpotName || "Design system";
}

function stopIfCancelled(ctx: WorkflowContext): void {
    if (ctx.signal.aborted) {
        throw new DesignSystemFailure("cancelled", "Cancelled");
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function summarize(result: DesignSystemGenerateResult): string {
    const s = result.summary;
    if (!s) {
        return `Design system "${result.name}" generated`;
    }
    return `Design system "${result.name}": ${s.colors} colors, ${s.typographies} text styles, ${s.tokens} tokens, ${s.components} components`;
}
