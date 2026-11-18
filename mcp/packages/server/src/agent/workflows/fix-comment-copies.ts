import type { WorkflowContext, WorkflowQuestion } from "@penpot/mcp-common";
import { DesignDecisions } from "../chat/DesignDecisions";
import { type DesignNode, DesignTree } from "../chat/DesignTree";

/** Style change Claude made to one layer with `update_design_node`. */
export interface StyleChange {
    nodeId: string;
    /** the style keys of the mutations (`fills`, `strokes`, `radius`, `opacity`, `shadows`) */
    style: Record<string, unknown>;
}

/**
 * Change that could follow a comment fix to other screens:
 * - `copies`: layers that are copies of the fixed one (same name, type, place in the board and
 *   size, still the old look) on other boards, without a component linking them;
 * - `component`: the fixed layer is part of a component instance; the change can go to the
 *   component's main layer, so every instance follows.
 */
export interface CopyOffer {
    kind: "copies" | "component";
    /** comment the fix belongs to */
    seqNumber: number;
    layerName: string;
    /** component name (`component` only) */
    componentName?: string;
    /** layers to change: the copies, or the main layer of the component */
    targets: string[];
    /** screens (top-level boards) that change */
    boards: string[];
    /** the new style */
    style: Record<string, unknown>;
    /** the style before the fix */
    oldStyle: Record<string, unknown>;
}

/** What happened to the copies of a fixed layer (in the `fix-comment` / `fix-comments` reports). */
export interface CopiesReport {
    /** `main`: the fixed layer is in a main component, so its instances follow by themselves */
    kind: "copies" | "component" | "main";
    /** layers found that could follow */
    found: number;
    /** layers changed (after the user said so) */
    applied: number;
    /** layers left out at the end: changed meanwhile, or wanted differently by two fixes */
    skipped?: number;
    /** screens of those layers (`main`: screens with instances of the component) */
    boards: string[];
    /** the decision was written to DESIGN.md */
    recorded: boolean;
}

/** The fixed layer belongs to a main component: its instances follow it by themselves. */
export interface MainComponentNote {
    kind: "main";
    /** screens with instances of the component (other than the fixed layer's) */
    boards: string[];
}

/** Layer as the survey script reports it. */
interface SurveyLayer {
    nodeId: string;
    name: string;
    type: string;
    hidden: boolean;
    blocked: boolean;
    width: number;
    height: number;
    boardId: string;
    boardName: string;
    boardIsBoard: boolean;
    /** names of the ancestors between the top-level board and the layer */
    path: string[];
}

/** What the survey script found around the fixed layer. */
interface Survey {
    target: SurveyLayer;
    /** the layer is inside a main component */
    inMain: boolean;
    /** screens with instances of that main component */
    instanceBoards: string[];
    /** the layer is inside a component copy */
    component: { name: string; mainLayerId: string; boards: string[] } | null;
    candidates: SurveyLayer[];
}

/**
 * Carrier of a comment fix to the other screens that show the same layer.
 *
 * Screens are often copies of each other (an Android version of an iPhone screen). A comment fix
 * changes only the commented layer. After a style fix, this class finds what else should follow:
 * nothing when the layer belongs to a main component (its instances follow by themselves); the
 * component's main layer when the layer is in an instance; otherwise strict copies on other
 * boards (same name, type, ancestor names and similar size, visible and unlocked, still exactly
 * the old look). The user is asked once, naming how many layers and which screens change, and the
 * daemon applies the same mutations itself in one undo step (Claude is not involved: the comment
 * text never reaches these changes). The decision is noted in DESIGN.md when the project has one.
 * Asking never fails a fix: a cancel or a timeout leaves the fix as it is.
 */
export class CommentFixCopies {
    private static readonly PROPERTIES_TOOL = "get_node_properties";
    private static readonly EXECUTE_TOOL = "execute_code";
    /** Most candidates whose look is read, and most copies changed for one fix. */
    private static readonly MAX_CANDIDATES = 30;
    private static readonly MAX_COPIES = 20;
    /** Largest relative size difference of a copy (an Android card is a bit wider). */
    private static readonly MAX_SIZE_DIFFERENCE = 0.35;
    /** How long the question waits for an answer. */
    private static readonly ASK_TIMEOUT_MS = 10 * 60 * 1000;
    private static readonly APPLY = "apply";
    private static readonly SKIP = "skip";

