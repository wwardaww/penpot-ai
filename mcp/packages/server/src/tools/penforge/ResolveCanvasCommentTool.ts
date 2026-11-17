import { z } from "zod";
import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";

/**
 * Arguments of {@link ResolveCanvasCommentTool}.
 */
export class ResolveCanvasCommentArgs {
    static schema = {
        threadId: z.string().min(1).max(128).describe("Id of the thread, as returned by list_canvas_comments."),
        resolutionNote: z
            .string()
            .max(5000)
            .optional()
            .describe("Optional note posted as a reply before the thread is resolved, e.g. what was changed."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    threadId!: string;

    resolutionNote?: string;

    sessionId?: string;
}

/**
 * Resolves a comment thread, optionally replying with a note first.
 */
export class ResolveCanvasCommentTool extends PenforgePluginTool<ResolveCanvasCommentArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, ResolveCanvasCommentArgs.schema);
    }

    public getToolName(): string {
        return "resolve_canvas_comment";
    }

    public getToolDescription(): string {
        return (
            "Marks a comment thread as resolved. If `resolutionNote` is given, it is posted as a reply " +
            "first. Returns `{ok, threadId, replied, resolved}`."
        );
    }

    protected async executeCore(args: ResolveCanvasCommentArgs): Promise<ToolResponse> {
        const params: { threadId: string; resolutionNote?: string } = { threadId: args.threadId };
        if (args.resolutionNote !== undefined) {
            params.resolutionNote = args.resolutionNote;
        }
        const data = await this.callPlugin("resolveCanvasComment", params, args.sessionId);
        return PenforgePluginTool.json(data);
    }
}
