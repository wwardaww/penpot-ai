import type { AgentErrorCode, DaemonMessage } from "@penpot/mcp-common";
import type { TurnSetup } from "./chat/TurnRunner";

/**
 * Error reported to the client as an `error` message with the given code.
 */
export class AgentError extends Error {
    constructor(
        public readonly code: AgentErrorCode,
        message: string
    ) {
        super(message);
        this.name = "AgentError";
    }
}

/**
 * Authenticated browser client of the daemon, as seen by the services.
 */
export interface AgentClient {
    /** unique id of the connection */
    readonly id: string;
    /** aborted when the client disconnects */
    readonly closed: AbortSignal;

    /** Sends a message to the client (dropped once disconnected). */
    send(message: DaemonMessage): void;

    /**
     * Gets the client's context, project workspace, permission policy and tools.
     *
     * @throws AgentError `no-context` before the first `context.set`
     */
    setup(): Promise<Omit<TurnSetup, "signal">>;
}
