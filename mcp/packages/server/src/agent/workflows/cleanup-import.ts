import { createHash } from "crypto";
import type { Attachment, Workflow, WorkflowContext, WorkflowToolFilter, WorkflowToolResult } from "@penpot/mcp-common";
import { Checkpoints } from "../checkpoints";
import {
    CleanupHeuristics,
    CleanupLock,
    CleanupScripts,
    PixelDiff,
    type CleanupNode,
    type CleanupProposal,
    type CleanupResult,
    type CleanupScan,
    type ComponentProposal,
    type ComponentReport,
    type DiffScore,
    type JunkProposal,
    type LayoutProposal,
    type LayoutUndo,
    type UnitReport,
} from "../cleanup";
import { autoName, DefaultNames } from "./auto-name";

/** Params of the `cleanup-import` workflow. */
export interface CleanupParams {
    /** "page" (default without nodeIds) or "selection" (the given layers and their content) */
    scope?: "page" | "selection";
    nodeIds?: string[];
    /** page to tidy up; the tab's page by default */
    pageId?: string;
    /** steps to run (all by default) */
    steps?: { junk?: boolean; layouts?: boolean; components?: boolean; names?: boolean };
    /** let Claude check the proposals with screenshots first (default true) */
    review?: boolean;
    /** only report what would change */
    dryRun?: boolean;
    /** largest share of differing pixels a step may cause (default 0.002) */
    threshold?: number;
    /**
     * Remove hidden and fully transparent layers (only leaves without interactions, exports or
     * comments). Unset: the workflow asks the user when there are any; false: keep them.
     */
    removeHidden?: boolean;
    /**
     * Decisions taken by the caller instead of the review turn (the chat's tool): ids of listed
     * proposals to leave out, and names of components (`C:<id>` → name).
     */
    skip?: string[];
    componentNames?: Record<string, string>;
    /** `planId` of the listing the caller decided on; the run stops if the proposals changed */
    expectedPlan?: string;
}

/** Error of a run, message `cleanup/<code>[: detail]`. */
export class CleanupError extends Error {
    constructor(
        public readonly code:
            "no-selection" | "no-page" | "read-failed" | "checkpoint-failed" | "plan-changed" | "busy",
        detail?: string
    ) {
        super(`cleanup/${code}${detail ? `: ${detail}` : ""}`);
        this.name = "CleanupError";
    }
}

/** Saves the checkpoint a run needs before changing anything; null or a throw stops the run. */
export type CheckpointSaver = (ctx: WorkflowContext, label: string) => Promise<{ id: string; n: number } | null>;

/** Tuning of a run (tests shorten the waits). */
export interface CleanupTuning {
    /** wait after a change before the "after" screenshot, so layouts have reflowed */
    settleMs?: number;
    /** time after which the run stops starting new steps (default 20 min) */
    budgetMs?: number;
    /** layouts per `execute_code` call */
    layoutChunk?: number;
    /** time one layout script may spend */
    layoutScriptBudgetMs?: number;
    /** checkpoint before the first change (default: W19 checkpoint with a saved design version) */
    checkpoint?: CheckpointSaver;
}

/** Claude's review of the proposals. */
export interface CleanupReview {
    skip: Set<string>;
    names: Map<string, string>;
    notes: string | null;
}

/** Tool filter of the review turn, which needs no tool. */
class NoToolsFilter implements WorkflowToolFilter {
    public check(): string | null {
        return "No tools are available while reviewing the tidy-up; answer with the JSON object only.";
    }
}

/** Screenshot of a layer. */
interface Shot {
    base64: string;
}

/** Hidden or transparent layers asked about, and what the user chose. */
interface HiddenDecision {
    remove: boolean;
}

/**
 * Runs a tidy-up (W17): reads the page or selection, finds junk, rows/columns/grids and
 * look-alike items with {@link CleanupHeuristics}, lets Claude review them, saves a checkpoint
 * (required), then applies them unit by unit (top-level layer), comparing screenshots before and
 * after each step at one screenshot pixel per design pixel; a step that changes the look is taken
 * back. Hidden layers are removed only when the user asks. Auto-naming (W16) runs last.
 */
export class ImportCleaner {
    public static readonly DEFAULT_THRESHOLD = 0.002;
    /** biggest screenshot of a unit; bigger units are compared at a smaller scale plus per layer */
    public static readonly MAX_SHOT_PIXELS = 12_000_000;
    public static readonly DEFAULT_BUDGET_MS = 20 * 60_000;
    public static readonly DEFAULT_LAYOUT_CHUNK = 6;
    /** longest side of the screenshots Claude reviews */
    private static readonly REVIEW_SHOT_SIZE = 1024;
    private static readonly REVIEW_SHOTS = 3;
    /** most single layout retries per unit after a combined step failed */
    private static readonly MAX_RETRIES = 12;
    private static readonly HIDDEN_NAMES = 20;

