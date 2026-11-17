import { z } from "zod";
import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";
import { PenforgeSchemas } from "./PenforgeSchemas";

/**
 * Arguments of {@link ListCanvasCommentsTool}.
 */
export class ListCanvasCommentsArgs {
    static schema = {
        pageId: PenforgeSchemas.PAGE_ID.optional().describe("Only threads of this page. Omit for all pages."),
        status: z
            .enum(["unresolved", "all"])
            .default("unresolved")
            .describe("'unresolved' (default) or 'all' (includes resolved threads)."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    pageId?: string;

    status: "unresolved" | "all" = "unresolved";

    sessionId?: string;
}

/**
 * Lists the comment threads of the open file.
 */
export class ListCanvasCommentsTool extends PenforgePluginTool<ListCanvasCommentsArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, ListCanvasCommentsArgs.schema);
    }

    public getToolName(): string {
        return "list_canvas_comments";
    }

    public getToolDescription(): string {
        return (
            "Lists the comment threads of the open file as JSON: " +
            "`[{threadId, seqNumber, pageId, boardId, nodeId, position, resolved, comments:[{author, date, " +
            "content}]}]`, sorted by seqNumber. `nodeId` is the deepest shape under the thread (null when the " +
            "connected Penpot cannot compute it); `pageId` may be null for threads outside any board on " +
            "older Penpot versions."
        );
    }

    protected async executeCore(args: ListCanvasCommentsArgs): Promise<ToolResponse> {
        const params: { pageId?: string; status: string } = { status: args.status ?? "unresolved" };
        if (args.pageId) {
            params.pageId = args.pageId;
        }
        const data = await this.callPlugin("listCanvasComments", params, args.sessionId);
        return PenforgePluginTool.json(data);
    }
}
