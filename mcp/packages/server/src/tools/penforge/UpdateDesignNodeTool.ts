import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";
import { PenforgeSchemas } from "./PenforgeSchemas";

/**
 * Arguments of {@link UpdateDesignNodeTool}.
 */
export class UpdateDesignNodeArgs {
    static schema = {
        nodeId: PenforgeSchemas.NODE_ID.describe("Id of the node (shape) to change."),
        mutations: PenforgeSchemas.MUTATIONS.describe(
            "Changes to apply. Only these keys are accepted: name, text, fills, strokes, x, y, width, " +
                "height, visible, opacity, radius, layout, layoutChild, tokens. Values use the same format " +
                "as get_node_properties."
        ),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    nodeId!: string;

    mutations!: Record<string, unknown>;

    sessionId?: string;
}

/**
 * Applies whitelisted changes to a design node through the Plugin API.
 */
export class UpdateDesignNodeTool extends PenforgePluginTool<UpdateDesignNodeArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, UpdateDesignNodeArgs.schema);
    }

    public getToolName(): string {
        return "update_design_node";
    }

    public getToolDescription(): string {
        return (
            "Changes a design node: name, text, fills, strokes, position, size, visibility, opacity, " +
            "radius, board layout, layout-child sizing and design tokens. Opens the node's page if " +
            "needed, applies all changes as one undo step (the user can revert with Ctrl+Z) and returns " +
            "`{applied, undoGrouped, node}` where `node` is the new property snapshot. Unknown keys are " +
            "rejected. Prefer this over execute_code for property changes."
        );
    }

    protected async executeCore(args: UpdateDesignNodeArgs): Promise<ToolResponse> {
        const data = await this.callPlugin(
            "updateDesignNode",
            { nodeId: args.nodeId, mutations: args.mutations },
            args.sessionId
        );
        return PenforgePluginTool.json(data);
    }
}
