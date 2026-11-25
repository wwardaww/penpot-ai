import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import { ensureCheckpoint } from "../checkpoints";
import {
    DesignMdFromPenpot,
    DesignMdRepository,
    DesignMdSerializer,
    DtcgTokens,
    PenpotImportPlanner,
    PenpotScripts,
} from "../designmd";
import type { PenpotImportPlan, PlannedTypography } from "../designmd/PenpotImportPlan";
import type { ImportReport, PenpotSnapshot } from "../designmd/PenpotScripts";
import {
    designSystemWorkspace,
    DesignSystemScripts,
    type DesignSystemMarker,
    type OverviewKind,
    type OverviewReport,
} from "../designsystem";
import {
    ExtractFailure,
    ExtractPlanner,
    ExtractRun,
    ExtractScripts,
    SourceMapFile,
    type ColorsReport,
    type ComponentOps,
    type ComponentReport,
    type ExtractDetails,
    type ExtractPlan,
    type IconMarkup,
    type PagesReport,
    type RawInventory,
    type SourceMap,
} from "../designsystem/extract";
import { DEFAULT_ICON_STYLE, IconScripts, type IconChunkReport, type IconTokenReport } from "../icons";
import { collectClientIcons, ICON_CHUNK } from "./design-system-icons";

/** Params of `design-system-extract`. */
export type DesignSystemExtractParams =
    | {
          /** read the copy and send the proposal list */
          mode: "plan";
      }
    | {
          /** apply the accepted proposals */
          mode: "apply";
          /** `planId` of the list the user saw; another plan is refused (`plan-changed`) */
          planId: string;
          /** ids of the proposals the user unchecked */
          skip?: string[];
          /** the file is already a shared library (no publish question) */
          shared?: boolean;
          /** answer of the publish question given in advance */
          publish?: boolean;
      };

/** `result` of the plan mode (also sent as the `plan` event). */
export interface ExtractPlanResult extends ExtractPlan {
    mode: "plan";
    name: string;
    source: DesignSystemMarker["source"] | null;
}

/** `result` of the apply mode. */
export interface ExtractApplyResult {
    mode: "apply";
    name: string;
    planId: string;
    checkpoint: { id: string; n: number } | null;
    applied: {
        colors: number;
        merges: number;
        textStyles: number;
        tokens: number;
        components: number;
        renames: number;
        groups: number;
        icons: number;
        unused: number;
    };
    tokens: ImportReport | null;
    colors: ColorsReport | null;
    components: ComponentReport | null;
    icons: { imported: number; skipped: number; token: IconTokenReport | null } | null;
    overview: Partial<Record<OverviewKind, OverviewReport | null>>;
    pages: PagesReport | null;
    designMd: { path: string; commit: string | null } | null;
    sourceMap: { path: string; commit: string | null } | null;
    /** true: publish (the client does it); false: not now; null: not asked */
    publish: boolean | null;
}

/** Question option ids of the publish question. */
export const EXTRACT_PUBLISH_OPTIONS = { publish: "publish", later: "later" } as const;

/**
 * Makes a design system out of a copied project file (W36). Runs in the copy (marker
 * `designSystem.source` set, file id other than the source), never in the source.
 *
 * - `plan`: inventory (read only) → `plan` event + `result` with ONE proposal list.
 * - `apply {planId, skip}`: inventory again (refused with `plan-changed` when the list differs),
 *   W19 checkpoint, then one undo step per stage: tokens + theme, library colors, text styles,
 *   components (new ones from repeated layers with variants, nested ones moved up, everything
 *   bound to tokens and text styles), icons (W29 import: 24 px, `color.icon`; one step per 40),
 *   W29 overview pages, screen pages removed. Then DESIGN.md and `source-map.json` in
 *   `design/systems/<file-id>/`, the marker's `extractedAt`, and the publish question (once).
 */