    /**
     * @param ctx - context of the workflow run
     * @param askTimeoutMs - how long a question waits for an answer
     */
    constructor(
        private readonly ctx: WorkflowContext,
        private readonly askTimeoutMs: number = CommentFixCopies.ASK_TIMEOUT_MS
    ) {}

    /**
     * Reads a layer before the fix (the look its copies are recognised by).
     *
     * @param nodeId - the layer
     * @returns its snapshot, or null when it cannot be read
     */
    public async snapshot(nodeId: string): Promise<DesignNode | null> {
        const result = await this.ctx.tools.call(CommentFixCopies.PROPERTIES_TOOL, { nodeId, depth: 1 });
        return result.isError ? null : DesignTree.parse(result.text);
    }

    /**
     * Gets the style part of an `update_design_node` input.
     *
     * @param input - the tool input
     * @returns the change, or null when it changes no style key
     */
    public static styleChange(input: unknown): StyleChange | null {
        if (!input || typeof input !== "object") {
            return null;
        }
        const { nodeId, mutations } = input as { nodeId?: unknown; mutations?: unknown };
        if (typeof nodeId !== "string" || !mutations || typeof mutations !== "object") {
            return null;
        }
        const style: Record<string, unknown> = {};
        for (const key of DesignTree.STYLE_KEYS) {
            if (key in mutations) {
                style[key] = (mutations as Record<string, unknown>)[key];
            }
        }
        return Object.keys(style).length > 0 ? { nodeId, style } : null;
    }

    /**
     * Finds what could follow a fix, without asking or changing anything.
     *
     * @param before - the fixed layer before the fix
     * @param changes - the style changes Claude made during the fix
     * @param seqNumber - number of the comment
     * @returns an offer, a note when the layer is in a main component, or null
     */
    public async prepare(
        before: DesignNode,
        changes: StyleChange[],
        seqNumber: number
    ): Promise<CopyOffer | MainComponentNote | null> {
        const style = Object.assign(
            {},
            ...changes.filter((change) => change.nodeId === before.id).map((change) => change.style)
        ) as Record<string, unknown>;
        if (Object.keys(style).length === 0) {
            return null;
        }
        const oldStyle = Object.fromEntries(Object.keys(style).map((key) => [key, before.style[key]]));
        const survey = await this.survey(before.id);
        if (!survey) {
            return null;
        }
        if (survey.inMain) {
            return { kind: "main", boards: survey.instanceBoards ?? [] };
        }
        const base = { seqNumber, layerName: before.name, style, oldStyle };
        if (survey.component) {
            return survey.component.boards.length === 0
                ? null
                : {
                      ...base,
                      kind: "component",
                      componentName: survey.component.name,
                      targets: [survey.component.mainLayerId],
                      boards: survey.component.boards,
                  };
        }
        const copies = await this.copies(survey, oldStyle);
        return copies.length === 0
            ? null
            : {
                  ...base,
                  kind: "copies",
                  targets: copies.map((copy) => copy.nodeId),
                  boards: [...new Set(copies.map((copy) => copy.boardName))],
              };
    }

    /**
     * Asks once about the offers and applies the accepted ones in one undo step. Never throws: a
     * cancel, a timeout or a failure leaves the fixes as they are.
     *
     * @param offers - the offers of one or several fixed comments
     * @returns one report per offer
     */
    public async settle(offers: CopyOffer[]): Promise<CopiesReport[]> {
        const declined = offers.map((offer) => CommentFixCopies.report(offer, 0, false));
        if (offers.length === 0) {
            return [];
        }
        let answer: string;
        try {
            answer = await this.ask(CommentFixCopies.question(offers));
        } catch {
            return declined;
        }
        if (answer !== CommentFixCopies.APPLY) {
            return declined;
        }
        // offers of a batch wait for the end: later fixes may have changed their targets since
        const plan = await this.recheck(offers);
        const applied = await this.apply(offers, plan).catch(() => new Map<string, boolean>());
        const planned = new Set(plan.flat());
        const reports: CopiesReport[] = [];
        for (const offer of offers) {
            // a target two offers wanted alike was applied once, for both
            const count = offer.targets.filter((target) => applied.get(target) === true).length;
            const skipped = offer.targets.filter((target) => !planned.has(target)).length;
            const recorded =
                count > 0 &&
                (await new DesignDecisions(this.ctx.workspace).record(
                    offer.layerName,
                    DesignTree.describeChange(offer.oldStyle, offer.style),
                    offer.seqNumber
                ));
            reports.push({
                ...CommentFixCopies.report(offer, count, recorded),
                ...(skipped > 0 ? { skipped } : {}),
            });
        }
        return reports;
    }

