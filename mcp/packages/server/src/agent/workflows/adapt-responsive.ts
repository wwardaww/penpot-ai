import type { Attachment, Workflow, WorkflowContext, WorkflowEventKind, WorkflowResult } from "@penpot/mcp-common";

/** Screen size a board is adapted to. */
export type AdaptTarget = "mobile" | "desktop";

/** Params of the `adapt-responsive` workflow. */
export interface AdaptResponsiveParams {
    /** id of the top-level board to adapt */
    boardId: string;
    /** screen size of the new board */
    target: AdaptTarget;
    /** width of the new board; defaults to the target's preset width */
    width?: number;
}

/** Board preset of a target (W05 platform boards, architecture §8). */
export interface AdaptPreset {
    width: number;
    height: number;
    /** suffix of the new board's name (`<Board> / <label>`) */
    label: string;
}

/** Position and size of a board, as returned by the plugin code. */
export interface BoardBox {
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Result of {@link AdaptPluginCode} `pfPrepare`. */
export interface PrepareResult {
    /** `ready` answers a dry run: nothing was changed */
    status: "created" | "exists" | "ready";
    pageId: string;
    /** id of the board the whole group is a variant of (the first source) */
    variantOf: string;
    source: BoardBox;
    /** the new board; missing when `status` is `exists` */
    board?: BoardBox;
    /** boards of the same group that already have the target */
    existing: { id: string; name: string }[];
    /** main components of the source replaced with instances in the copy */
    replacedMains?: number;
}

/** Problem found by the self-check. */
export interface AdaptIssue {
    kind: "overflow-x" | "small-text";
    id: string;
    name: string;
    type: string;
    /** x relative to the board (overflow-x) */
    x?: number;
    width?: number;
    /** pixels outside the board (overflow-x) */
    overBy?: number;
    /** font size (small-text) */
    fontSize?: number;
}

/** Result of {@link AdaptPluginCode} `pfCheck`. */
export interface CheckResult {
    board: BoardBox;
    issues: AdaptIssue[];
    /** number of issues found, also those cut from `issues` */
    issueCount: number;
    /** lowest point of the board's direct children, relative to the board top */
    contentBottom: number;
}

/** Result of {@link AdaptPluginCode} `pfFitHeight`. */
export interface FitHeightResult {
    changed: boolean;
    height: number;
}

/**
 * Step of a run, sent as `code` in `progress` events (with an English `text` fallback); the
 * frontend translates it.
 */
export type AdaptProgressCode = "copy" | "read" | "reflow" | "check" | "fix";

/** Payload of the `plan` event sent before asking whether to make another variant. */
export interface AdaptExistsPayload {
    code: "exists";
    target: AdaptTarget;
    sourceName: string;
    existing: string[];
}

/** Payload of the `result` event when the user kept the existing variant. */
export interface AdaptKeptPayload {
    status: "kept";
    target: AdaptTarget;
    existing: string[];
}

/** Payload of the `result` event of a run that made a board. */
export interface AdaptResultPayload {
    status: "created";
    target: AdaptTarget;
    pageId: string;
    sourceId: string;
    boardId: string;
    name: string;
    width: number;
    height: number;
    variantOf: string;
    /** whether a second Claude turn fixed issues of the first one */
    fixPass: boolean;
    /** issues left after the fix pass */
    issues: AdaptIssue[];
    /** number of issues left, also those cut from `issues` */
    issueCount: number;
}

/** Services of the workflow that tests replace. */
export interface AdaptResponsiveDeps {
    /** Gets a registered workflow by name. */
    findWorkflow(name: string): Promise<Workflow<any> | undefined>;
}

const defaultDeps: AdaptResponsiveDeps = {
    async findWorkflow(name) {
        // lazy: `index.ts` imports this module
        const shipped = (await import("./index")) as Record<string, Workflow<any>>;
        return Object.values(shipped).find((workflow) => workflow?.name === name);
    },
};

/**
 * Plugin-side code of the workflow.
 *
 * The functions run inside the Penpot MCP plugin through `execute_code`, with the Plugin API as
 * the global `penpot`. They do the steps that must not depend on Claude: copying the board,
 * resizing it without letting constraints distort the children, linking the boards with shared
 * plugin data, fitting the height to the content and checking for overflow.
 *
 * Boards are linked with shared plugin data in the `penforge` namespace: `variantOf` (id of the
 * first board of the group, so every variant points at the same id), `variantTarget`
 * (`mobile`/`desktop`) and `variantSource` (board the variant was made from). The first board of
 * a group gets only `variantTarget`. W08 groups boards by `variantOf || id`.
 */
export class AdaptPluginCode {
    /** shared plugin data namespace */
    public static readonly NAMESPACE = "penforge";