export const workflow: Workflow<DesignSystemExtractParams> = {
    name: "design-system-extract",
    description: "Makes a design system (tokens, styles, components, icons) out of a copied project file.",
    run: (ctx, params) => {
        const run = new ExtractRun(ctx);
        return run.guard(async () => {
            const mode = params?.mode;
            if (mode !== "plan" && mode !== "apply") {
                throw new ExtractFailure("bad-mode", "mode must be plan or apply");
            }
            const scripts = new PenpotScripts(ctx.tools);
            const marker = await scripts.run<DesignSystemMarker | null>(DesignSystemScripts.readMarkerScript());
            const source = marker?.source ?? null;
            if (!source || !source.fileId || source.fileId === ctx.context.fileId) {
                throw new ExtractFailure(
                    "not-a-copy",
                    "This file is not a design system copy of a project; nothing was changed"
                );
            }
            const name = marker?.name || ctx.context.fileName || "Design system";

            run.progress("inventory", "Looking at what the project already has");
            const inventory = await scripts.run<RawInventory>(ExtractScripts.inventoryScript());
            if (inventory.truncated) {
                run.log("inventory-truncated", "The project is very large; only part of it was looked at");
            }
            const { plan, details } = ExtractPlanner.build(inventory);

            if (mode === "plan") {
                const result: ExtractPlanResult = { mode, name, source, ...plan };
                ctx.emit("plan", result);
                ctx.emit("result", result);
                return { summary: `${plan.proposals.length} proposals for "${name}"` };
            }

            if (params.planId !== plan.planId) {
                ctx.emit("plan", { mode: "plan", name, source, ...plan } satisfies ExtractPlanResult);
                throw new ExtractFailure(
                    "plan-changed",
                    "The file changed since the list was made; check the new list",
                    {
                        planId: plan.planId,
                    }
                );
            }
            const accepted = ExtractPlanner.accepted(details, Array.isArray(params.skip) ? params.skip : []);
            const result = await apply(ctx, run, scripts, { name, inventory, details: accepted, planId: plan.planId });
            result.publish = await askPublish(ctx, run, marker, params, name);
            await scripts.run(
                DesignSystemScripts.markerScript(
                    { name, extractedAt: new Date().toISOString(), publishAsked: true },
                    new Date().toISOString()
                )
            );
            ctx.emit("result", result);
            return { summary: summarize(result) };
        });
    },
};

interface ApplyInput {
    name: string;
    inventory: RawInventory;
    details: ExtractDetails;
    planId: string;
}

