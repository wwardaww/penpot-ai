import { z } from "zod";
import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";
import { PenforgeSchemas } from "./PenforgeSchemas";

/**
 * Arguments of {@link GetAnimationsTool}.
 */
export class GetAnimationsArgs {
    static schema = {
        nodeIds: z
            .array(PenforgeSchemas.NODE_ID)
            .min(1)
            .max(200)
            .optional()
            .describe("Layers to read, with what is inside them."),
        boardId: PenforgeSchemas.NODE_ID.optional().describe("A board (screen) to read, with what is inside it."),
        pageId: PenforgeSchemas.PAGE_ID.optional().describe("A page to read; the current page when nothing is given."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    nodeIds?: string[];

    boardId?: string;

    pageId?: string;

    sessionId?: string;
}

/**
 * Lists the animated layers of some layers, a board or a page (W32).
 */
export class GetAnimationsTool extends PenforgePluginTool<GetAnimationsArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, GetAnimationsArgs.schema);
    }

    public getToolName(): string {
        return "get_animations";
    }

    public getToolDescription(): string {
        return (
            "Lists layer animations (Penforge): pass `nodeIds` (those layers and what is inside them), or " +
            "`boardId`, or `pageId` (default: the current page). Returns `{pageId?, count, layers:[{nodeId, " +
            "name, type, path, parentId, pageId, boardId, boardName, codeName, component, childCount, " +
            "animations:{v, entrance?, exit?, states?, loop?, smart?}, smart?}]}`; only layers that have " +
            "an animation are listed. Read before changing animations with update_animations."
        );
    }

    protected async executeCore(args: GetAnimationsArgs): Promise<ToolResponse> {
        const params: Record<string, unknown> = {};
        if (args.nodeIds !== undefined) {
            params.nodeIds = args.nodeIds;
        } else if (args.boardId !== undefined) {
            params.boardId = args.boardId;
        } else if (args.pageId !== undefined) {
            params.pageId = args.pageId;
        }
        const data = await this.callPlugin("getAnimations", params, args.sessionId);
        return PenforgePluginTool.json(data);
    }
}