    /** names of the functions a caller can run */
    public static readonly FUNCTIONS = ["pfPrepare", "pfCheck", "pfFitHeight"] as const;

    private static readonly LIBRARY = String.raw`
const PF_NS = ${JSON.stringify("penforge")};

function pfRound(value) {
    return Math.round(Number(value) * 100) / 100;
}

function pfChildren(shape) {
    return shape && Array.isArray(shape.children) ? shape.children : [];
}

function pfBox(shape) {
    return {
        id: shape.id,
        name: shape.name,
        x: pfRound(shape.x),
        y: pfRound(shape.y),
        width: pfRound(shape.width),
        height: pfRound(shape.height),
    };
}

function pfBounds(shape) {
    const b = shape.bounds;
    return b && Number.isFinite(b.x) ? b : { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
}

async function pfLocate(id) {
    const file = penpot.currentFile;
    if (!file) {
        throw new Error("No Penpot file is open");
    }
    const current = penpot.currentPage;
    const pages = current ? [current, ...file.pages.filter((p) => p.id !== current.id)] : file.pages;
    for (const page of pages) {
        const shape = page.getShapeById(id);
        if (shape) {
            if (!current || current.id !== page.id) {
                await penpot.openPage(page);
            }
            const active = penpot.currentPage || page;
            return { shape: active.getShapeById(id) || shape, page: active };
        }
    }
    throw new Error("Board not found in the open file: " + id);
}

// A child of a flex/grid board is placed by the layout, not by its constraints.
function pfPlacedByLayout(shape) {
    const parent = shape.parent;
    const absolute = Boolean(shape.layoutChild && shape.layoutChild.absolute);
    return Boolean(parent && (parent.flex || parent.grid) && !absolute);
}

// Constraints of every descendant not placed by a layout are set to left/top while the board is
// resized (children of groups follow the board's constraints too), so that a resize keeps the
// layers as they are; the caller restores them afterwards.
function pfPin(board) {
    const saved = [];
    const visit = (shape) => {
        for (const child of pfChildren(shape)) {
            if (!pfPlacedByLayout(child)) {
                const h = child.constraintsHorizontal;
                const v = child.constraintsVertical;
                saved.push({ child, h, v });
                try {
                    if (h && h !== "left") child.constraintsHorizontal = "left";
                } catch (e) {}
                try {
                    if (v && v !== "top") child.constraintsVertical = "top";
                } catch (e) {}
            }
            visit(child);
        }
    };
    visit(board);
    return saved;
}

// Runs fn as one undo step.
async function pfUndoBlock(fn) {
    const history = penpot.history;
    const block = history ? history.undoBlockBegin() : null;
    try {
        return await fn();
    } finally {
        if (block) history.undoBlockFinish(block);
    }
}

function pfIsMain(shape) {
    return typeof shape.isComponentMainInstance === "function" && shape.isComponentMainInstance();
}

// Child index paths of the main components inside shape (not inside other mains).
function pfMainPaths(shape, path, out) {
    pfChildren(shape).forEach((child, index) => {
        const childPath = path.concat([index]);
        if (pfIsMain(child)) {
            out.push(childPath);
        } else {
            pfMainPaths(child, childPath, out);
        }
    });
    return out;
}

function pfAtPath(shape, path) {
    return path.reduce((node, index) => (node ? pfChildren(node)[index] : null), shape);
}

// Cloning a board duplicates the main components in it, which would add new components to the
// library. Each duplicate is replaced with an instance of the original main.
function pfReplaceMains(source, copy, paths) {
    const pairs = paths.map((path) => ({ main: pfAtPath(source, path), duplicate: pfAtPath(copy, path) }));
    for (const { main, duplicate } of pairs) {
        if (!main || !duplicate) {
            throw new Error("Could not match the components of the copy with the original");
        }
        const component = typeof main.component === "function" ? main.component() : null;
        if (!component) {
            throw new Error("Could not read the component of " + main.name);
        }
        const instance = component.instance();
        const parent = duplicate.parent;
        parent.insertChild(duplicate.parentIndex, instance);
        if (!pfPlacedByLayout(instance)) {
            instance.x = duplicate.x;
            instance.y = duplicate.y;
        }
        try {
            instance.constraintsHorizontal = duplicate.constraintsHorizontal;
            instance.constraintsVertical = duplicate.constraintsVertical;
        } catch (e) {}
        duplicate.remove();
    }
    return pairs.length;
}

function pfRestore(saved) {
    for (const { child, h, v } of saved) {
        try {
            if (h && child.constraintsHorizontal !== h) child.constraintsHorizontal = h;
        } catch (e) {}
        try {
            if (v && child.constraintsVertical !== v) child.constraintsVertical = v;
        } catch (e) {}
    }
}

function pfResize(board, width, height) {
    const pinned = pfPin(board);
    try {
        board.resize(width, height);
    } finally {
        pfRestore(pinned);
    }
}

function pfVariantOf(shape) {
    return shape.getSharedPluginData(PF_NS, "variantOf") || shape.id;
}

function pfBaseName(name) {
    return String(name).replace(/\s*\/\s*(mobile|desktop)\s*$/i, "") || String(name);
}

function pfOverlaps(a, b, gap) {
    return (
        a.x < b.x + b.width + gap &&
        b.x < a.x + a.width + gap &&
        a.y < b.y + b.height + gap &&
        b.y < a.y + a.height + gap
    );
}

// First x right of rect.x where rect does not overlap another top-level shape.
function pfFreeX(page, rect, ignoreId, gap) {
    const others = pfChildren(page.root).filter((s) => s.id !== ignoreId);
    let x = rect.x;
    for (let i = 0; i < 500; i++) {
        const box = { x, y: rect.y, width: rect.width, height: rect.height };
        const hit = others.find((s) => pfOverlaps(box, pfBounds(s), gap));
        if (!hit) {
            return x;
        }
        const b = pfBounds(hit);
        x = b.x + b.width + gap;
    }
    return x;
}

function pfContentBottom(board) {
    let bottom = 0;
    for (const child of pfChildren(board)) {
        if (child.hidden) continue;
        const b = pfBounds(child);
        bottom = Math.max(bottom, b.y + b.height - board.y);
    }
    return pfRound(bottom);
}

async function pfPrepare(p) {
    const { shape: source, page } = await pfLocate(p.boardId);
    if (source.type !== "board") {
        throw new Error("The selected layer is not a board: " + source.name);
    }
    if (!page.root || !source.parent || source.parent.id !== page.root.id) {
        throw new Error("Only top-level boards can be adapted: " + source.name);
    }
    if (pfIsMain(source)) {
        throw new Error("The board is a main component; adapt a copy of it instead: " + source.name);
    }
    const variantOf = pfVariantOf(source);
    const existing = pfChildren(page.root)
        .filter(
            (s) =>
                s.type === "board" &&
                s.id !== source.id &&
                pfVariantOf(s) === variantOf &&
                s.getSharedPluginData(PF_NS, "variantTarget") === p.target
        )
        .map((s) => ({ id: s.id, name: s.name }));
    if (existing.length > 0 && !p.allowExisting) {
        return { status: "exists", pageId: page.id, variantOf, source: pfBox(source), existing };
    }
    if (p.dryRun) {
        return { status: "ready", pageId: page.id, variantOf, source: pfBox(source), existing };
    }

    const mainPaths = pfMainPaths(source, [], []);
    return pfUndoBlock(() => {
        const copy = source.clone();
        const replacedMains = pfReplaceMains(source, copy, mainPaths);
        copy.name = pfBaseName(source.name) + " / " + p.label;
        try {
            if (copy.horizontalSizing === "auto") copy.horizontalSizing = "fix";
        } catch (e) {}
        pfResize(copy, p.width, Math.max(source.height, p.height));
        copy.y = source.y;
        copy.x = pfFreeX(
            page,
            { x: source.x + source.width + p.gap, y: source.y, width: copy.width, height: copy.height },
            copy.id,
            p.gap
        );
        copy.setSharedPluginData(PF_NS, "variantOf", variantOf);
        copy.setSharedPluginData(PF_NS, "variantTarget", p.target);
        copy.setSharedPluginData(PF_NS, "variantSource", source.id);
        if (!source.getSharedPluginData(PF_NS, "variantTarget")) {
            source.setSharedPluginData(PF_NS, "variantTarget", p.sourceTarget);
        }
        return {
            status: "created",
            pageId: page.id,
            variantOf,
            source: pfBox(source),
            board: pfBox(copy),
            existing,
            replacedMains,
        };
    });
}

async function pfCheck(p) {
    const { shape: board } = await pfLocate(p.boardId);
    const left = board.x;
    const right = board.x + board.width;
    const issues = [];
    let issueCount = 0;
    const add = (issue) => {
        issueCount++;
        if (issues.length < p.maxIssues) issues.push(issue);
    };
    const walk = (shape) => {
        for (const child of pfChildren(shape)) {
            if (child.hidden) continue;
            const b = pfBounds(child);
            const overBy = Math.max(left - b.x, b.x + b.width - right);
            if (overBy > p.tolerance) {
                // the children of an overflowing layer are not listed: fixing the layer fixes them
                add({
                    kind: "overflow-x",
                    id: child.id,
                    name: child.name,
                    type: child.type,
                    x: pfRound(b.x - left),
                    width: pfRound(b.width),
                    overBy: pfRound(overBy),
                });
                continue;
            }
            if (child.type === "text") {
                const size = Number(child.fontSize);
                if (Number.isFinite(size) && size < p.minFontSize) {
                    add({ kind: "small-text", id: child.id, name: child.name, type: "text", fontSize: size });
                }
            }
            // what a clipping board hides cannot overflow the screen
            if (child.type === "board" && child.clipContent) continue;
            walk(child);
        }
    };
    walk(board);
    return { board: pfBox(board), issues, issueCount, contentBottom: pfContentBottom(board) };
}

async function pfFitHeight(p) {
    const { shape: board } = await pfLocate(p.boardId);
    if (board.verticalSizing === "auto") {
        return { changed: false, height: pfRound(board.height) };
    }
    const bottom = pfContentBottom(board);
    if (bottom <= 0) {
        return { changed: false, height: pfRound(board.height) };
    }
    const layout = board.flex || board.grid;
    const padding = layout ? Number(layout.bottomPadding) || 0 : 0;
    const height = Math.max(p.minHeight, Math.ceil(bottom + padding));
    if (Math.abs(height - board.height) <= p.tolerance) {
        return { changed: false, height: pfRound(board.height) };
    }
    await pfUndoBlock(() => pfResize(board, board.width, height));
    return { changed: true, height: pfRound(board.height) };
}
`;

