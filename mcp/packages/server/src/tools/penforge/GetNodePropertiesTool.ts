import { z } from "zod";
import { Tool } from "../../Tool";
import { TextResponse, type ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";
import { NodePropertiesPage } from "./NodePropertiesPage";
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
        childOffset: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe("Index of the first child to return; use childrenPage.nextOffset of the previous answer."),
        childLimit: z
            .number()
            .int()
            .min(1)
            .max(NodePropertiesPage.MAX_LIMIT)
            .default(NodePropertiesPage.DEFAULT_LIMIT)
            .describe("Largest number of children to return in one answer."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    nodeId!: string;

    depth: number = 1;

    childOffset: number = 0;

    childLimit: number = NodePropertiesPage.DEFAULT_LIMIT;

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
            "Numbers are rounded to 2 decimals. Prefer this over execute_code for reading a node. " +
            "Large nodes come in pages of children: when the answer has childrenPage.nextOffset, call " +
            "again with childOffset set to it; childrenPage.summarized means the children were cut to " +
            "summaries to fit, so read the ones you need on their own."
        );
    }

    protected async executeCore(args: GetNodePropertiesArgs): Promise<ToolResponse> {
        const data = await this.callPlugin(
            "getNodeProperties",
            {
                nodeId: args.nodeId,
                depth: args.depth ?? 1,
                childOffset: args.childOffset ?? 0,
                childLimit: args.childLimit ?? NodePropertiesPage.DEFAULT_LIMIT,
            },
            args.sessionId
        );
        return new TextResponse(NodePropertiesPage.render(data, args.childOffset ?? 0, args.childLimit));
    }
}
