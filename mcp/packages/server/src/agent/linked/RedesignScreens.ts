import type { WorkflowContext } from "@penpot/mcp-common";

/** A screen board of the design. */
export interface ScreenBoard {
    boardId: string;
    name: string;
    pageId: string | null;
    pageName: string | null;
    width: number;
    height: number;
}

/**
 * Screen boards of the open file for a Re-Design (W38): the top-level boards of every page,
 * except pages that hold the design system or components (W22 / W29 pages) and boards whose name
 * starts with `_` (scratch boards).
 */
export class RedesignScreens {
    /** boards taken at most */
    public static readonly MAX_SCREENS = 60;
    private static readonly SKIPPED_PAGE = /design system|components|library|styleguide|style guide|tokens/i;

    constructor(private readonly ctx: Pick<WorkflowContext, "tools">) {}

    /** Lists the screen boards; empty when the design cannot be read. */
    public async list(): Promise<ScreenBoard[]> {
        let result;
        try {
            result = await this.ctx.tools.call("list_boards", {});
        } catch {
            return [];
        }
        if (result.isError) {
            return [];
        }
        let boards: unknown;
        try {
            boards = JSON.parse(result.text);
        } catch {
            return [];
        }
        if (!Array.isArray(boards)) {
            return [];
        }
        return boards
            .filter((board) => board && typeof board.id === "string" && typeof board.name === "string")
            .filter((board) => !String(board.name).startsWith("_"))
            .filter((board) => !RedesignScreens.SKIPPED_PAGE.test(String(board.pageName ?? "")))
            .slice(0, RedesignScreens.MAX_SCREENS)
            .map((board) => ({
                boardId: board.id as string,
                name: board.name as string,
                pageId: typeof board.pageId === "string" ? board.pageId : null,
                pageName: typeof board.pageName === "string" ? board.pageName : null,
                width: Math.round(Number(board.width) || 0),
                height: Math.round(Number(board.height) || 0),
            }));
    }

    /**
     * Gets the last JSON object of a Claude answer (a fenced `json` block, else the last `{…}`).
     *
     * @param text - the answer
     * @returns the parsed value, or null
     */
    public static lastJson(text: string): unknown {
        const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/gi)];
        const candidates = blocks.length > 0 ? [blocks[blocks.length - 1][1]] : [];
        const start = text.lastIndexOf("\n{");
        if (start >= 0) {
            candidates.push(text.slice(start + 1));
        }
        for (const candidate of candidates) {
            try {
                return JSON.parse(candidate.trim());
            } catch {
                // next candidate
            }
        }
        return null;
    }
}
