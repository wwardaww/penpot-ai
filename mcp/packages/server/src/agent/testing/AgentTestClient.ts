import WebSocket from "ws";
import type { ClientMessage, DaemonMessage } from "@penpot/mcp-common";

/**
 * WebSocket client of the agent endpoint for tests and smoke scripts.
 *
 * Queues incoming messages, so that a test can wait for the next message of a given type.
 */
export class AgentTestClient {
    private readonly inbox: DaemonMessage[] = [];
    private readonly waiters: { match: (message: DaemonMessage) => boolean; resolve: (m: DaemonMessage) => void }[] =
        [];
    public readonly closed: Promise<{ code: number; reason: string }>;

    private constructor(private readonly socket: WebSocket) {
        socket.on("message", (data) => this.deliver(JSON.parse(data.toString()) as DaemonMessage));
        this.closed = new Promise((resolve) =>
            socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }))
        );
    }

    /**
     * Connects to the agent endpoint.
     *
     * @param url - endpoint URL, e.g. `ws://127.0.0.1:4410/agent`
     * @param origin - `Origin` header to send, if any
     * @throws Error with the HTTP status if the upgrade is refused
     */
    public static connect(url: string, origin?: string): Promise<AgentTestClient> {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(url, origin ? { origin } : {});
            socket.once("open", () => resolve(new AgentTestClient(socket)));
            socket.once("unexpected-response", (_request, response) =>
                reject(new Error(`HTTP ${response.statusCode}`))
            );
            socket.once("error", reject);
        });
    }

    /** Sends a message (or any raw value, to test validation). */
    public send(message: ClientMessage | Record<string, unknown>): void {
        this.socket.send(JSON.stringify(message));
    }

    /**
     * Waits for the next message of a type that matches a predicate; earlier messages of other types
     * stay queued.
     *
     * @param type - the message type
     * @param match - extra condition
     * @param timeoutMs - time limit
     */
    public next<T extends DaemonMessage["type"]>(
        type: T,
        match: (message: Extract<DaemonMessage, { type: T }>) => boolean = () => true,
        timeoutMs = 10_000
    ): Promise<Extract<DaemonMessage, { type: T }>> {
        const matches = (message: DaemonMessage) =>
            message.type === type && match(message as Extract<DaemonMessage, { type: T }>);
        const index = this.inbox.findIndex(matches);
        if (index >= 0) {
            return Promise.resolve(this.inbox.splice(index, 1)[0] as Extract<DaemonMessage, { type: T }>);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
            this.waiters.push({
                match: matches,
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message as Extract<DaemonMessage, { type: T }>);
                },
            });
        });
    }

    /**
     * Waits for the next message of any type.
     *
     * @param timeoutMs - time limit
     */
    public nextAny(timeoutMs = 10_000): Promise<DaemonMessage> {
        if (this.inbox.length > 0) {
            return Promise.resolve(this.inbox.shift()!);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Timed out waiting for a message")), timeoutMs);
            this.waiters.push({
                match: () => true,
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message);
                },
            });
        });
    }

    /** Gets and removes all queued messages. */
    public drain(): DaemonMessage[] {
        return this.inbox.splice(0, this.inbox.length);
    }

    /** Closes the connection. */
    public close(): void {
        this.socket.close();
    }

    private deliver(message: DaemonMessage): void {
        const index = this.waiters.findIndex((waiter) => waiter.match(message));
        if (index >= 0) {
            this.waiters.splice(index, 1)[0].resolve(message);
        } else {
            this.inbox.push(message);
        }
    }
}
