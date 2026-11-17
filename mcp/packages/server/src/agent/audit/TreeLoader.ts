import type { WorkflowToolsApi } from "@penpot/mcp-common";
import type { NodeSnapshot } from "./DesignTree";

/** Board summary from the `list_boards` tool. */
export interface BoardSummary {
    id: string;
    name: string;
    pageId: string;
    pageName?: string;
}

/**
 * Reads design data through the typed Penpot MCP tools (architecture §6).
 */
export class DesignReader {
    constructor(private readonly tools: WorkflowToolsApi) {}

    /**
     * Gets a node snapshot (`get_node_properties`).
     *
     * @param nodeId - the node id
     * @param depth - levels serialized in full
     */
    public async node(nodeId: string, depth: number): Promise<NodeSnapshot> {
        return (await this.call("get_node_properties", { nodeId, depth })) as NodeSnapshot;
    }

    /**
     * Lists the top-level boards of a page (`list_boards`).
     *
     * @param pageId - the page id
     */
    public async boards(pageId: string): Promise<BoardSummary[]> {
        const boards = await this.call("list_boards", { pageId });
        return Array.isArray(boards) ? (boards as BoardSummary[]) : [];
    }

    /**
     * Calls a tool and parses its JSON text output.
     *
     * @param tool - the tool name
     * @param args - the arguments
     * @throws Error with the tool's message when the call fails
     */
    public async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
        const result = await this.tools.call(tool, args);
        if (result.isError) {
            throw new Error(result.text || `${tool} failed`);
        }
        try {
            return JSON.parse(result.text);
        } catch {
            throw new Error(`${tool} returned no JSON: ${result.text.slice(0, 200)}`);
        }
    }
}

/**
 * Loads full node trees, working around the depth limit of `get_node_properties`.
 *
 * Fetches each root with the maximum depth, then fetches again every node whose children came back
 * as summaries only, until the whole tree is full or the node limit is reached.
 */
export class TreeLoader {
    /** maximum depth `get_node_properties` accepts */
    public static readonly MAX_DEPTH = 5;

    /** Whether the last {@link load} stopped at the node limit. */
    public truncated = false;

    /**
     * @param reader - the design reader
     * @param maxNodes - stop expanding after this many nodes
     */
    constructor(
        private readonly reader: DesignReader,
        private readonly maxNodes = 5000
    ) {}

    /**
     * Loads the full trees of some nodes.
     *
     * @param nodeIds - the root node ids
     */
    public async load(nodeIds: string[]): Promise<NodeSnapshot[]> {
        this.truncated = false;
        let count = 0;
        const roots: NodeSnapshot[] = [];
        for (const id of nodeIds) {
            const root = await this.reader.node(id, TreeLoader.MAX_DEPTH);
            roots.push(root);
            const pending: NodeSnapshot[] = [root];
            while (pending.length > 0) {
                const node = pending.shift()!;
                count++;
                const children = node.children ?? [];
                for (let i = 0; i < children.length; i++) {
                    let child = children[i];
                    if (!child.geometry) {
                        if (count >= this.maxNodes) {
                            this.truncated = true;
                            continue;
                        }
                        child = await this.reader.node(child.id, TreeLoader.MAX_DEPTH);
                        children[i] = child;
                    }
                    pending.push(child);
                }
            }
        }
        return roots;
    }
}
