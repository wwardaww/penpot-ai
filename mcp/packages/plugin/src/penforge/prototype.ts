import type { Board, Page, Shape } from "@penpot/plugin-types";
import { NodeSerializer } from "./serialize.ts";
import type { JsonObject } from "./serialize.ts";

/**
 * Reads boards, flows and navigation interactions of a file.
 *
 * Boards are the top-level boards of each page (the screens of a prototype). Interactions of a
 * board include those of all its descendants, attributed to the board as their source screen.
 */
export class PrototypeReader {
    /**
     * Lists the top-level boards of the given pages with size, started flows and outgoing interactions.
     *
     * @param pages - the pages to read
     */
    public listBoards(pages: Page[]): JsonObject[] {
        const result: JsonObject[] = [];
        for (const page of pages) {
            const flows = page.flows ?? [];
            for (const board of PrototypeReader.topLevelBoards(page)) {
                const r = NodeSerializer.round;
                result.push({
                    id: board.id,
                    name: board.name,
                    pageId: page.id,
                    pageName: page.name,
                    x: r(board.x),
                    y: r(board.y),
                    width: r(board.width),
                    height: r(board.height),
                    flowsStarted: flows.filter((flow) => flow.startingBoard?.id === board.id).map((flow) => flow.name),
                    interactions: PrototypeReader.interactionsOf(board).map(({ source, interaction }) => ({
                        sourceId: source.id,
                        sourceName: source.name,
                        ...NodeSerializer.interaction(interaction),
                    })),
                });
            }
        }
        return result;
    }

    /**
     * Builds the prototype graph: pages, flows, boards and board-to-board edges.
     *
     * @param pages - the pages to read
     */
    public graph(pages: Page[]): JsonObject {
        const pageEntries: JsonObject[] = [];
        const flows: JsonObject[] = [];
        const boards: JsonObject[] = [];
        const edges: JsonObject[] = [];
        for (const page of pages) {
            const topLevel = PrototypeReader.topLevelBoards(page);
            pageEntries.push({ id: page.id, name: page.name, boardCount: topLevel.length });
            for (const flow of page.flows ?? []) {
                flows.push({
                    name: flow.name,
                    pageId: page.id,
                    startingBoardId: flow.startingBoard?.id ?? null,
                    startingBoardName: flow.startingBoard?.name ?? null,
                });
            }
            for (const board of topLevel) {
                boards.push({ id: board.id, name: board.name, pageId: page.id });
                for (const { source, interaction } of PrototypeReader.interactionsOf(board)) {
                    const serialized = NodeSerializer.interaction(interaction);
                    const action = serialized.action as JsonObject;
                    if (!action.destinationId) {
                        continue;
                    }
                    edges.push({
                        from: board.id,
                        to: action.destinationId,
                        type: action.type,
                        trigger: serialized.trigger,
                        sourceId: source.id,
                        sourceName: source.name,
                        pageId: page.id,
                    });
                }
            }
        }
        return { pages: pageEntries, flows, boards, edges };
    }

    private static topLevelBoards(page: Page): Board[] {
        const root: any = page.root;
        const children: Shape[] = root && Array.isArray(root.children) ? root.children : [];
        return children.filter((child): child is Board => child.type === "board");
    }

    private static interactionsOf(board: Board): { source: Shape; interaction: any }[] {
        const result: { source: Shape; interaction: any }[] = [];
        const walk = (shape: Shape) => {
            for (const interaction of shape.interactions ?? []) {
                result.push({ source: shape, interaction });
            }
            const children: Shape[] = Array.isArray((shape as any).children) ? (shape as any).children : [];
            for (const child of children) {
                walk(child);
            }
        };
        walk(board);
        return result;
    }
}