    /**
     * Builds the `execute_code` source that runs one plugin function.
     *
     * Parameters are embedded as a JSON literal, so no input is interpolated as code.
     *
     * @param fn - the function to run
     * @param params - its parameter object (JSON-serializable)
     */
    public static build(fn: (typeof AdaptPluginCode.FUNCTIONS)[number], params: object): string {
        if (!AdaptPluginCode.FUNCTIONS.includes(fn)) {
            throw new Error(`Unknown plugin function ${fn}`);
        }
        return `${AdaptPluginCode.LIBRARY}\nreturn await ${fn}(${JSON.stringify(params)});\n`;
    }
}

/** Image attachment for a Claude turn, labelled for the prompt. */
interface LabelledImage {
    label: string;
    attachment: Attachment;
}

/**
 * Adapts a desktop board to mobile or back (W14).
 *
 * Steps: ask first when the board already has a variant for the target, save a checkpoint (W19,
 * when registered), copy the board next to it and resize it to the target width (plugin code, one
 * undo step; main components in it become instances of the originals), link both
 * boards with shared plugin data, let Claude reflow the copy (flex/grid, type scale, spacing,
 * navigation) from the tree and screenshots, fit the height to the content, check for children
 * outside the board and too-small text, and let Claude fix what the check found once.
 */
export class AdaptResponsive {
    /** presets per target (Desktop 1440×1024, Mobile/iPhone 390×844) */
    public static readonly PRESETS: Record<AdaptTarget, AdaptPreset> = {
        mobile: { width: 390, height: 844, label: "Mobile" },
        desktop: { width: 1440, height: 1024, label: "Desktop" },
    };

