import type { WorkflowContext } from "@penpot/mcp-common";
import { DesignDecisions } from "../chat/DesignDecisions";
import { type DesignNode, DesignTree } from "../chat/DesignTree";

/** Style change Claude made to one layer with `update_design_node`. */
export interface StyleChange {
    nodeId: string;
    /** the style keys of the mutations (`fills`, `strokes`, `radius`, `opacity`, `shadows`) */
    style: Record<string, unknown>;
}

/** Copy of the changed layer on another screen, still with the old style. */
export interface StyleCopy {
    nodeId: string;
    boardId: string;
    boardName: string;
}

/** What happened to the copies of a fixed layer. */
export interface CopiesReport {
    /** copies found on other screens */
    found: number;
    /** copies changed too (after the user said so) */
    applied: number;
    /** names of the screens the copies are on */
    boards: string[];
    /** the decision was written to DESIGN.md */
    recorded: boolean;
}

/**
 * Carrier of a comment fix to the copies of the fixed layer on other screens.
 *
 * Screens are often copies of each other (an Android version of an iPhone screen), without a
 * component or library color linking their layers. A comment fix changes only the commented
 * layer, so the other screens keep the old style. After a style fix, the copies (same layer name,
 * other top-level board of the page, still exactly the old style) are looked up; the user is
 * asked once whether to change them too, and then the daemon applies the very same mutations
 * itself with `update_design_node` (Claude is not involved: the comment text never reaches
 * these changes). The decision is noted in DESIGN.md when the project has one.
 */
export class CommentFixCopies {
    private static readonly PROPERTIES_TOOL = "get_node_properties";
    private static readonly CHANGE_TOOL = "update_design_node";
    private static readonly EXECUTE_TOOL = "execute_code";
    /** Most copies looked at (and changed) for one fix. */
    private static readonly MAX_COPIES = 20;
    private static readonly APPLY = "apply";
    private static readonly SKIP = "skip";

    /**
     * @param ctx - context of the workflow run
     */
    constructor(private readonly ctx: WorkflowContext) {}

    /**
     * Reads a layer before the fix (the style its copies are recognised by).
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
     * Offers to carry the style changes of the fixed layer to its copies on other screens.
     *
     * @param before - the fixed layer before the fix
     * @param changes - the style changes Claude made during the fix
     * @param seqNumber - number of the comment, for the DESIGN.md note
     * @returns what happened, or null when there was nothing to offer
     */
    public async offer(before: DesignNode, changes: StyleChange[], seqNumber: number): Promise<CopiesReport | null> {
        const style = Object.assign(
            {},
            ...changes.filter((change) => change.nodeId === before.id).map((change) => change.style)
        ) as Record<string, unknown>;
        if (Object.keys(style).length === 0) {
            return null;
        }
        const copies = await this.findCopies(before, Object.keys(style));
        if (copies.length === 0) {
            return null;
        }
        const boards = [...new Set(copies.map((copy) => copy.boardName))];
        const answer = await this.ctx.ask({
            text:
                `The same "${before.name}" is also on ${boards.map((name) => `"${name}"`).join(", ")}, ` +
                "still with the old look. Change it there too?",
            options: [
                { id: CommentFixCopies.APPLY, label: "Change it everywhere" },
                { id: CommentFixCopies.SKIP, label: "Only this screen" },
            ],
        });
        if (answer !== CommentFixCopies.APPLY) {
            return { found: copies.length, applied: 0, boards, recorded: false };
        }
        let applied = 0;
        for (const copy of copies) {
            const result = await this.ctx.tools.call(CommentFixCopies.CHANGE_TOOL, {
                nodeId: copy.nodeId,
                mutations: style,
            });
            if (!result.isError) {
                applied++;
            }
        }
        const recorded =
            applied > 0 &&
            (await new DesignDecisions(this.ctx.workspace).record(
                `${before.name}: ${DesignTree.describe(style)} on every screen (from comment #${seqNumber}).`
            ));
        return { found: copies.length, applied, boards, recorded };
    }

    /**
     * Finds the copies of a layer: same name, on another top-level board of the page, and still
     * the old value for every changed style key.
     */
    private async findCopies(before: DesignNode, keys: string[]): Promise<StyleCopy[]> {
        const candidates = await this.candidates(before);
        const copies: StyleCopy[] = [];
        for (const candidate of candidates) {
            const result = await this.ctx.tools.call(CommentFixCopies.PROPERTIES_TOOL, {
                nodeId: candidate.nodeId,
                depth: 1,
            });
            const node = result.isError ? null : DesignTree.parse(result.text);
            if (node && keys.every((key) => DesignTree.same(node.style[key], before.style[key]))) {
                copies.push(candidate);
            }
        }
        return copies;
    }

    /** Layers of the page with the same name as the layer, on other top-level boards. */
    private async candidates(before: DesignNode): Promise<StyleCopy[]> {
        const params = JSON.stringify({ id: before.id, name: before.name, max: CommentFixCopies.MAX_COPIES });
        const code = `
const params = ${params};
const boardOf = (shape) => {
    let current = shape;
    while (current.parent && current.parent.parent) {
        current = current.parent;
    }
    return current;
};
const target = penpotUtils.findShapeById(params.id);
if (!target) {
    return [];
}
const home = boardOf(target);
return penpotUtils
    .findShapes((shape) => shape.name === params.name && shape.id !== params.id, penpot.root)
    .map((shape) => ({ shape, board: boardOf(shape) }))
    .filter(({ board }) => board.id !== home.id && board.type === "board")
    .slice(0, params.max)
    .map(({ shape, board }) => ({ nodeId: shape.id, boardId: board.id, boardName: board.name }));
`;
        const result = await this.ctx.tools.call(CommentFixCopies.EXECUTE_TOOL, { code });
        if (result.isError) {
            return [];
        }
        try {
            const value = JSON.parse(result.text) as { result?: unknown };
            return Array.isArray(value.result) ? (value.result as StyleCopy[]) : [];
        } catch {
            return [];
        }
    }
}