async function apply(
    ctx: WorkflowContext,
    run: ExtractRun,
    scripts: PenpotScripts,
    input: ApplyInput
): Promise<ExtractApplyResult> {
    const { details, inventory } = input;
    const result: ExtractApplyResult = {
        mode: "apply",
        name: input.name,
        planId: input.planId,
        checkpoint: null,
        applied: {
            colors: details.colors.length,
            merges: details.merges.length,
            textStyles: details.textStyles.length,
            tokens: details.tokens.length,
            components: details.components.length,
            renames: details.renames.length,
            groups: details.groups.length,
            icons: details.icons.shapes.length + details.icons.componentIds.length,
            unused: details.unused.length,
        },
        tokens: null,
        colors: null,
        components: null,
        icons: null,
        overview: {},
        pages: null,
        designMd: null,
        sourceMap: null,
        publish: null,
    };

    run.progress("checkpoint", "Saving a checkpoint");
    const checkpoint = await ensureCheckpoint(
        ctx,
        `Before making the design system "${input.name}"`,
        "design-system-extract"
    );
    if (!checkpoint) {
        run.log("checkpoint-failed", "No checkpoint could be saved; going on (this file is a copy)");
    }
    result.checkpoint = checkpoint ? { id: checkpoint.id, n: checkpoint.n } : null;

    const stage = async <T>(step: "tokens" | "colors" | "typography", text: string, body: () => Promise<T>) => {
        run.stopIfCancelled();
        run.progress(step, text);
        try {
            return await body();
        } catch (error) {
            run.log("stage-failed", `${text} failed: ${messageOf(error)}`, { stage: step });
            return null;
        }
    };

    // 1. tokens + theme (color tokens first, then values and the type scale)
    const keptTypographies = inventory.typographies.filter(
        (t) => !details.unused.some((u) => u.kind === "typography" && u.id === t.id)
    );
    const typographyPlan: PlannedTypography[] = [
        ...keptTypographies.map((t) => ({ ...t, fontStyle: "normal" as const })),
        ...details.textStyles.map(({ style }) => ({ ...style, fontStyle: "normal" as const })),
    ];
    const tokensPlan = emptyPlan();
    tokensPlan.tokens = [
        ...details.colors.map((color) => ({ name: color.token, type: "color" as const, value: color.hex })),
        ...(details.tokens.map(({ token }) => ({
            name: token.name,
            type: token.type,
            value: token.penpotValue,
        })) as unknown as PenpotImportPlan["tokens"]),
        ...(DesignSystemScripts.typographyTokens(typographyPlan) as unknown as PenpotImportPlan["tokens"]),
    ];
    result.tokens = await stage("tokens", "Creating the tokens and their theme", () =>
        scripts.run<ImportReport>(DesignSystemScripts.undoable(PenpotScripts.importScript(tokensPlan)))
    );
    if (result.tokens?.warnings.some((w) => w.code === "tokens-from-library")) {
        run.log("tokens-from-library", "The file takes its tokens from a library; no tokens were added");
    }

    // 2. library colors
    const mergedAway = details.merges.flatMap((merge) => merge.drop.map((drop) => drop.libraryColorId));
    const colorDrops = [
        ...mergedAway.filter((id): id is string => typeof id === "string"),
        ...details.unused.filter((u) => u.kind === "color").map((u) => u.id),
    ];
    result.colors = await stage("colors", "Setting up the library colors", () =>
        scripts.run<ColorsReport>(ExtractScripts.colorsScript(details.colors, colorDrops))
    );
    warnings(run, "colors", result.colors?.warnings);

    // 3. text styles
    const typographyIds = await stage("typography", "Creating the text styles", async () => {
        const plan = emptyPlan();
        plan.typographies = details.textStyles.map(({ style }) => ({ ...style, fontStyle: "normal" as const }));
        const drops = details.unused.filter((u) => u.kind === "typography").map((u) => u.id);
        await scripts.run<ImportReport>(
            DesignSystemScripts.undoable(
                `${ExtractScripts.dropTypographiesCode(drops)}\n${PenpotScripts.importScript(plan)}`
            )
        );
        return scripts.run<Record<string, string>>(ExtractScripts.typographyIdsScript());
    });

    // 4. components
    run.stopIfCancelled();
    run.progress("components", "Turning repeated layers into components and binding them to the tokens", {
        count: details.components.length,
    });
    try {
        result.components = await scripts.run<ComponentReport>(ExtractScripts.componentsScript(componentOps(details)));
        warnings(run, "components", result.components.warnings);
    } catch (error) {
        run.log("stage-failed", `Building the components failed: ${messageOf(error)}`, { stage: "components" });
    }

    // 5. icons
    const iconMap: Record<string, string> = {};
    if (details.icons.shapes.length > 0) {
        run.stopIfCancelled();
        run.progress("icons", "Collecting the icons", { count: details.icons.shapes.length });
        try {
            result.icons = await importIcons(scripts, details, iconMap);
            if (result.icons.skipped > 0) {
                run.log("icons-skipped", `${result.icons.skipped} icons could not be used`, {
                    count: result.icons.skipped,
                });
            }
        } catch (error) {
            run.log("stage-failed", `Collecting the icons failed: ${messageOf(error)}`, { stage: "icons" });
        }
    }

    // 6. W29 overview pages
    for (const kind of ["colors", "typography", "tokens"] as OverviewKind[]) {
        run.stopIfCancelled();
        run.progress("pages", `Building the ${kind} page`, { page: kind });
        try {
            result.overview[kind] = await scripts.run<OverviewReport>(DesignSystemScripts.overviewScript(kind));
        } catch (error) {
            result.overview[kind] = null;
            run.log("stage-failed", `The ${kind} page failed: ${messageOf(error)}`, { stage: kind });
        }
    }

    // 7. screens: only after the components stage, which lifts nested main components out of them
    run.stopIfCancelled();
    if (result.components) {
        run.progress("screens", "Removing the screens");
        try {
            result.pages = await scripts.run<PagesReport>(ExtractScripts.pagesScript());
        } catch (error) {
            run.log("stage-failed", `Removing the screens failed: ${messageOf(error)}`, { stage: "screens" });
        }
    } else {
        run.log("stage-failed", "The screens were kept because the components stage failed", { stage: "screens" });
    }

    // 8. DESIGN.md and source-map.json
    const folder = designSystemWorkspace(ctx.workspace, ctx.context.fileId);
    run.progress("design-md", "Writing the DESIGN.md of the design system");
    try {
        const snapshot = await scripts.run<PenpotSnapshot>(PenpotScripts.snapshotScript());
        const document = DesignMdFromPenpot.build(snapshot, null);
        document.tokens.name = input.name;
        const text = DesignMdSerializer.serialize(document);
        const repository = new DesignMdRepository(folder);
        await repository.prepareWrite();
        await repository.write(text, DtcgTokens.fromDocument(document));
        const commit = await repository.commit(`save the design system "${input.name}" made from a project`);
        result.designMd = { path: DesignMdRepository.FILE_NAME, commit };
    } catch (error) {
        run.log("stage-failed", `Writing DESIGN.md failed: ${messageOf(error)}`, { stage: "design-md" });
    }

    run.progress("source-map", "Recording how the project maps to the design system");
    const marker = await scripts
        .run<DesignSystemMarker | null>(DesignSystemScripts.readMarkerScript())
        .catch(() => null);
    const map: SourceMap = SourceMapFile.build(
        {
            source: marker?.source ?? null,
            designSystem: { fileId: ctx.context.fileId, projectId: ctx.context.projectId, name: input.name },
            inventory,
            details,
            components: result.components,
            libraryColors: result.colors?.byHex ?? {},
            typographies: typographyIds ?? {},
            icons: iconMap,
        },
        new Date().toISOString()
    );
    const store = new SourceMapFile(folder);
    const commit = await store.save(map, `map the source project to "${input.name}"`);
    result.sourceMap = { path: SourceMapFile.FILE_NAME, commit };
    return result;
}