    /** space between the source board and the new one */
    public static readonly GAP = 100;

    /** smallest readable font size (px) */
    public static readonly MIN_FONT_SIZE = 12;

    /** pixels a child may stick out before it counts as overflow */
    public static readonly TOLERANCE = 1;

    /** issues sent to Claude at most */
    public static readonly MAX_ISSUES = 30;

    /** characters of the node tree sent to Claude at most */
    public static readonly MAX_TREE_CHARS = 24000;

    /** longest side of a screenshot sent to Claude, in pixels */
    public static readonly MAX_IMAGE_SIDE = 1600;

    /** name of the W19 workflow that saves a checkpoint, used when it is registered */
    public static readonly CHECKPOINT_WORKFLOW = "checkpoint-create";

    /** English fallback text of each progress step */
    public static readonly PROGRESS_TEXT: Record<AdaptProgressCode, string> = {
        copy: "Copying the board",
        read: "Looking at the design",
        reflow: "Reflowing the layout",
        check: "Checking the result",
        fix: "Fixing what sticks out",
    };

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly params: Required<AdaptResponsiveParams>,
        private readonly deps: AdaptResponsiveDeps = defaultDeps
    ) {}

    /**
     * Validates the params of a run.
     *
     * @param params - raw params from `workflow.run`
     * @throws Error if a param is missing or invalid
     */
    public static parseParams(params: unknown): Required<AdaptResponsiveParams> {
        const p = (params ?? {}) as Partial<AdaptResponsiveParams>;
        if (typeof p.boardId !== "string" || p.boardId.trim().length === 0) {
            throw new Error("adapt-responsive needs a boardId");
        }
        if (p.target !== "mobile" && p.target !== "desktop") {
            throw new Error('adapt-responsive needs a target, "mobile" or "desktop"');
        }
        const width = p.width ?? AdaptResponsive.PRESETS[p.target].width;
        if (typeof width !== "number" || !Number.isInteger(width) || width < 200 || width > 4000) {
            throw new Error("adapt-responsive width must be an integer between 200 and 4000");
        }
        return { boardId: p.boardId.trim(), target: p.target, width };
    }

