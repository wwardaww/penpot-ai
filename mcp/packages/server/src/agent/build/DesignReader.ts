import { createHash } from "crypto";
import type { WorkflowToolsApi } from "@penpot/mcp-common";

/** Top-level board of the design with its content hash. */
export interface DesignBoard {
    id: string;
    name: string;
    pageId: string;
    pageName: string;
    width: number;
    height: number;
    /** sha256 of the board's generated markup and style (changes with any visible change) */
    hash: string;
}

/** Navigation edge between two boards (prototype interaction). */
export interface DesignEdge {
    from: string;
    to: string;
    trigger: string;
    sourceName: string;
}

/** What the build needs to know about the design. */
export interface DesignSnapshot {
    boards: DesignBoard[];
    edges: DesignEdge[];
    flows: { name: string; startingBoardId: string }[];
}

/**
 * Reader of the open design through the typed Penpot tools (`list_boards`,
 * `get_prototype_graph`, `generate_code_hints`).
 *
 * Every board gets a hash of its code hints (HTML and CSS of the whole subtree), so the build can
 * tell which screens changed since the last run.
 */
export class DesignReader {
    constructor(private readonly tools: WorkflowToolsApi) {}

    /** Reads boards, navigation and per-board hashes. */
    public async read(): Promise<DesignSnapshot> {
        const boards = this.array(await this.callJson("list_boards", {}));
        const graph = this.object(await this.callJson("get_prototype_graph", {}));
        const result: DesignBoard[] = [];
        for (const board of boards) {
            const id = String(board.id ?? "");
            if (id.length === 0) {
                continue;
            }
            result.push({
                id,
                name: String(board.name ?? id),
                pageId: String(board.pageId ?? ""),
                pageName: String(board.pageName ?? ""),
                width: Number(board.width ?? 0),
                height: Number(board.height ?? 0),
                hash: await this.hash(id),
            });
        }
        const edges = this.array(graph.edges).map((edge) => ({
            from: String(edge.from ?? ""),
            to: String(edge.to ?? ""),
            trigger: String(edge.trigger ?? ""),
            sourceName: String(edge.sourceName ?? ""),
        }));
        const flows = this.array(graph.flows).map((flow) => ({
            name: String(flow.name ?? ""),
            startingBoardId: String(flow.startingBoardId ?? ""),
        }));
        return { boards: result, edges, flows };
    }

    /** Hashes a board's code hints; falls back to its properties when code hints fail. */
    private async hash(boardId: string): Promise<string> {
        let result = await this.tools.call("generate_code_hints", { nodeId: boardId });
        if (result.isError) {
            result = await this.tools.call("get_node_properties", { nodeId: boardId, depth: 5 });
        }
        if (result.isError) {
            throw new Error(`Could not read board ${boardId}: ${result.text}`);
        }
        return createHash("sha256").update(result.text).digest("hex");
    }

    private async callJson(tool: string, args: Record<string, unknown>): Promise<unknown> {
        const result = await this.tools.call(tool, args);
        if (result.isError) {
            throw new Error(`${tool} failed: ${result.text}`);
        }
        try {
            return JSON.parse(result.text);
        } catch {
            throw new Error(`${tool} returned no JSON`);
        }
    }

    private array(value: unknown): Record<string, unknown>[] {
        return Array.isArray(value) ? value.filter((item) => item !== null && typeof item === "object") : [];
    }

    private object(value: unknown): Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    }
}