function componentOps(details: ExtractDetails): ComponentOps {
    const colorMap: Record<string, string> = {};
    for (const merge of details.merges) {
        merge.drop.forEach((drop) => (colorMap[drop.hex] = merge.keep));
    }
    const colorTokens: Record<string, string> = {};
    details.colors.forEach((color) => (colorTokens[color.hex] = color.token));
    const radiusTokens: Record<string, string> = {};
    const spacingTokens: Record<string, string> = {};
    for (const { token } of details.tokens) {
        if (token.type === "borderRadius") {
            radiusTokens[token.value] = token.name;
        } else if (token.type === "spacing") {
            spacingTokens[token.value] = token.name;
        }
    }
    return {
        colorMap,
        colorTokens,
        radiusTokens,
        spacingTokens,
        candidates: details.components.map(({ proposalId, component }) => ({
            proposalId,
            name: component.name,
            variants: component.variants.map((variant) => ({
                sampleId: variant.sampleId,
                pageId: variant.pageId,
                name: variant.name,
            })),
        })),
        renames: details.renames.map(({ componentId, name }) => ({ componentId, name })),
        groups: details.groups.map(({ path, componentIds }) => ({ path, componentIds })),
        iconComponentIds: details.icons.componentIds,
        drops: details.unused.filter((u) => u.kind === "component").map((u) => u.id),
    };
}