    /**
     * Runs the workflow.
     */
    public async run(): Promise<WorkflowResult> {
        const { target, width } = this.params;
        const preset = AdaptResponsive.PRESETS[target];

        this.progress("copy");
        const ready = await this.prepare({ dryRun: true, allowExisting: false });
        if (ready.status === "exists") {
            const existing = ready.existing.map((b) => b.name);
            const quoted = existing.map((name) => `"${name}"`).join(", ");
            const exists: AdaptExistsPayload = { code: "exists", target, sourceName: ready.source.name, existing };
            this.ctx.emit("plan", exists);
            const answer = await this.ctx.ask({
                text: `"${ready.source.name}" already has a ${target} version (${quoted}). Make another one?`,
                options: [
                    { id: "create", label: "Make another" },
                    { id: "cancel", label: "Cancel" },
                ],
            });
            if (answer !== "create") {
                const kept: AdaptKeptPayload = { status: "kept", target, existing };
                this.ctx.emit("result", kept);
                return { summary: `Kept ${quoted}` };
            }
        }

        await this.checkpoint(`Before adapting "${ready.source.name}" to ${target}`);
        const prepared = await this.prepare({ dryRun: false, allowExisting: true });
        const source = prepared.source;
        const board = prepared.board;
        if (prepared.status !== "created" || !board) {
            throw new Error("The board could not be copied");
        }

        this.progress("read");
        const tree = await this.readTree(board.id);
        const images = [
            await this.screenshot(source, `the original board "${source.name}"`),
            await this.screenshot(board, `the copy "${board.name}" right after resizing, before your changes`),
        ].filter((image): image is LabelledImage => image !== null);

        this.progress("reflow");
        const first = await this.ctx.runner.run({
            prompt: AdaptResponsive.adaptPrompt(target, width, source, board, tree, images),
            attachments: images.map((image) => image.attachment),
        });
        this.checkCancelled();

        this.progress("check");
        await this.fitHeight(board.id, preset.height);
        let check = await this.check(board.id);
        let fixPass = false;
        if (check.issueCount > 0) {
            fixPass = true;
            this.progress("fix");
            const after = await this.screenshot(check.board, `the adapted board "${board.name}" now`);
            await this.ctx.runner.run({
                prompt: AdaptResponsive.fixPrompt(target, check),
                attachments: after ? [after.attachment] : undefined,
                resumeSessionId: first.sessionId,
            });
            this.checkCancelled();
            await this.fitHeight(board.id, preset.height);
            check = await this.check(board.id);
        }

        const payload: AdaptResultPayload = {
            status: "created",
            target,
            pageId: prepared.pageId,
            sourceId: source.id,
            boardId: board.id,
            name: check.board.name,
            width: check.board.width,
            height: check.board.height,
            variantOf: prepared.variantOf,
            fixPass,
            issues: check.issues,
            issueCount: check.issueCount,
        };
        this.ctx.emit("result", payload);
        return { summary: AdaptResponsive.summary(payload) };
    }

