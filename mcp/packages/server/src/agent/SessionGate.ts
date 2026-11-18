import type { IncomingMessage } from "http";
import type { AgentContext } from "@penpot/mcp-common";
import type { ToolPermissionHandler } from "./runner/ClaudeRunner";
import type { McpToolsClient } from "./tools/McpToolsClient";
import type { ProjectWorkspace } from "./workspace/ProjectWorkspace";

/**
 * Access control of one browser connection in a hosting mode (W24 server mode).
 *
 * Local mode has no gate: the pairing token and the Origin check decide. A gate replaces the
 * token check, checks every context the client sets, runs each request in the user's scope and
 * may narrow Claude's tools.
 */
export interface SessionGate {
    /**
     * Checks the connection's `auth` message (and the upgrade request the gate was opened for).
     *
     * @param token - token of the `auth` message
     */
    authenticate(token: string): Promise<boolean>;

    /**
     * Checks a context the client sets and returns the context to use.
     *
     * @param context - the context sent by the client
     * @throws AgentError when the user may not work on the context's project
     */
    authorize(context: AgentContext): Promise<AgentContext>;

    /**
     * Runs a request of the connection in the user's scope.
     *
     * @param fn - the request
     */
    run<T>(fn: () => T): T;

    /**
     * Gets Claude's tool policy for a project.
     *
     * @param policy - the local policy
     * @param workspace - the project workspace
     */
    permissions(policy: ToolPermissionHandler, workspace: ProjectWorkspace): ToolPermissionHandler;

    /**
     * Gets the client of the Penpot MCP endpoint for direct tool calls of the user.
     *
     * @param base - the daemon's shared client
     */
    tools(base: McpToolsClient | null): McpToolsClient | null;
}

/** Opens a {@link SessionGate} per WebSocket upgrade. */
export interface SessionGateFactory {
    /**
     * @param request - the upgrade request (headers carry the user's credentials)
     */
    open(request: IncomingMessage): SessionGate;
}
