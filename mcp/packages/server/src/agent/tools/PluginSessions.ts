import type { PenpotSession } from "@penpot/mcp-common";

/**
 * Directory of the Penpot MCP plugin sessions connected to this process (one per browser tab
 * with the plugin loaded).
 */
export interface PluginSessionDirectory {
    /**
     * Finds the session of a tab showing a file.
     *
     * @param fileId - the Penpot file
     * @returns the session id, or undefined when no tab shows the file
     */
    sessionForFile(fileId: string): string | undefined;
}

/**
 * {@link PluginSessionDirectory} over the plugin bridge of the MCP server running in the same
 * process (single-user mode: the connections of the `null` user token).
 */
export class BridgeSessionDirectory implements PluginSessionDirectory {
    /**
     * @param bridge - the plugin bridge (`PenpotMcpServer.pluginBridge`)
     */
    constructor(
        private readonly bridge: {
            getUserConnections(userToken: string | null): { getSessions(): PenpotSession[] } | undefined;
        }
    ) {}

    public sessionForFile(fileId: string): string | undefined {
        const sessions = this.bridge.getUserConnections(null)?.getSessions() ?? [];
        // the same file open in two tabs: either session reads the same design
        return sessions.find((session) => session.fileId === fileId)?.sessionId;
    }
}