    /**
     * Builds the prompt of the first Claude turn.
     */
    public static adaptPrompt(
        target: AdaptTarget,
        width: number,
        source: BoardBox,
        board: BoardBox,
        tree: string,
        images: LabelledImage[]
    ): string {
        const from = target === "mobile" ? "desktop" : "mobile";
        const lines = [
            `Adapt a ${from} screen to ${target}.`,
            "",
            `The original board "${source.name}" (id ${source.id}, ${source.width}×${source.height}) stays as it is: ` +
                "do not change it.",
            `I copied it into the new board "${board.name}" (id ${board.id}) and resized that to ` +
                `${width}×${board.height}. Constraints were not applied, so the children kept their size and ` +
                "position and now stick out or leave gaps. Change only this new board and its children: " +
                `rebuild its layout for a ${width}px wide ${target} screen.`,
            "Its height will be fitted to the content afterwards, so let the content grow downwards.",
            "",
            `Node tree of the new board (get_node_properties, depth 3; read deeper levels with get_node_properties):`,
            "```json",
            tree,
            "```",
        ];
        if (images.length > 0) {
            lines.push("", "Images below:");
            images.forEach((image, index) => lines.push(`${index + 1}. ${image.label}`));
        }
        lines.push("", "When done, reply with one short sentence on what you changed.");
        return lines.join("\n");
    }

    /**
     * Builds the prompt of the fix turn.
     */
    public static fixPrompt(target: AdaptTarget, check: CheckResult): string {
        const board = check.board;
        const lines = [
            `I checked the ${target} board "${board.name}" (id ${board.id}, ${board.width}×${board.height}). ` +
                `Fix these ${check.issueCount} problems, changing only that board:`,
        ];
        for (const issue of check.issues) {
            if (issue.kind === "overflow-x") {
                lines.push(
                    `- "${issue.name}" (${issue.type}, id ${issue.id}) sticks out of the board by ${issue.overBy}px ` +
                        `(x ${issue.x}, width ${issue.width}; the board is ${board.width} wide)`
                );
            } else {
                lines.push(
                    `- text "${issue.name}" (id ${issue.id}) has font size ${issue.fontSize}px; use at least ` +
                        `${AdaptResponsive.MIN_FONT_SIZE}px`
                );
            }
        }
        if (check.issueCount > check.issues.length) {
            lines.push(`- … and ${check.issueCount - check.issues.length} more of the same kind`);
        }
        lines.push(
            "",
            "Children must stay inside the board's width: make them fill the width, wrap or stack instead of " +
                "cutting them off. The image below shows the board now.",
            "When done, reply with one short sentence."
        );
        return lines.join("\n");
    }

    /**
     * Builds the run summary shown in the chat.
     */
    public static summary(payload: AdaptResultPayload): string {
        const made = `Made "${payload.name}" (${payload.width}×${payload.height})`;
        if (payload.issueCount === 0) {
            return `${made}.`;
        }
        return `${made}. Layers to check: ${payload.issueCount}.`;
    }

    private async prepare(options: { dryRun: boolean; allowExisting: boolean }): Promise<PrepareResult> {
        const { boardId, target, width } = this.params;
        const preset = AdaptResponsive.PRESETS[target];
        return this.plugin<PrepareResult>("pfPrepare", {
            boardId,
            target,
            sourceTarget: target === "mobile" ? "desktop" : "mobile",
            label: preset.label,
            width,
            height: preset.height,
            gap: AdaptResponsive.GAP,
            ...options,
        });
    }

