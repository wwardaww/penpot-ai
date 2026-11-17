import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { WorkflowToolResult, WorkflowToolsApi } from "@penpot/mcp-common";
import { createLogger } from "../../logger";

/**
 * Client of the daemon's own Penpot MCP endpoint, used by workflows to call tools directly.
 *
 * Connects lazily and reconnects after a failed call.
 */
export class McpToolsClient {
    private readonly logger = createLogger("McpToolsClient");
    private client: Promise<Client> | null = null;

    /**
     * @param mcpUrl - URL of the Penpot MCP endpoint
     */
    constructor(private readonly mcpUrl: string) {}

    /**
     * Calls a tool.
     *
     * @param toolName - the MCP tool name (without the `mcp__penpot__` prefix)
     * @param args - the tool arguments
     */
    public async call(toolName: string, args: Record<string, unknown>): Promise<WorkflowToolResult> {
        try {
            const client = await this.connect();
            const result = await client.callTool({ name: toolName, arguments: args });
            const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
            return {
                isError: result.isError === true,
                content,
                text: content
                    .filter((part: any) => part?.type === "text")
                    .map((part: any) => String(part.text))
                    .join("\n"),
            };
        } catch (error) {
            this.reset();
            throw error;
        }
    }

    /**
     * Lists the names of the available tools.
     */
    public async list(): Promise<string[]> {
        try {
            const client = await this.connect();
            const result = await client.listTools();
            return result.tools.map((tool) => tool.name);
        } catch (error) {
            this.reset();
            throw error;
        }
    }

    /**
     * Creates the tools view of one client tab, which adds the tab's MCP session id to every call.
     *
     * @param sessionId - gets the tab's Penpot MCP session id
     */
    public forSession(sessionId: () => string | undefined): WorkflowToolsApi {
        return new SessionTools(this, sessionId);
    }

    /** Closes the connection. */
    public async close(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) {
            await client.then((c) => c.close()).catch(() => {});
        }
    }

    private connect(): Promise<Client> {
        if (!this.client) {
            this.client = (async () => {
                const client = new Client({ name: "penforge-daemon", version: "1.0.0" });
                await client.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl)));
                this.logger.info("Connected to Penpot MCP endpoint %s", this.mcpUrl);
                return client;
            })();
        }
        return this.client;
    }

    private reset(): void {
        void this.close();
    }
}

/**
 * Tools view of one client tab.
 */
class SessionTools implements WorkflowToolsApi {
    constructor(
        private readonly client: McpToolsClient,
        private readonly sessionId: () => string | undefined
    ) {}

    public call(toolName: string, args: Record<string, unknown> = {}): Promise<WorkflowToolResult> {
        const sessionId = this.sessionId();
        const withSession = sessionId && args.sessionId === undefined ? { ...args, sessionId } : args;
        return this.client.call(toolName, withSession);
    }

    public list(): Promise<string[]> {
        return this.client.list();
    }
}
