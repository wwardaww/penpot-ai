import { z } from "zod";
import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";
import { PenforgeSchemas } from "./PenforgeSchemas";

/**
 * Arguments of {@link GetNodePropertiesTool}.
 */
export class GetNodePropertiesArgs {
    static schema = {
        nodeId: PenforgeSchemas.NODE_ID.describe("Id of the node (shape) to read."),
        depth: z
            .number()
            .int()
            .min(1)
            .max(5)
            .default(1)
            .describe(
                "Tree levels returned in full, starting with the node itself. 1 (default) = the node plus a " +
                    "summary (id, name, type, visible) of its children; 2 = the node and its children in full."
            ),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    nodeId!: string;

    depth: number = 1;

    sessionId?: string;
}

/**
 * Returns a deterministic property snapshot of a design node.
 */
export class GetNodePropertiesTool extends PenforgePluginTool<GetNodePropertiesArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, GetNodePropertiesArgs.schema);
    }

    public getToolName(): string {
        return "get_node_properties";
    }

    public getToolDescription(): string {
        return (
            "Returns the properties of a design node as JSON: geometry (absolute x/y, parentX/parentY, " +
            "width, height, rotation), constraints, layout (flex/grid of boards, layoutChild sizing and " +
            "margins), fills, strokes, shadows, blur, radius, text content with typography and styled " +
            "spans, applied tokens, component/variant info, prototype interactions and children. " +
            "Numbers are rounded to 2 decimals. Prefer this over execute_code for reading a node."
        );
    }

    protected async executeCore(args: GetNodePropertiesArgs): Promise<ToolResponse> {
        const data = await this.callPlugin(
            "getNodeProperties",
            { nodeId: args.nodeId, depth: args.depth ?? 1 },
            args.sessionId
        );
        return PenforgePluginTool.json(data);
    }
}