    private check(boardId: string): Promise<CheckResult> {
        return this.plugin<CheckResult>("pfCheck", {
            boardId,
            minFontSize: AdaptResponsive.MIN_FONT_SIZE,
            tolerance: AdaptResponsive.TOLERANCE,
            maxIssues: AdaptResponsive.MAX_ISSUES,
        });
    }

    private fitHeight(boardId: string, minHeight: number): Promise<FitHeightResult> {
        return this.plugin<FitHeightResult>("pfFitHeight", {
            boardId,
            minHeight,
            tolerance: AdaptResponsive.TOLERANCE,
        });
    }

    private async readTree(boardId: string): Promise<string> {
        const result = await this.ctx.tools.call("get_node_properties", { nodeId: boardId, depth: 3 });
        if (result.isError) {
            throw new Error(`Could not read the board: ${result.text}`);
        }
        const text = result.text;
        if (text.length <= AdaptResponsive.MAX_TREE_CHARS) {
            return text;
        }
        return `${text.slice(0, AdaptResponsive.MAX_TREE_CHARS)}\n… (cut; read the rest with get_node_properties)`;
    }

    private async screenshot(box: BoardBox, label: string): Promise<LabelledImage | null> {
        const side = Math.max(box.width, box.height, 1);
        const scale = Math.min(1, Math.max(0.25, AdaptResponsive.MAX_IMAGE_SIDE / side));
        const result = await this.ctx.tools.call("capture_node_screenshot", {
            nodeId: box.id,
            scale: Math.round(scale * 100) / 100,
            format: "jpeg",
        });
        const image = result.isError
            ? undefined
            : (result.content as any[]).find((part) => part?.type === "image" && typeof part.data === "string");
        if (!image) {
            // a turn without the image still works from the node tree
            this.ctx.emit("log", { text: `No screenshot of ${box.name}: ${result.text}` });
            return null;
        }
        return { label, attachment: { kind: "image", mime: image.mimeType ?? "image/jpeg", base64: image.data } };
    }

    private async plugin<T>(fn: (typeof AdaptPluginCode.FUNCTIONS)[number], params: object): Promise<T> {
        this.checkCancelled();
        const result = await this.ctx.tools.call("execute_code", { code: AdaptPluginCode.build(fn, params) });
        if (result.isError) {
            throw new Error(result.text || `${fn} failed`);
        }
        let data: { result?: T };
        try {
            data = JSON.parse(result.text);
        } catch {
            throw new Error(`Unexpected reply from the Penpot plugin: ${result.text.slice(0, 200)}`);
        }
        if (data?.result === undefined || data.result === null) {
            throw new Error(`The Penpot plugin returned nothing for ${fn}`);
        }
        return data.result;
    }

    private progress(code: AdaptProgressCode): void {
        this.ctx.emit("progress", { code, text: AdaptResponsive.PROGRESS_TEXT[code] });
    }

    /**
     * Saves a checkpoint through the W19 workflow when it is registered. A failed checkpoint is
     * logged and does not stop the run.
     */
    private async checkpoint(label: string): Promise<boolean> {
        const create = await this.deps.findWorkflow(AdaptResponsive.CHECKPOINT_WORKFLOW);
        if (!create) {
            return false;
        }
        // the checkpoint's own `result` event would read as this run's result
        const ctx: WorkflowContext = {
            ...this.ctx,
            emit: (kind: WorkflowEventKind, payload: unknown) => {
                if (kind !== "result") {
                    this.ctx.emit(kind, payload);
                }
            },
        };
        let saved = false;
        try {
            await create.run(ctx, { label, workflow: "adapt-responsive" });
            saved = true;
        } catch (error) {
            this.ctx.emit("log", {
                text: `Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
        this.checkCancelled();
        return saved;
    }

    private checkCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }
}

export const workflow: Workflow<AdaptResponsiveParams> = {
    name: "adapt-responsive",
    description: "Copies a board as a mobile (or desktop) version next to it and reflows its layout.",
    run: (ctx, params) => new AdaptResponsive(ctx, AdaptResponsive.parseParams(params)).run(),
};

/**
 * Creates the workflow with other services (tests).
 *
 * @param deps - the services
 */
export function createAdaptResponsiveWorkflow(deps: AdaptResponsiveDeps): Workflow<AdaptResponsiveParams> {
    return {
        ...workflow,
        run: (ctx, params) => new AdaptResponsive(ctx, AdaptResponsive.parseParams(params), deps).run(),
    };
}
