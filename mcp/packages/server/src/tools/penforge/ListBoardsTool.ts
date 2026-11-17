import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";
import { PenforgeSchemas } from "./PenforgeSchemas";

/**
 * Arguments of {@link ListBoardsTool}.
 */
export class ListBoardsArgs {
    static schema = {
        pageId: PenforgeSchemas.PAGE_ID.optional().describe("Only boards of this page. Omit for all pages."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    pageId?: string;

    sessionId?: string;
}

/**
 * Lists the top-level boards (screens) of the open file.
 */
export class ListBoardsTool extends PenforgePluginTool<ListBoardsArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, ListBoardsArgs.schema);
    }

    public getToolName(): string {
        return "list_boards";
    }

    public getToolDescription(): string {
        return (
            "Lists the top-level boards (screens) of one page or of all pages as JSON: " +
            "`[{id, name, pageId, pageName, x, y, width, height, flowsStarted, interactions}]`. " +
            "`interactions` holds the prototype interactions of the board and its descendants " +
            "(`sourceId`, `trigger`, `action` with destination)."
        );
    }

    protected async executeCore(args: ListBoardsArgs): Promise<ToolResponse> {
        const data = await this.callPlugin("listBoards", args.pageId ? { pageId: args.pageId } : {}, args.sessionId);
        return PenforgePluginTool.json(data);
    }
}
