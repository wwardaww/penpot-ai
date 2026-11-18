import { z } from "zod";
import { Tool } from "../../Tool";
import { ImageContent, TextContent, ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { QaChat } from "./QaChat";
import { VisualQaHost } from "./QaRun";

/** Arguments of `penforge_visual_qa`. */
export class VisualQaToolArgs {
    static schema = {
        fileId: z
            .string()
            .min(1)
            .max(128)
            .describe("Id of the Penpot file open in the user's tab (listed in your instructions)."),
        boardIds: z
            .array(z.string().min(1).max(128))
            .max(50)
            .optional()
            .describe("Only these design boards (screens). Omit to check every screen of the last build."),
        commit: z
            .boolean()
            .optional()
            .describe("true = do not check; commit the code changes in app-src as one 'penforge(qa)' commit."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    fileId!: string;

    boardIds?: string[];

    commit?: boolean;

    sessionId?: string;
}

/**
 * MCP tool of the Penforge daemon that lets the AI chat run the visual QA (W18): it starts the
 * app's dev server if needed, screenshots each built screen in a headless browser at its board's
 * size, scores it against the design board and returns the scores, the saved image paths and the
 * images of the worst screen. Only available while the Penforge daemon runs in this process.
 */
export class VisualQaTool extends Tool<VisualQaToolArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, VisualQaToolArgs.schema);
    }

    public getToolName(): string {
        return "penforge_visual_qa";
    }

    public getToolDescription(): string {
        return (
            "Penforge only. Checks whether the built app looks like the design: screenshots each screen of " +
            "the running app at its design board's size, compares it with the board and returns per-screen " +
            "scores (0-100, threshold included), the screen's source files, the areas that differ, saved " +
            "PNG paths and the images of the worst screen. Read-only; with commit: true it commits the " +
            "app code changes instead. Use it when the user asks whether the app matches the design."
        );
    }

    protected async executeCore(args: VisualQaToolArgs): Promise<ToolResponse> {
        const services = VisualQaHost.get();
        if (!services) {
            throw new Error("The Penforge daemon is not running in this MCP server.");
        }
        const content = await new QaChat(services).handle({
            fileId: args.fileId,
            boardIds: args.boardIds,
            commit: args.commit,
            sessionId: args.sessionId,
        });
        return new ToolResponse(
            content.map((part) =>
                part.type === "text" ? new TextContent(part.text) : new ImageContent(part.data, part.mimeType)
            )
        );
    }
}