    /**
     * Targets of each offer that may still change: a target wanted by two offers with different
     * styles is left out of both (the same style is applied once, by the first), and a target
     * whose current look no longer equals the offer's old look (a later fix changed it) is left
     * out.
     *
     * @returns the targets to apply, per offer
     */
    private async recheck(offers: CopyOffer[]): Promise<string[][]> {
        const owner = new Map<string, number>();
        const conflicting = new Set<string>();
        offers.forEach((offer, index) => {
            for (const target of offer.targets) {
                const first = owner.get(target);
                if (first === undefined) {
                    owner.set(target, index);
                } else if (!DesignTree.same(offers[first].style, offer.style)) {
                    conflicting.add(target);
                }
            }
        });
        const plan: string[][] = [];
        for (const [index, offer] of offers.entries()) {
            const targets: string[] = [];
            for (const target of offer.targets) {
                if (conflicting.has(target) || owner.get(target) !== index) {
                    continue;
                }
                const result = await this.ctx.tools.call(CommentFixCopies.PROPERTIES_TOOL, {
                    nodeId: target,
                    depth: 1,
                });
                const node = result.isError ? null : DesignTree.parse(result.text);
                if (
                    node &&
                    Object.keys(offer.oldStyle).every((key) => DesignTree.same(node.style[key], offer.oldStyle[key]))
                ) {
                    targets.push(target);
                }
            }
            plan.push(targets);
        }
        return plan;
    }

    /**
     * The question about one or several offers: which layers, how many and on which screens.
     */
    public static question(offers: CopyOffer[]): WorkflowQuestion {
        const lines = offers.map((offer) => {
            const boards = offer.boards.map((name) => `"${name}"`).join(", ");
            if (offer.kind === "component") {
                return (
                    `"${offer.layerName}" is part of the component "${offer.componentName}", also used on ${boards}: ` +
                    "change the component itself so all of them follow"
                );
            }
            const count = offer.targets.length;
            return `${count} ${count === 1 ? "layer" : "layers"} "${offer.layerName}" on ${boards} still look the old way`;
        });
        const intro = offers.length === 1 ? "" : "Some fixed comments also concern other screens.\n";
        return {
            text: `${intro}${lines.map((line) => (offers.length === 1 ? line : `- ${line}`)).join("\n")}. Change them too?`,
            options: [
                { id: CommentFixCopies.APPLY, label: "Change them too" },
                { id: CommentFixCopies.SKIP, label: "Leave them" },
            ],
        };
    }

    private static report(offer: CopyOffer, applied: number, recorded: boolean): CopiesReport {
        return { kind: offer.kind, found: offer.targets.length, applied, boards: offer.boards, recorded };
    }

