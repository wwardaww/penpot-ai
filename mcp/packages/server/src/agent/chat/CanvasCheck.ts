import type { WorkflowToolsApi } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { type DesignNode, DesignTree } from "./DesignTree";

/** Top-level board as `list_boards` reports it. */
export interface BoardBox {
    id: string;
    name: string;
    pageId: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Problem the check found on the canvas after a chat turn. */
export interface CanvasProblem {
    /** stable code, for clients that word it themselves */
    code: "boards-overlap" | "style-differs";
    /** `error` for a broken result, `info` for something the user may want to look at */
    severity: "error" | "info";
    /** the boards involved */
    boardIds: string[];
    /** parameters for the client's wording (`names` of the overlapping boards; `board`, `source`
     * and `layers` of a style difference) */
    params: Record<string, unknown>;
    /** English text for the user (designer wording) */
    text: string;
}

/**
 * Check of the canvas after a chat turn that changed the design.
 *
 * Claude verifies its work with node screenshots, which render a node on its own: a new board placed
 * under another board (for instance on top of an empty board the file started with) looks right
 * there while the user sees the board on top. The check compares the top-level boards of the
 * tab's page before and after the turn and reports pairs of boards that overlap now but did not
 * before. Failures of the board listing are ignored, and without a listing from before the turn
 * nothing is reported: the check is a safety net, never a reason to fail a turn.
 *
 * New boards are also compared with the board they were most likely made from (the existing board
 * sharing the most layer names): layers of the same name whose fills differ are mentioned, so a
 * decision made on the source (a color changed through a comment) that did not reach the new
 * screen shows up.
 */
export class CanvasCheck {
    private static readonly LIST_TOOL = "list_boards";
    private static readonly PROPERTIES_TOOL = "get_node_properties";
    /** Levels of a board read for the style comparison. */
    private static readonly TREE_DEPTH = 4;
    /** Most new boards compared, and most existing boards read as possible sources. */
    private static readonly MAX_NEW_BOARDS = 3;
    private static readonly MAX_SOURCES = 6;
    /** A source must share at least this many layer names, and this share of the new board's. */
    private static readonly MIN_SHARED = 3;
    private static readonly MIN_SHARED_RATIO = 0.3;
    /** Most layer names listed in one difference. */
    private static readonly MAX_LISTED = 5;
    /** Overlaps thinner than this (in px) are rounding, not boards on top of each other. */
    private static readonly MIN_OVERLAP = 1;
    /** Tools whose use means the turn may have changed the design. */
    private static readonly DESIGN_TOOLS =
        /^mcp__penpot__(execute_code|update_design_node|import_image|import_penpot_file)$/;
    private readonly logger = createLogger("CanvasCheck");

    /**
     * @param tools - Penpot tools of the client's tab; without them the check does nothing
     * @param timeoutMs - time limit of one board listing
     */
    constructor(
        private readonly tools: WorkflowToolsApi | null,
        private readonly timeoutMs: number = 5000
    ) {}

    /**
     * Whether a tool use may have changed the design.
     *
     * @param toolName - the tool name as Claude calls it
     */
    public static changesDesign(toolName: string): boolean {
        return CanvasCheck.DESIGN_TOOLS.test(toolName);
    }

    /**
     * Lists the top-level boards of a page, or null when they cannot be read.
     *
     * @param pageId - the page
     */
    public async boards(pageId: string): Promise<BoardBox[] | null> {
        if (!this.tools) {
            return null;
        }
        try {
            const result = await this.withTimeout(this.tools.call(CanvasCheck.LIST_TOOL, { pageId }));
            if (result.isError) {
                return null;
            }
            return CanvasCheck.parse(result.text);
        } catch (error) {
            this.logger.debug("Board listing failed: %s", String(error));
            return null;
        }
    }

    /**
     * Problems of the canvas after a turn.
     *
     * @param before - the boards before the turn
     * @param after - the boards after the turn
     */
    public static problems(before: BoardBox[], after: BoardBox[]): CanvasProblem[] {
        const known = new Set(CanvasCheck.overlaps(before).map(([a, b]) => CanvasCheck.key(a, b)));
        return CanvasCheck.overlaps(after)
            .filter(([a, b]) => !known.has(CanvasCheck.key(a, b)))
            .map(([a, b]) => ({
                code: "boards-overlap" as const,
                severity: "error" as const,
                boardIds: [a.id, b.id],
                params: { names: [a.name, b.name] },
                text:
                    `The screens "${a.name}" and "${b.name}" overlap on the canvas, so one hides the other. ` +
                    "Move one of them, or ask me to fix it.",
            }));
    }

