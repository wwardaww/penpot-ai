import type { WorkflowToolsApi } from "@penpot/mcp-common";
import { createLogger } from "../../logger";

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
    code: "boards-overlap";
    /** the boards involved */
    boardIds: string[];
    /** parameters for the client's wording */
    params: { names: string[] };
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
 */
export class CanvasCheck {
    private static readonly LIST_TOOL = "list_boards";
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
                code: "boards-overlap",
                boardIds: [a.id, b.id],
                params: { names: [a.name, b.name] },
                text:
                    `The screens "${a.name}" and "${b.name}" overlap on the canvas, so one hides the other. ` +
                    "Move one of them, or ask me to fix it.",
            }));
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