    private readonly threshold: number;
    private readonly settleMs: number;
    private readonly deadline: number;
    private readonly layoutChunk: number;
    private readonly layoutScriptBudgetMs: number;
    private readonly saveCheckpoint: CheckpointSaver;
    private scan!: CleanupScan;
    private pageId = "";
    /** ids of groups that became boards, and their reverts */
    private remap: Record<string, string> = {};
    private readonly baselines = new Map<string, Shot>();
    private readonly scales = new Map<string, number>();
    private readonly reports = new Map<string, UnitReport>();
    private readonly components: ComponentReport[] = [];
    /** units that must not be changed any more (a revert did not restore them) */
    private readonly frozen = new Set<string>();
    private hiddenRemoved = 0;
    private stopped: CleanupResult["stopped"] = null;
    private stepCount = 0;

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly params: CleanupParams,
        tuning: CleanupTuning = {}
    ) {
        const threshold = Number(params.threshold);
        this.threshold =
            Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
                ? threshold
                : ImportCleaner.DEFAULT_THRESHOLD;
        this.settleMs = tuning.settleMs ?? 600;
        this.deadline = Date.now() + (tuning.budgetMs ?? ImportCleaner.DEFAULT_BUDGET_MS);
        this.layoutChunk = Math.max(1, tuning.layoutChunk ?? ImportCleaner.DEFAULT_LAYOUT_CHUNK);
        this.layoutScriptBudgetMs = tuning.layoutScriptBudgetMs ?? CleanupScripts.LAYOUT_SCRIPT_BUDGET_MS;
        this.saveCheckpoint = tuning.checkpoint ?? ImportCleaner.designCheckpoint;
    }

    public async run(): Promise<CleanupResult> {
        if (this.params.dryRun === true) {
            return this.execute(true);
        }
        const key = this.ctx.context?.fileId || this.params.pageId || this.ctx.context?.pageId || "file";
        const release = CleanupLock.acquire(key);
        if (!release) {
            throw new CleanupError("busy");
        }
        try {
            return await this.execute(false);
        } finally {
            release();
        }
    }

    private async execute(dryRun: boolean): Promise<CleanupResult> {
        const steps = { junk: true, layouts: true, components: true, names: true, ...(this.params.steps ?? {}) };
        this.progress("scan", "Reading the layers");
        this.scan = await this.read();
        this.pageId = this.scan.pageId;
        for (const unitId of this.scan.units) {
            const node = this.scan.nodes.get(unitId)!;
            this.reports.set(unitId, {
                id: unitId,
                name: node.name,
                junkRemoved: 0,
                junkReverted: 0,
                layoutsApplied: 0,
                layoutsReverted: 0,
                maxDiff: 0,
                layouts: [],
            });
            this.scales.set(unitId, ImportCleaner.unitScale(node));
        }
        const heuristics = new CleanupHeuristics(this.scan);
        const allJunk = steps.junk ? heuristics.junk() : [];
        const hiddenJunk = allJunk.filter(ImportCleaner.isHiddenJunk);
        const plainJunk = allJunk.filter((item) => !ImportCleaner.isHiddenJunk(item));
        const hiddenLayers = heuristics.hiddenLayers();
        const listedLayouts = steps.layouts ? heuristics.layouts(new Set(plainJunk.map((item) => item.nodeId))) : [];
        const components = steps.components ? heuristics.components() : [];
        const listed: CleanupProposal[] = [...allJunk, ...listedLayouts, ...components];
        const planId = ImportCleaner.planId(listed);
        const hidden = {
            count: hiddenLayers.length,
            removed: 0,
            names: hiddenLayers.slice(0, ImportCleaner.HIDDEN_NAMES).map((node) => node.name),
        };

        const result = (extra: Partial<CleanupResult> & { renamed?: number }): CleanupResult =>
            this.result(dryRun, planId, hidden, extra);
        if (dryRun) {
            return result({ proposals: listed });
        }
        if (this.params.expectedPlan !== undefined && this.params.expectedPlan !== planId) {
            throw new CleanupError("plan-changed");
        }

        const decision = await this.decideHidden(hiddenJunk);
        const junk = decision.remove ? allJunk : plainJunk;
        const layouts =
            decision.remove && hiddenJunk.length > 0 && steps.layouts
                ? heuristics.layouts(new Set(junk.map((item) => item.nodeId))).map((item) => ({ ...item }))
                : listedLayouts;
        const proposals: CleanupProposal[] = [...junk, ...layouts, ...components];

        let review: CleanupReview = { skip: new Set(), names: new Map(), notes: null };
        if (this.params.skip !== undefined || this.params.componentNames !== undefined) {
            review = ImportCleaner.parseReview(
                JSON.stringify({ skip: this.params.skip ?? [], names: this.params.componentNames ?? {} }),
                listed
            );
        } else if (this.params.review !== false && proposals.length > 0) {
            review = await this.review(proposals);
        }
        const kept = proposals.filter((proposal) => !review.skip.has(proposal.id));
        let checkpoint: CleanupResult["checkpoint"] = null;
        if (kept.length > 0) {
            this.progress("checkpoint", "Saving a checkpoint");
            checkpoint = await this.checkpointOrStop();
        }
        this.checkAborted();

        for (const unitId of this.scan.units) {
            if (this.outOfTime()) {
                break;
            }
            const unitJunk = junk.filter((item) => item.unitId === unitId && !review.skip.has(item.id));
            const unitLayouts = layouts.filter((item) => item.unitId === unitId && !review.skip.has(item.id));
            if (unitJunk.length > 0) {
                await this.guard(unitId, "junk", () => this.junkStep(unitId, unitJunk));
            }
            if (unitLayouts.length > 0 && !this.outOfTime()) {
                await this.guard(unitId, "layout", () => this.layoutStep(unitId, unitLayouts));
            }
            this.checkAborted();
        }

        if (steps.components && kept.some((proposal) => proposal.kind === "component") && !this.outOfTime()) {
            await this.componentSteps(components, review);
        }

        let renamed = 0;
        if (steps.names && checkpoint && !this.outOfTime()) {
            this.progress("names", "Naming layers");
            try {
                const named = await autoName(this.ctx, {
                    scope: "selection",
                    nodeIds: this.namingRoots(),
                    pageId: this.pageId,
                    apply: true,
                    includeComponents: true,
                });
                renamed = named.appliedCount;
            } catch (error) {
                if (this.ctx.signal.aborted) {
                    throw error;
                }
                this.log("names-failed", { message: describe(error) }, `Could not name the layers: ${describe(error)}`);
            }
        }
        hidden.removed = this.hiddenRemoved;
        const applied = [...this.reports.values()].some((unit) => unit.junkRemoved + unit.layoutsApplied > 0);
        return result({
            checkpoint,
            skipped: [...review.skip],
            notes: review.notes,
            renamed,
            proposals: applied || this.components.some((c) => c.outcome === "applied") ? undefined : proposals,
        });
    }

    // --- Checkpoint and decisions

    /** Saves the checkpoint; without one nothing is changed. */
    private async checkpointOrStop(): Promise<{ id: string; n: number }> {
        let saved: { id: string; n: number } | null;
        try {
            saved = await this.saveCheckpoint(this.ctx, `Before tidying up ${this.scan.pageName}`);
        } catch (error) {
            if (this.ctx.signal.aborted) {
                throw error;
            }
            throw error instanceof CleanupError ? error : new CleanupError("checkpoint-failed", describe(error));
        }
        if (!saved) {
            throw new CleanupError("checkpoint-failed");
        }
        return saved;
    }

    /** Default checkpoint: W19 checkpoint that must hold a Penpot version of the file. */
    public static async designCheckpoint(ctx: WorkflowContext, label: string): Promise<{ id: string; n: number }> {
        if (!ctx.workspace) {
            throw new CleanupError("checkpoint-failed", "the file is not in a Penforge project");
        }
        const checkpoint = await new Checkpoints(ctx).create({ label, workflow: "cleanup-import" });
        if (!checkpoint.fileVersion) {
            throw new CleanupError(
                "checkpoint-failed",
                (checkpoint.warnings ?? []).join("; ") || "the design version was not saved"
            );
        }
        return { id: checkpoint.id, n: checkpoint.n };
    }

    /**
     * Whether hidden layers go: the `removeHidden` param, else the user's answer (asked only when
     * there are some). Keeping them is the default.
     */
    private async decideHidden(hiddenJunk: JunkProposal[]): Promise<HiddenDecision> {
        if (this.params.removeHidden !== undefined || hiddenJunk.length === 0) {
            return { remove: this.params.removeHidden === true && hiddenJunk.length > 0 };
        }
        const names = hiddenJunk.slice(0, 5).map((item) => item.name);
        this.ctx.emit("plan", { code: "hidden", count: hiddenJunk.length, names });
        const answer = await this.ctx.ask({
            text:
                `${hiddenJunk.length} hidden layers could be deleted (${names.map((n) => `"${n}"`).join(", ")}` +
                `${hiddenJunk.length > names.length ? ", …" : ""}). They may be states such as hover or error. ` +
                "Delete them too?",
            options: [
                { id: "keep", label: "Keep them" },
                { id: "delete", label: "Delete them" },
            ],
        });
        return { remove: answer === "delete" };
    }

    private static isHiddenJunk(item: JunkProposal): boolean {
        return item.reason === "hidden" || item.reason === "transparent";
    }

    /** Hash of the proposals: the same layers and changes give the same id. */
    public static planId(proposals: CleanupProposal[]): string {
        const keys = proposals
            .map((proposal) => {
                switch (proposal.kind) {
                    case "junk":
                        return `${proposal.id}|${proposal.reason}`;
                    case "layout":
                        return `${proposal.id}|${JSON.stringify(proposal.layout)}|${proposal.absoluteBelow.join(",")}`;
                    case "component":
                        return `${proposal.id}|${proposal.memberIds.join(",")}`;
                }
            })
            .sort();
        return createHash("sha1").update(keys.join("\n")).digest("hex").slice(0, 16);
    }

    // --- Reading

    /**
     * Layers in the run's scope that still have a default name ("Group 4"), outside components;
     * read again from the canvas. For callers that name layers themselves (the chat's tool).
     *
     * @param limit - most layers listed
     */
    public async defaultNamedLayers(
        limit = 150
    ): Promise<{ id: string; name: string; type: string; parent: string | null; text?: string }[]> {
        const scan = await this.read();
        const heuristics = new CleanupHeuristics(scan);
        const out: { id: string; name: string; type: string; parent: string | null; text?: string }[] = [];
        for (const node of scan.nodes.values()) {
            if (!scan.scope.has(node.id) || heuristics.isComponentized(node.id)) {
                continue;
            }
            const type = ImportCleaner.NAMING_TYPES[node.type] ?? node.type;
            if (!DefaultNames.isDefault(node.name, type)) {
                continue;
            }
            out.push({
                id: node.id,
                name: node.name,
                type: node.type,
                parent: node.parentId ? (scan.nodes.get(node.parentId)?.name ?? null) : null,
                ...(node.text ? { text: node.text.content.slice(0, 60) } : {}),
            });
            if (out.length >= limit) {
                break;
            }
        }
        return out;
    }

    /** Plugin type names as the auto-naming knows them. */
    private static readonly NAMING_TYPES: Record<string, string> = {
        board: "frame",
        rectangle: "rect",
        ellipse: "circle",
        boolean: "bool",
    };

    private async read(): Promise<CleanupScan> {
        const nodeIds = (this.params.nodeIds ?? [])
            .filter((id) => typeof id === "string" && id.length > 0)
            .map((id) => this.remap[id] ?? id);
        const selection = this.params.scope === "selection" || (this.params.scope === undefined && nodeIds.length > 0);
        if (selection && nodeIds.length === 0) {
            throw new CleanupError("no-selection");
        }
        const pageId = this.params.pageId ?? this.ctx.context.pageId ?? null;
        const plan = (await this.runCode(CleanupScripts.plan({ pageId, nodeIds: selection ? nodeIds : [] }))) as {
            pageId: string;
            pageName: string;
            units: { id: string; name: string; type: string }[];
            scopeRoots: string[];
            commented?: string[];
        };
        if (!plan || !Array.isArray(plan.units)) {
            throw new CleanupError("no-page");
        }
        if (selection && plan.scopeRoots.length === 0) {
            throw new CleanupError("no-selection");
        }
        const nodes = new Map<string, CleanupNode>();
        let truncated = false;
        const units: string[] = [];
        for (const unit of plan.units) {
            const data = (await this.runCode(CleanupScripts.read({ pageId: plan.pageId, unitId: unit.id }))) as {
                nodes: CleanupNode[];
                truncated: boolean;
            };
            if (!data || !Array.isArray(data.nodes)) {
                throw new CleanupError("read-failed", "unexpected layer data");
            }
            data.nodes.forEach((node) => nodes.set(node.id, node));
            truncated ||= data.truncated === true;
            if (nodes.has(unit.id)) {
                units.push(unit.id);
            }
        }
        const scope = new Set<string>();
        const roots = selection ? plan.scopeRoots : units;
        const add = (id: string) => {
            if (scope.has(id)) {
                return;
            }
            scope.add(id);
            nodes.get(id)?.children.forEach(add);
        };
        roots.forEach(add);
        return {
            pageId: plan.pageId,
            pageName: plan.pageName,
            units,
            nodes,
            scope,
            truncated,
            commented: new Set(plan.commented ?? []),
        };
    }

    // --- Review

    private async review(proposals: CleanupProposal[]): Promise<CleanupReview> {
        const empty: CleanupReview = { skip: new Set(), names: new Map(), notes: null };
        this.progress("review", "Checking the changes");
        try {
            const attachments = await this.reviewShots(proposals);
            const answer = await this.ctx.runner.run({
                prompt: this.reviewPrompt(proposals),
                promptName: "cleanup-import",
                attachments,
                toolFilter: new NoToolsFilter(),
            });
            return ImportCleaner.parseReview(answer.text, proposals);
        } catch (error) {
            if (this.ctx.signal.aborted) {
                throw error;
            }
            this.log("review-failed", { message: describe(error) }, `Review skipped: ${describe(error)}`);
            return empty;
        }
    }

    private reviewPrompt(proposals: CleanupProposal[]): string {
        const names = (id: string) => this.scan.nodes.get(id)?.name ?? id;
        const lines = proposals.map((proposal) => {
            switch (proposal.kind) {
                case "junk":
                    return {
                        id: proposal.id,
                        kind: "junk",
                        layer: proposal.name,
                        board: names(proposal.unitId),
                        reason: proposal.reason,
                    };
                case "layout": {
                    const layout = proposal.layout;
                    const change =
                        layout.type === "flex"
                            ? `flex ${layout.dir}, gap ${layout.gap}, align ${layout.align}, ${layout.order.length} items`
                            : `grid ${layout.columns.length}x${layout.rows.length}, gaps ${layout.columnGap}/${layout.rowGap}`;
                    return {
                        id: proposal.id,
                        kind: "layout",
                        layer: proposal.name,
                        board: names(proposal.unitId),
                        group: proposal.convert,
                        change,
                        items: (layout.type === "flex" ? layout.order : layout.cells.map((cell) => cell.id))
                            .slice(0, 6)
                            .map(names),
                    };
                }
                case "component":
                    return {
                        id: proposal.id,
                        kind: "component",
                        name: proposal.name,
                        count: proposal.memberIds.length,
                        size: `${Math.round(proposal.width)}x${Math.round(proposal.height)}`,
                        layers: proposal.size,
                        boards: proposal.unitIds.map(names),
                        texts: this.texts(proposal.memberIds[0]).slice(0, 4),
                    };
            }
        });
        return [
            `Page "${this.scan.pageName}". ${proposals.length} proposed changes:`,
            ...lines.map((line) => JSON.stringify(line)),
        ].join("\n");
    }

    private texts(id: string): string[] {
        const out: string[] = [];
        const visit = (nodeId: string) => {
            const node = this.scan.nodes.get(nodeId);
            if (!node) {
                return;
            }
            if (node.text?.content) {
                out.push(node.text.content.slice(0, 40));
            }
            node.children.forEach(visit);
        };
        visit(id);
        return out;
    }

    private async reviewShots(proposals: CleanupProposal[]): Promise<Attachment[]> {
        const counts = new Map<string, number>();
        for (const proposal of proposals) {
            const unitIds = proposal.kind === "component" ? proposal.unitIds : [proposal.unitId];
            unitIds.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
        }
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, ImportCleaner.REVIEW_SHOTS);
        const attachments: Attachment[] = [];
        for (const [unitId] of ranked) {
            const node = this.scan.nodes.get(unitId);
            if (!node) {
                continue;
            }
            const shot = await this.capture(
                unitId,
                ImportCleaner.scaleFor(node, ImportCleaner.REVIEW_SHOT_SIZE),
                "jpeg"
            );
            if (shot) {
                attachments.push({ kind: "image", mime: "image/jpeg", base64: shot.base64 });
            }
        }
        return attachments;
    }

    /**
     * Reads Claude's review answer: `{skip:[id], names:{id: name}, notes}`. Unknown ids are
     * dropped; an unreadable answer skips nothing.
     */
    public static parseReview(text: string, proposals: CleanupProposal[]): CleanupReview {
        const ids = new Set(proposals.map((proposal) => proposal.id));
        const review: CleanupReview = { skip: new Set(), names: new Map(), notes: null };
        const match = /\{[\s\S]*\}/.exec(text ?? "");
        if (!match) {
            return review;
        }
        let data: any;
        try {
            data = JSON.parse(match[0]);
        } catch {
            return review;
        }
        if (Array.isArray(data?.skip)) {
            data.skip
                .filter((id: unknown) => typeof id === "string" && ids.has(id))
                .forEach((id: string) => review.skip.add(id));
        }
        if (data?.names && typeof data.names === "object") {
            for (const [id, name] of Object.entries(data.names)) {
                const clean =
                    typeof name === "string"
                        ? name
                              .replace(/[\r\n\t/]+/g, " ")
                              .trim()
                              .slice(0, 64)
                        : "";
                if (ids.has(id) && clean.length > 0) {
                    review.names.set(id, clean);
                }
            }
        }
        if (typeof data?.notes === "string" && data.notes.trim().length > 0) {
            review.notes = data.notes.trim().slice(0, 500);
        }
        return review;
    }

    // --- Junk step (one undo block: hide, compare, then remove or show again)

    private async junkStep(unitId: string, items: JunkProposal[]): Promise<void> {
        const report = this.reports.get(unitId)!;
        const before = await this.baseline(unitId);
        if (!before) {
            this.log("no-screenshot", { board: report.name }, `No screenshot of "${report.name}": unused layers kept`);
            return;
        }
        this.progress("junk", `Removing ${items.length} unused layers`, { board: report.name, count: items.length });
        const ids = items.map((item) => item.nodeId);
        const hidden = (await this.runCode(CleanupScripts.junkHide(this.pageId, items))) as { hidden: string[] };
        if (hidden.hidden.length > 0) {
            const after = await this.captureAfter(unitId);
            const score = after ? await this.compare(before, after) : null;
            if (!score || !PixelDiff.passes(score, this.threshold)) {
                await this.runCode(CleanupScripts.junkFinish(this.pageId, [], hidden.hidden));
                report.junkReverted += items.length;
                this.reverted(report.name, "junk", score);
                return;
            }
            report.maxDiff = Math.max(report.maxDiff, score.ratio);
            this.baselines.set(this.unitId(unitId), after!);
        }
        const removed = (await this.runCode(CleanupScripts.junkFinish(this.pageId, ids, []))) as { removed: number };
        report.junkRemoved += removed.removed;
        this.hiddenRemoved += items.filter(ImportCleaner.isHiddenJunk).length;
    }

    // --- Layout step

    private async layoutStep(unitId: string, items: LayoutProposal[]): Promise<void> {
        const report = this.reports.get(unitId)!;
        const before = await this.baseline(unitId);
        if (!before) {
            this.log("no-screenshot", { board: report.name }, `No screenshot of "${report.name}": layouts skipped`);
            return;
        }
        this.progress("layout", `Adding layouts in "${report.name}"`, { board: report.name, count: items.length });
        const regions = await this.regionBaselines(
            unitId,
            items.map((item) => item.nodeId)
        );
        const first = await this.applyLayouts(items);
        if (first.undos.length === 0) {
            return;
        }
        const after = await this.captureAfter(unitId);
        const score = after ? await this.compare(before, after) : null;
        if (score && PixelDiff.passes(score, this.threshold) && (await this.regionsPass(regions))) {
            this.keepLayouts(unitId, items, first.undos, score, after!);
            report.layoutsReverted += first.notTried;
            return;
        }
        // take all back, then try the layouts one by one
        this.reverted(report.name, "layout", score);
        if (!(await this.revertLayouts(unitId, first.undos, before))) {
            return;
        }
        let baseline = this.baselines.get(this.unitId(unitId)) ?? before;
        const tried = items.filter((item) => first.undos.some((undo) => undo.id === item.id));
        const retries = tried.slice(0, ImportCleaner.MAX_RETRIES);
        for (const item of retries) {
            this.checkAborted();
            if (this.outOfTime()) {
                report.layoutsReverted++;
                continue;
            }
            const single = await this.applyLayouts([item]);
            if (single.undos.length === 0) {
                continue;
            }
            const shot = await this.captureAfter(unitId);
            const one = shot ? await this.compare(baseline, shot) : null;
            const region = regions.filter((entry) => entry.nodeId === item.nodeId);
            if (one && PixelDiff.passes(one, this.threshold) && (await this.regionsPass(region))) {
                this.keepLayouts(unitId, [item], single.undos, one, shot!);
                baseline = shot!;
            } else {
                report.layoutsReverted++;
                if (!(await this.revertLayouts(unitId, single.undos, baseline))) {
                    return;
                }
                baseline = this.baselines.get(this.unitId(unitId)) ?? baseline;
            }
        }
        report.layoutsReverted += Math.max(0, tried.length - retries.length) + first.notTried;
    }

    /**
     * Applies layouts in chunks (one `execute_code` and one undo block each); items a script had
     * no time for go into the next chunk. Stops starting chunks when the run is out of time.
     */
    private async applyLayouts(items: LayoutProposal[]): Promise<{ undos: LayoutUndo[]; notTried: number }> {
        // a group with a default name becomes "Board", so that the naming step sees a default name
        const queue = items.map((item) =>
            item.convert && DefaultNames.isDefault(item.name, "group") ? { ...item, boardName: "Board" } : item
        );
        const undos: LayoutUndo[] = [];
        while (queue.length > 0) {
            this.checkAborted();
            if (this.outOfTime()) {
                break;
            }
            const chunk = queue.splice(0, this.layoutChunk);
            const data = (await this.runCode(
                CleanupScripts.applyLayouts(this.pageId, chunk, this.remap, this.layoutScriptBudgetMs)
            )) as {
                results: { id: string; ok: boolean; deferred?: boolean; error?: string; undo?: LayoutUndo }[];
                remap: Record<string, string>;
            };
            this.remap = data.remap ?? this.remap;
            const deferred: LayoutProposal[] = [];
            for (const result of data.results ?? []) {
                const item = chunk.find((candidate) => candidate.id === result.id);
                if (result.ok && result.undo) {
                    undos.push(result.undo);
                } else if (result.deferred && item) {
                    deferred.push(item);
                } else if (!result.ok) {
                    this.log(
                        "layout-failed",
                        { layer: item?.name ?? result.id, message: result.error ?? "" },
                        `Could not add a layout to "${item?.name ?? result.id}": ${result.error ?? ""}`
                    );
                }
            }
            if (deferred.length === chunk.length) {
                // the script had no time even for one: give up on the rest instead of looping
                queue.unshift(...deferred);
                break;
            }
            queue.unshift(...deferred);
        }
        return { undos, notTried: queue.length };
    }

    private keepLayouts(
        unitId: string,
        items: LayoutProposal[],
        undos: LayoutUndo[],
        score: DiffScore,
        shot: Shot
    ): void {
        const report = this.reports.get(unitId)!;
        for (const undo of undos) {
            const item = items.find((candidate) => candidate.id === undo.id);
            if (!item) {
                continue;
            }
            report.layoutsApplied++;
            report.layouts.push(
                item.layout.type === "flex"
                    ? { name: item.name, type: "flex", dir: item.layout.dir }
                    : { name: item.name, type: "grid" }
            );
        }
        report.maxDiff = Math.max(report.maxDiff, score.ratio);
        this.baselines.set(this.unitId(unitId), shot);
    }

    /**
     * Takes layouts back (chunked, last first) and checks the unit looks like `expected` again.
     * A unit whose revert does not restore it is frozen (no more changes) and reported.
     */
    private async revertLayouts(unitId: string, undos: LayoutUndo[], expected: Shot): Promise<boolean> {
        const errors: { id: string; error: string }[] = [];
        for (let end = undos.length; end > 0; end -= this.layoutChunk) {
            const chunk = undos.slice(Math.max(0, end - this.layoutChunk), end);
            const data = (await this.runCode(CleanupScripts.revertLayouts(this.pageId, chunk, this.remap))) as {
                reverted: number;
                errors: { id: string; error: string }[];
                remap: Record<string, string>;
            };
            this.remap = data.remap ?? this.remap;
            errors.push(...(data.errors ?? []));
        }
        const shot = await this.captureAfter(unitId);
        const score = shot ? await this.compare(expected, shot) : null;
        if (!shot || !score || !PixelDiff.passes(score, this.threshold) || errors.length > 0) {
            const name = this.reports.get(unitId)!.name;
            this.frozen.add(unitId);
            this.log("revert-incomplete", { board: name }, `"${name}" may still differ: use Undo or the checkpoint`);
            return false;
        }
        this.baselines.set(this.unitId(unitId), shot);
        return true;
    }

    // --- Component steps

    private async componentSteps(initial: ComponentProposal[], review: CleanupReview): Promise<void> {
        // layouts may have turned groups into boards: read again
        let proposals = initial;
        const changed = [...this.reports.values()].some((unit) => unit.junkRemoved + unit.layoutsApplied > 0);
        if (changed && initial.length > 0) {
            try {
                this.scan = await this.rescan();
                proposals = new CleanupHeuristics(this.scan).components();
            } catch (error) {
                if (this.ctx.signal.aborted) {
                    throw error;
                }
                this.log(
                    "read-failed",
                    { message: describe(error) },
                    `Could not read the layers again: ${describe(error)}`
                );
                return;
            }
        }
        for (const proposal of proposals) {
            this.checkAborted();
            if (this.outOfTime()) {
                break;
            }
            const origin = this.originOf(proposal, initial);
            // only what was proposed (and not skipped) at the start: nothing new after the review
            if (!origin || review.skip.has(origin.id)) {
                continue;
            }
            if (proposal.unitIds.some((unitId) => this.frozen.has(this.originalUnit(unitId)))) {
                continue;
            }
            const name = review.names.get(origin.id) ?? ImportCleaner.componentName(proposal.name);
            await this.guard(proposal.unitIds[0], "components", () => this.componentStep(proposal, name));
        }
    }

    private async componentStep(proposal: ComponentProposal, name: string): Promise<void> {
        const units = proposal.unitIds;
        const before = new Map<string, Shot>();
        for (const unitId of units) {
            const shot = await this.baseline(unitId);
            if (!shot) {
                this.log("no-screenshot", { name }, `No screenshot for "${name}": component not made`);
                return;
            }
            before.set(unitId, shot);
        }
        this.progress("components", `Making "${name}" a component`, { name, count: proposal.memberIds.length });
        const memberRegions = units.some((unitId) => this.isBig(unitId))
            ? await this.captureRegions(proposal.memberIds)
            : new Map<string, Shot>();
        const report: ComponentReport = { name, componentId: null, instances: 0, outcome: "failed", diff: 0 };
        this.components.push(report);
        const stepKey = `${this.ctx.runId ?? "run"}:${++this.stepCount}`;
        let step: {
            componentId: string | null;
            mainId: string;
            backupId: string | null;
            pairs: { memberId: string; copyId: string }[];
            errors: string[];
            failed?: string;
        };
        try {
            step = (await this.runCode(
                CleanupScripts.applyComponent(this.pageId, proposal, name, stepKey)
            )) as typeof step;
        } catch (error) {
            // the script did not answer: take back whatever it made
            await this.runCode(CleanupScripts.recoverComponent(this.pageId, stepKey, proposal.memberIds)).catch(
                () => undefined
            );
            this.dropBaselines(units);
            throw error;
        }
        if (step.failed) {
            this.dropBaselines(units);
            this.log("component-failed", { name, message: step.failed }, `Could not make "${name}": ${step.failed}`);
            return;
        }
        report.componentId = step.componentId;
        try {
            if (!step.componentId) {
                throw new Error("no component made");
            }
            let worst = 0;
            let pass = true;
            const afters = new Map<string, Shot>();
            for (const unitId of units) {
                const shot = await this.captureAfter(unitId);
                const score = shot ? await this.compare(before.get(unitId)!, shot) : null;
                worst = Math.max(worst, score ? score.ratio : 1);
                pass &&= !!score && PixelDiff.passes(score, this.threshold);
                if (shot) {
                    afters.set(unitId, shot);
                }
            }
            if (pass && memberRegions.size > 0) {
                const pairs = [{ memberId: proposal.memberIds[0], copyId: step.mainId }, ...step.pairs];
                for (const pair of pairs) {
                    const region = memberRegions.get(pair.memberId);
                    const shot = region ? await this.capture(pair.copyId, 1, "png") : null;
                    const score = region && shot ? await this.compare(region, shot) : null;
                    pass &&= !!score && PixelDiff.passes(score, this.threshold);
                }
            }
            report.diff = worst;
            if (!pass) {
                await this.runCode(CleanupScripts.revertComponent(this.pageId, step));
                report.outcome = "reverted";
                this.reverted(name, "components", { ratio: worst, maxTile: 0, width: 0, height: 0, sameSize: true });
                this.dropBaselines(units);
                return;
            }
            const remove = step.pairs.map((pair) => pair.memberId);
            if (step.backupId) {
                remove.push(step.backupId);
            }
            await this.runCode(
                CleanupScripts.keepComponent(this.pageId, remove, [
                    step.mainId,
                    ...step.pairs.map((pair) => pair.copyId),
                ])
            );
            report.outcome = "applied";
            report.instances = step.pairs.length + 1;
            for (const [unitId, shot] of afters) {
                this.baselines.set(this.unitId(unitId), shot);
                const unit = this.reports.get(this.originalUnit(unitId));
                if (unit) {
                    unit.maxDiff = Math.max(unit.maxDiff, worst);
                }
            }
        } catch (error) {
            if (report.outcome !== "applied") {
                await this.runCode(CleanupScripts.revertComponent(this.pageId, step)).catch(() =>
                    this.runCode(CleanupScripts.recoverComponent(this.pageId, stepKey, proposal.memberIds)).catch(
                        () => undefined
                    )
                );
                report.outcome = "failed";
                this.dropBaselines(units);
            }
            throw error;
        }
    }

    private async rescan(): Promise<CleanupScan> {
        const nodes = new Map<string, CleanupNode>();
        const units: string[] = [];
        let truncated = false;
        for (const original of this.scan.units) {
            if (this.frozen.has(this.originalUnit(original))) {
                continue;
            }
            const unitId = this.unitId(original);
            const data = (await this.runCode(CleanupScripts.read({ pageId: this.pageId, unitId }))) as {
                nodes: CleanupNode[];
                truncated: boolean;
            };
            data.nodes.forEach((node) => nodes.set(node.id, node));
            truncated ||= data.truncated === true;
            units.push(unitId);
        }
        // the scope keeps every layer that was in it, under its new id, and what is inside
        const wasInScope = (id: string) =>
            this.scan.scope.has(id) ||
            Object.entries(this.remap).some(([from, to]) => to === id && this.scan.scope.has(from));
        const scope = new Set<string>();
        const add = (id: string) => {
            if (scope.has(id)) {
                return;
            }
            scope.add(id);
            nodes.get(id)?.children.forEach(add);
        };
        for (const id of nodes.keys()) {
            if (wasInScope(id)) {
                add(id);
            }
        }
        return {
            pageId: this.pageId,
            pageName: this.scan.pageName,
            units,
            nodes,
            scope,
            truncated,
            commented: this.scan.commented,
        };
    }

    /** The first-run proposal that shares members with a proposal of the second read. */
    private originOf(proposal: ComponentProposal, initial: ComponentProposal[]): ComponentProposal | undefined {
        const current = new Set(proposal.memberIds);
        return initial.find((candidate) => candidate.memberIds.some((id) => current.has(this.remap[id] ?? id)));
    }

    // --- Screenshots

    /** True when the unit is compared below one screenshot pixel per design pixel. */
    private isBig(unitId: string): boolean {
        return (this.scales.get(this.originalUnit(unitId)) ?? 1) < 1;
    }

    /** Screenshots of layers at full scale, taken before a step on a big unit. */
    private async regionBaselines(unitId: string, nodeIds: string[]): Promise<{ nodeId: string; shot: Shot }[]> {
        if (!this.isBig(unitId)) {
            return [];
        }
        const shots = await this.captureRegions(nodeIds);
        return nodeIds.filter((id) => shots.has(id)).map((id) => ({ nodeId: id, shot: shots.get(id)! }));
    }

    private async captureRegions(nodeIds: string[]): Promise<Map<string, Shot>> {
        const shots = new Map<string, Shot>();
        for (const id of nodeIds) {
            const shot = await this.capture(this.remap[id] ?? id, 1, "png");
            if (shot) {
                shots.set(id, shot);
            }
        }
        return shots;
    }

    /** Compares layers (under their current ids) with their full-scale screenshots from before. */
    private async regionsPass(regions: { nodeId: string; shot: Shot }[]): Promise<boolean> {
        for (const region of regions) {
            const shot = await this.capture(this.remap[region.nodeId] ?? region.nodeId, 1, "png");
            const score = shot ? await this.compare(region.shot, shot) : null;
            if (!score || !PixelDiff.passes(score, this.threshold)) {
                return false;
            }
        }
        return true;
    }

    private async baseline(unitId: string): Promise<Shot | null> {
        const current = this.unitId(unitId);
        const cached = this.baselines.get(current);
        if (cached) {
            return cached;
        }
        const shot = await this.capture(current, this.scales.get(this.originalUnit(unitId)) ?? 1, "png");
        if (shot) {
            this.baselines.set(current, shot);
        }
        return shot;
    }

    private dropBaselines(unitIds: string[]): void {
        unitIds.forEach((unitId) => this.baselines.delete(this.unitId(unitId)));
    }

    private async captureAfter(unitId: string): Promise<Shot | null> {
        if (this.settleMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.settleMs));
        }
        return this.capture(this.unitId(unitId), this.scales.get(this.originalUnit(unitId)) ?? 1, "png");
    }

    private async capture(nodeId: string, scale: number, format: "png" | "jpeg"): Promise<Shot | null> {
        let result: WorkflowToolResult;
        try {
            result = await this.ctx.tools.call("capture_node_screenshot", { nodeId, scale, format });
        } catch {
            return null;
        }
        if (result.isError) {
            return null;
        }
        const block = (result.content as any[]).find((part) => part?.type === "image" && typeof part.data === "string");
        return block ? { base64: block.data } : null;
    }

    private async compare(before: Shot, after: Shot): Promise<DiffScore> {
        try {
            return await PixelDiff.compareBase64(before.base64, after.base64);
        } catch {
            return { ratio: 1, maxTile: 1, width: 0, height: 0, sameSize: false };
        }
    }

    /**
     * Scale of a unit's comparison screenshots: 1 (one screenshot pixel per design pixel) unless
     * that passes {@link MAX_SHOT_PIXELS}; then smaller, and the changed layers are also compared
     * one by one at scale 1.
     */
    public static unitScale(node: { width: number; height: number }): number {
        const area = Math.max(1, node.width) * Math.max(1, node.height);
        if (area <= ImportCleaner.MAX_SHOT_PIXELS) {
            return 1;
        }
        return Math.max(0.1, Math.floor(Math.sqrt(ImportCleaner.MAX_SHOT_PIXELS / area) * 100) / 100);
    }

    /** Scale that keeps the longest side at most `size` pixels (at most 1). */
    public static scaleFor(node: { width: number; height: number }, size: number): number {
        const longest = Math.max(1, node.width, node.height);
        return Math.round(Math.min(1, Math.max(0.1, size / longest)) * 100) / 100;
    }

    // --- Ids

    /** Current id of a unit (a top-level group may have become a board). */
    private unitId(id: string): string {
        return this.remap[id] ?? id;
    }

    /** Report id of a unit given its current id. */
    private originalUnit(id: string): string {
        if (this.reports.has(id)) {
            return id;
        }
        const entry = Object.entries(this.remap).find(([, to]) => to === id);
        return entry ? entry[0] : id;
    }

    private namingRoots(): string[] {
        const roots =
            this.params.scope === "page" || (this.params.nodeIds ?? []).length === 0
                ? this.scan.units
                : (this.params.nodeIds ?? []);
        return [...new Set(roots.map((id) => this.remap[id] ?? id))];
    }

    // --- Helpers

    private async guard(unitId: string, step: string, action: () => Promise<void>): Promise<void> {
        if (this.frozen.has(this.originalUnit(unitId))) {
            return;
        }
        try {
            await action();
        } catch (error) {
            if (this.ctx.signal.aborted) {
                throw error;
            }
            const name = this.reports.get(this.originalUnit(unitId))?.name ?? unitId;
            this.log(
                "step-failed",
                { board: name, step, message: describe(error) },
                `${step} step failed in "${name}": ${describe(error)}`
            );
            this.baselines.delete(this.unitId(unitId));
        }
    }

    private outOfTime(): boolean {
        if (Date.now() <= this.deadline) {
            return false;
        }
        if (!this.stopped) {
            this.stopped = "time-budget";
            this.log("time-budget", {}, "Stopped early: the tidy-up ran out of time; run it again for the rest");
        }
        return true;
    }

    private async runCode(code: string): Promise<unknown> {
        const result = await this.ctx.tools.call("execute_code", { code });
        if (result.isError) {
            throw new Error(result.text || "execute_code failed");
        }
        let parsed: any;
        try {
            parsed = JSON.parse(result.text);
        } catch {
            throw new Error(`unexpected execute_code output: ${result.text.slice(0, 200)}`);
        }
        const value = parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
        if (typeof value !== "string") {
            return value;
        }
        try {
            return JSON.parse(value);
        } catch {
            throw new Error(`unexpected output: ${value.slice(0, 200)}`);
        }
    }

    private progress(step: string, text: string, params?: Record<string, unknown>): void {
        this.ctx.emit("progress", params ? { step, params, text } : { step, text });
    }

    private log(code: string, params: Record<string, unknown>, text: string): void {
        this.ctx.emit("log", { code, params, text });
    }

    private reverted(name: string, step: string, score: DiffScore | null): void {
        const diff = score ? Math.round(score.ratio * 1000) / 10 : null;
        this.log(
            "reverted",
            { board: name, step, diff },
            `Took the ${step} step in "${name}" back: it changed ${diff ?? "?"}% of the pixels`
        );
    }

    private checkAborted(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }

    private result(
        dryRun: boolean,
        planId: string,
        hidden: CleanupResult["hidden"],
        extra: Partial<CleanupResult> & { renamed?: number }
    ): CleanupResult {
        const units = [...this.reports.values()];
        const applied = this.components.filter((c) => c.outcome === "applied");
        return {
            pageId: this.pageId,
            pageName: this.scan.pageName,
            dryRun,
            truncated: this.scan.truncated,
            checkpoint: extra.checkpoint ?? null,
            units,
            components: this.components,
            totals: {
                junk: units.reduce((sum, unit) => sum + unit.junkRemoved, 0),
                layouts: units.reduce((sum, unit) => sum + unit.layoutsApplied, 0),
                layoutsReverted: units.reduce((sum, unit) => sum + unit.layoutsReverted, 0),
                components: applied.length,
                instances: applied.reduce((sum, c) => sum + c.instances, 0),
                componentsReverted: this.components.filter((c) => c.outcome !== "applied").length,
                renamed: extra.renamed ?? 0,
            },
            ...(extra.proposals ? { proposals: extra.proposals } : {}),
            skipped: extra.skipped ?? [],
            notes: extra.notes ?? null,
            threshold: this.threshold,
            planId,
            hidden,
            stopped: this.stopped,
        };
    }

    /** Name of a component made from a layer: its name, unless that is a default name. */
    public static componentName(name: string): string {
        const clean = name.replace(/[\r\n\t/]+/g, " ").trim();
        return /^(board|frame|group|rectangle|component)\s*\d*$/i.test(clean) || clean.length === 0 ? "Item" : clean;
    }
}

/** Summary line of a run, for `workflow.done` (English fallback; clients use `result`). */
export function describeCleanup(result: CleanupResult): string {
    const t = result.totals;
    if (result.dryRun) {
        return `${result.proposals?.length ?? 0} possible changes found`;
    }
    const kept = result.hidden.count - result.hidden.removed;
    const hidden = kept > 0 ? `; kept ${kept} hidden layers` : "";
    const stopped = result.stopped ? "; stopped early (time limit)" : "";
    if (t.junk + t.layouts + t.components + t.renamed === 0) {
        return `Nothing to tidy up${hidden}${stopped}`;
    }
    return `Removed ${t.junk} unused layers, added ${t.layouts} layouts, made ${t.components} components (${t.instances} items), renamed ${t.renamed} layers${hidden}${stopped}`;
}

/** The `cleanup-import` workflow. */
export const workflow: Workflow<CleanupParams> = {
    name: "cleanup-import",
    description:
        "Tidy up a page or selection: remove unused layers, turn lined-up layers into flex/grid layouts, make components from look-alike items, then name layers.",
    run: async (ctx, params) => {
        const result = await new ImportCleaner(ctx, params ?? {}).run();
        ctx.emit("result", result);
        return { summary: describeCleanup(result) };
    },
};

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