async function importIcons(
    scripts: PenpotScripts,
    details: ExtractDetails,
    iconMap: Record<string, string>
): Promise<NonNullable<ExtractApplyResult["icons"]>> {
    const markup = await scripts.run<IconMarkup[]>(
        ExtractScripts.iconMarkupScript(details.icons.shapes.map(({ id, pageId }) => ({ id, pageId })))
    );
    const svgOf = new Map(markup.map((entry) => [entry.id, entry.svg]));
    const shapeOfName = new Map<string, string>();
    const icons = details.icons.shapes.flatMap((shape) => {
        const svg = svgOf.get(shape.id);
        if (!svg) {
            return [];
        }
        shapeOfName.set(shape.name, shape.id);
        return [{ name: shape.name, svg }];
    });
    let skipped = details.icons.shapes.length - icons.length;
    if (icons.length === 0) {
        return { imported: 0, skipped, token: null };
    }
    const collection = collectClientIcons(icons);
    skipped += collection.skipped.length;
    const token = await scripts.run<IconTokenReport>(IconScripts.ensureTokenScript(DEFAULT_ICON_STYLE));
    let imported = 0;
    for (let start = 0; start < collection.icons.length; start += ICON_CHUNK) {
        const chunk = collection.icons.slice(start, start + ICON_CHUNK);
        const report = await scripts.run<IconChunkReport>(IconScripts.importChunkScript(chunk, DEFAULT_ICON_STYLE));
        imported += report.imported.length;
        skipped += report.skipped.length;
        for (const entry of report.imported) {
            const shapeId = shapeOfName.get(entry.id);
            if (shapeId) {
                iconMap[shapeId] = entry.componentId;
            }
        }
    }
    return { imported, skipped, token };
}

async function askPublish(
    ctx: WorkflowContext,
    run: ExtractRun,
    marker: DesignSystemMarker | null,
    params: { shared?: boolean; publish?: boolean },
    name: string
): Promise<boolean | null> {
    if (params.shared === true) {
        return null;
    }
    if (typeof params.publish === "boolean") {
        return params.publish;
    }
    if (marker?.publishAsked) {
        return null;
    }
    run.progress("publish", "Asking whether to publish the library");
    const choice = await ctx.ask({
        text: `"${name}" is ready. Publish it as a shared library so that projects can use it?`,
        options: [
            { id: EXTRACT_PUBLISH_OPTIONS.publish, label: "Publish" },
            { id: EXTRACT_PUBLISH_OPTIONS.later, label: "Not now" },
        ],
        recommended: EXTRACT_PUBLISH_OPTIONS.later,
    });
    return choice === EXTRACT_PUBLISH_OPTIONS.publish;
}

function emptyPlan(): PenpotImportPlan {
    return {
        setName: PenpotImportPlanner.TOKEN_SET,
        themeGroup: PenpotImportPlanner.TOKEN_SET,
        themeName: PenpotImportPlanner.TOKEN_SET,
        colors: [],
        typographies: [],
        tokens: [],
        skipped: [],
    };
}

function warnings(run: ExtractRun, stage: string, list: { code: string; detail: string }[] | undefined): void {
    if (list && list.length > 0) {
        run.log("stage-warnings", `${list.length} items of the ${stage} stage were left as they are`, {
            stage,
            count: list.length,
            codes: [...new Set(list.map((w) => w.code))],
        });
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function summarize(result: ExtractApplyResult): string {
    const created = result.components?.created.length ?? 0;
    return `Design system "${result.name}": ${result.applied.colors} color tokens, ${result.applied.textStyles} new text styles, ${created} new components, ${result.icons?.imported ?? 0} icons`;
}