    private ask(question: WorkflowQuestion): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no answer")), this.askTimeoutMs);
            this.ctx.ask(question).then(
                (answer) => {
                    clearTimeout(timer);
                    resolve(answer);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }

    /** Strict copies among the survey's candidates: same old look on every changed key. */
    private async copies(survey: Survey, oldStyle: Record<string, unknown>): Promise<SurveyLayer[]> {
        const { target } = survey;
        const similar = (a: number, b: number) =>
            Math.abs(a - b) <= Math.max(a, b) * CommentFixCopies.MAX_SIZE_DIFFERENCE;
        const candidates = survey.candidates
            .filter(
                (candidate) =>
                    candidate.boardIsBoard &&
                    candidate.boardId !== target.boardId &&
                    !candidate.hidden &&
                    !candidate.blocked &&
                    candidate.type === target.type &&
                    candidate.path.join("/") === target.path.join("/") &&
                    similar(candidate.width, target.width) &&
                    similar(candidate.height, target.height)
            )
            .slice(0, CommentFixCopies.MAX_CANDIDATES);
        const copies: SurveyLayer[] = [];
        for (const candidate of candidates) {
            const result = await this.ctx.tools.call(CommentFixCopies.PROPERTIES_TOOL, {
                nodeId: candidate.nodeId,
                depth: 1,
            });
            const node = result.isError ? null : DesignTree.parse(result.text);
            if (node && Object.keys(oldStyle).every((key) => DesignTree.same(node.style[key], oldStyle[key]))) {
                copies.push(candidate);
                if (copies.length >= CommentFixCopies.MAX_COPIES) {
                    break;
                }
            }
        }
        return copies;
    }

    /** Reads the fixed layer's component context and the same-named layers of the page. */
    private async survey(nodeId: string): Promise<Survey | null> {
        const params = JSON.stringify({ id: nodeId });
        const code = `
const params = ${params};
const call = (shape, name) => (typeof shape[name] === "function" ? shape[name]() : null);
const boardOf = (shape) => {
    let current = shape;
    while (current.parent && current.parent.parent) {
        current = current.parent;
    }
    return current;
};
const layer = (shape) => {
    const board = boardOf(shape);
    const path = [];
    for (let current = shape.parent; current && current.id !== board.id; current = current.parent) {
        path.unshift(current.name);
    }
    return {
        nodeId: shape.id, name: shape.name, type: shape.type, hidden: Boolean(shape.hidden),
        blocked: Boolean(shape.blocked), width: shape.width, height: shape.height,
        boardId: board.id, boardName: board.name, boardIsBoard: board.type === "board" && board.id !== shape.id, path,
    };
};
const target = penpotUtils.findShapeById(params.id);
if (!target) {
    return null;
}
const home = boardOf(target);
const inMain = Boolean(call(target, "isComponentMainInstance"));
const instancesOf = (component, skipMain) => {
    const boards = new Set();
    for (const shape of penpotUtils.findShapes((s) => Boolean(call(s, "isComponentRoot")), penpot.root)) {
        const used = call(shape, "component");
        if (used && used.id === component.id && boardOf(shape).id !== home.id
            && !(skipMain && call(shape, "isComponentMainInstance"))) {
            boards.add(boardOf(shape).name);
        }
    }
    return [...boards];
};
const ownRoot = call(target, "componentRoot");
const ownComponent = inMain && ownRoot ? call(ownRoot, "component") : null;
const instanceBoards = ownComponent ? instancesOf(ownComponent, true) : [];
let component = null;
if (!inMain && call(target, "isComponentCopyInstance")) {
    const ref = call(target, "componentRefShape");
    const root = call(target, "componentRoot");
    const main = root ? call(root, "component") : null;
    if (ref && main) {
        component = { name: main.name, mainLayerId: ref.id, boards: instancesOf(main, false) };
    }
}
const candidates = inMain || component
    ? []
    : penpotUtils.findShapes((s) => s.name === target.name && s.id !== target.id, penpot.root).map(layer);
return { target: layer(target), inMain, instanceBoards, component, candidates };
`;
        const result = await this.ctx.tools.call(CommentFixCopies.EXECUTE_TOOL, { code });
        if (result.isError) {
            return null;
        }
        try {
            const value = (JSON.parse(result.text) as { result?: unknown }).result as Survey | null;
            return value && typeof value === "object" && value.target ? value : null;
        } catch {
            return null;
        }
    }

    /**
     * Applies the planned targets of every offer in one undo step, then returns to the page the
     * user was on (changing a component's main may open its page); returns success per target.
     */
    private async apply(offers: CopyOffer[], plan: string[][]): Promise<Map<string, boolean>> {
        const targets = offers.flatMap((offer, index) =>
            plan[index].map((nodeId) => ({ nodeId, mutations: offer.style }))
        );
        if (targets.length === 0) {
            return new Map();
        }
        const code = `
const params = ${JSON.stringify({ targets })};
const history = penpot.history;
const startPage = penpot.currentPage;
const block = history.undoBlockBegin();
const done = {};
try {
    for (const target of params.targets) {
        try {
            await penpotUtils.penforge.updateDesignNode(target);
            done[target.nodeId] = true;
        } catch (error) {
            done[target.nodeId] = false;
        }
    }
} finally {
    history.undoBlockFinish(block);
    if (startPage && penpot.currentPage && penpot.currentPage.id !== startPage.id) {
        await penpot.openPage(startPage);
    }
}
return done;
`;
        const result = await this.ctx.tools.call(CommentFixCopies.EXECUTE_TOOL, { code });
        const done = new Map<string, boolean>();
        if (result.isError) {
            return done;
        }
        try {
            const value = (JSON.parse(result.text) as { result?: Record<string, unknown> }).result ?? {};
            for (const [nodeId, ok] of Object.entries(value)) {
                done.set(nodeId, ok === true);
            }
        } catch {
            // nothing known to be applied
        }
        return done;
    }
}
