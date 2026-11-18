import { z } from "zod";
import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import { TextResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PublishRequests } from "./PublishServices";

/** What the chat asks to publish. */
export const PUBLISH_TARGETS = ["share", "zip", "github", "vercel", "netlify", "phone"] as const;

/**
 * Arguments of {@link OpenPublishTool}.
 */
export class OpenPublishArgs {
    static schema = {
        target: z
            .enum(PUBLISH_TARGETS)
            .describe(
                "What the user asked for: zip (download the code), github (push to a GitHub repository), " +
                    "vercel or netlify (put the app online), phone (open the mobile app on a phone), " +
                    "share (not specific)."
            ),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    target!: (typeof PUBLISH_TARGETS)[number];

    sessionId?: string;
}

/**
 * Opens Penforge's Share panel from the AI chat (W20).
 *
 * Publishing needs the user's confirmation and accounts that Claude never sees, so Claude does
 * not publish itself: this tool records the request for the tab (by its MCP session) and the
 * Penforge client, which sees the tool call in the chat, opens the panel on that target.
 */
export class OpenPublishTool extends Tool<OpenPublishArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, OpenPublishArgs.schema);
    }

    public getToolName(): string {
        return "penforge_open_publish";
    }

    public getToolDescription(): string {
        return (
            "Penforge only. Opens the Share panel where the user downloads, publishes or deploys the " +
            "generated app (ZIP download, GitHub, Vercel, Netlify, phone preview with a QR code). Call it " +
            "when the user asks to publish, share, deploy, download, push to GitHub or open the app on a " +
            "phone; never publish with shell commands or ask for tokens. The user confirms in the panel."
        );
    }

    protected async executeCore(args: OpenPublishArgs): Promise<ToolResponse> {
        if (args.sessionId) {
            PublishRequests.shared.record(args.sessionId, args.target);
        }
        return new TextResponse(
            "The Share panel is open in Penforge. Tell the user in one short sentence to confirm there; " +
                "accounts are connected in the panel, never in the chat."
        );
    }
}