    /**
     * Compares each board new after the turn with its likely source board.
     *
     * @param before - the boards before the turn
     * @param after - the boards after the turn
     * @returns one `style-differs` problem per new board whose shared layers have other fills
     */
    public async styleDifferences(before: BoardBox[], after: BoardBox[]): Promise<CanvasProblem[]> {
        const known = new Set(before.map((board) => board.id));
        const added = after.filter((board) => !known.has(board.id)).slice(0, CanvasCheck.MAX_NEW_BOARDS);
        if (added.length === 0 || before.length === 0) {
            return [];
        }
        const sources: [BoardBox, DesignNode][] = [];
        const byDistance = (board: BoardBox) => (candidate: BoardBox) =>
            Math.hypot(candidate.x - board.x, candidate.y - board.y);
        const near = [...before].sort((a, b) => byDistance(added[0])(a) - byDistance(added[0])(b));
        for (const board of near.slice(0, CanvasCheck.MAX_SOURCES)) {
            const tree = await this.tree(board.id);
            if (tree) {
                sources.push([board, tree]);
            }
        }
        const problems: CanvasProblem[] = [];
        for (const board of added) {
            const tree = await this.tree(board.id);
            const problem = tree ? CanvasCheck.compare(board, tree, sources) : null;
            if (problem) {
                problems.push(problem);
            }
        }
        return problems;
    }

    /**
     * Compares a new board with the best matching source.
     *
     * @returns the difference, or null when no source matches or the fills agree
     */
    public static compare(board: BoardBox, tree: DesignNode, sources: [BoardBox, DesignNode][]): CanvasProblem | null {
        const layers = CanvasCheck.byName(tree);
        let best: { source: BoardBox; layers: Map<string, DesignNode>; shared: string[] } | null = null;
        for (const [source, sourceTree] of sources) {
            if (source.id === board.id) {
                continue;
            }
            const sourceLayers = CanvasCheck.byName(sourceTree);
            const shared = [...layers.keys()].filter((name) => sourceLayers.has(name));
            if (!best || shared.length > best.shared.length) {
                best = { source, layers: sourceLayers, shared };
            }
        }
        if (
            !best ||
            best.shared.length < CanvasCheck.MIN_SHARED ||
            best.shared.length < layers.size * CanvasCheck.MIN_SHARED_RATIO
        ) {
            return null;
        }
        const differing = best.shared.filter((name) => {
            const mine = layers.get(name)!.style.fills;
            const theirs = best!.layers.get(name)!.style.fills;
            return mine !== undefined && theirs !== undefined && !DesignTree.same(mine, theirs);
        });
        if (differing.length === 0) {
            return null;
        }
        const listed = differing.slice(0, CanvasCheck.MAX_LISTED);
        return {
            code: "style-differs",
            severity: "info",
            boardIds: [board.id, best.source.id],
            params: { board: board.name, source: best.source.name, layers: listed },
            text:
                `"${board.name}" looks like a version of "${best.source.name}", but these layers have other colors: ` +
                `${listed.join(", ")}. Ask me to match them if they should look the same.`,
        };
    }

    /** First layer of each (non-empty) name below the board root. */
    private static byName(tree: DesignNode): Map<string, DesignNode> {
        const layers = new Map<string, DesignNode>();
        for (const node of DesignTree.descendants(tree)) {
            if (node.name.trim().length > 0 && !layers.has(node.name)) {
                layers.set(node.name, node);
            }
        }
        return layers;
    }

    private async tree(nodeId: string): Promise<DesignNode | null> {
        if (!this.tools) {
            return null;
        }
        try {
            const result = await this.withTimeout(
                this.tools.call(CanvasCheck.PROPERTIES_TOOL, { nodeId, depth: CanvasCheck.TREE_DEPTH })
            );
            return result.isError ? null : DesignTree.parse(result.text);
        } catch (error) {
            this.logger.debug("Board read failed: %s", String(error));
            return null;
        }
    }

    /**
     * Pairs of boards on the same page whose areas overlap.
     */
    public static overlaps(boards: BoardBox[]): [BoardBox, BoardBox][] {
        const pairs: [BoardBox, BoardBox][] = [];
        for (let i = 0; i < boards.length; i++) {
            for (let j = i + 1; j < boards.length; j++) {
                const a = boards[i];
                const b = boards[j];
                if (a.pageId !== b.pageId) {
                    continue;
                }
                const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
                const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                if (width >= CanvasCheck.MIN_OVERLAP && height >= CanvasCheck.MIN_OVERLAP) {
                    pairs.push([a, b]);
                }
            }
        }
        return pairs;
    }

    private static key(a: BoardBox, b: BoardBox): string {
        return [a.id, b.id].sort().join("|");
    }

    private static parse(text: string): BoardBox[] | null {
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start < 0 || end < start) {
            return null;
        }
        try {
            const value = JSON.parse(text.slice(start, end + 1)) as unknown;
            if (!Array.isArray(value)) {
                return null;
            }
            return value.filter(
                (board): board is BoardBox =>
                    typeof board === "object" &&
                    board !== null &&
                    typeof board.id === "string" &&
                    typeof board.pageId === "string" &&
                    ["x", "y", "width", "height"].every((key) => typeof board[key] === "number")
            );
        } catch {
            return null;
        }
    }

    private withTimeout<T>(promise: Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs);
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }
}
