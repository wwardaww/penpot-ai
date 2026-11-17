import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";

/**
 * Arguments of {@link GetPrototypeGraphTool}.
 */
export class GetPrototypeGraphArgs {
    static schema = {
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    sessionId?: string;
}

/**
 * Returns the prototype navigation graph of the open file.
 */
export class GetPrototypeGraphTool extends PenforgePluginTool<GetPrototypeGraphArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, GetPrototypeGraphArgs.schema);
    }

    public getToolName(): string {
        return "get_prototype_graph";
    }

    public getToolDescription(): string {
        return (
            "Returns the prototype graph of the open file as JSON: `{pages, flows, boards, edges}`. " +
            "`boards` are the top-level boards; `edges` are board-to-board links " +
            "`{from, to, type, trigger, sourceId, sourceName, pageId}` from navigate-to and overlay " +
            "interactions."
        );
    }

    protected async executeCore(args: GetPrototypeGraphArgs): Promise<ToolResponse> {
        const data = await this.callPlugin("getPrototypeGraph", {}, args.sessionId);
        return PenforgePluginTool.json(data);
    }
}
