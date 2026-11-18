import { randomUUID } from "crypto";
import { resolve } from "path";
import type { WebSocket, RawData } from "ws";
import type { AgentContext, ClientMessage, ContextSetMessage, DaemonMessage } from "@penpot/mcp-common";
import { createLogger } from "../logger";
import { AgentError, type AgentClient } from "./AgentClient";
import type { ChatService } from "./chat/ChatService";
import type { TurnSetup } from "./chat/TurnRunner";
import { ClientMessageSchema } from "./ClientMessageSchema";
import { PermissionBroker } from "./permissions/PermissionBroker";
import { ToolPermissionPolicy } from "./permissions/ToolPermissionPolicy";
import type { PreviewService } from "./process/PreviewService";
import type { McpToolsClient } from "./tools/McpToolsClient";
import type { WorkflowEngine } from "./workflows/WorkflowEngine";
import type { ProjectWorkspace } from "./workspace/ProjectWorkspace";
import type { WorkspaceManager } from "./workspace/WorkspaceManager";

/** Services and settings shared by all sessions. */
export interface AgentSessionDeps {
    daemonVersion: string;
    /** checks a pairing token */
    verifyToken(token: string): boolean;
    chat: ChatService;
    workflows: WorkflowEngine;
    previews: PreviewService;
    workspaces: WorkspaceManager;
    tools: McpToolsClient | null;
    /** time the client has to send `auth` */
    authTimeoutMs: number;
}

/** WebSocket close code for policy violations (bad or missing authentication). */
const POLICY_VIOLATION = 1008;

/**
 * One browser connection to `/agent`.
 *
 * The first message must be a valid `auth`; anything else, or no message within the time limit,
 * closes the connection. Afterwards, messages are validated and dispatched to the services; each
 * request runs on its own, so that e.g. `permission.respond` arrives while a chat turn waits for it.
 */
export class AgentSession implements AgentClient {
    public readonly id = randomUUID();
    private readonly logger = createLogger("AgentSession");
    private readonly closeController = new AbortController();
    private readonly broker: PermissionBroker;
    private readonly authTimer: NodeJS.Timeout;
    private authenticated = false;
    private context?: AgentContext;
    private workspace?: Promise<ProjectWorkspace>;
    private policy?: { projectId: string; policy: ToolPermissionPolicy };

    constructor(
        private readonly socket: WebSocket,
        private readonly deps: AgentSessionDeps
    ) {
        this.broker = new PermissionBroker((message) => this.send(message));
        this.authTimer = setTimeout(() => this.reject("Authentication timed out"), deps.authTimeoutMs);
        socket.on("message", (data, isBinary) => this.receive(data, isBinary));
        socket.on("close", () => this.dispose());
        socket.on("error", (error) => this.logger.warn("Socket error: %s", error.message));
    }

    public get closed(): AbortSignal {
        return this.closeController.signal;
    }

    public send(message: DaemonMessage): void {
        if (this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(message));
        }
    }

    public async setup(): Promise<Omit<TurnSetup, "signal">> {
        const context = this.context;
        const workspacePromise = this.workspace;
        if (!context || !workspacePromise) {
            throw new AgentError("no-context", "Send context.set first");
        }
        const workspace = await workspacePromise;
        if (this.policy?.projectId !== workspace.projectId) {
            this.policy = {
                projectId: workspace.projectId,
                policy: new ToolPermissionPolicy(workspace.guard, this.broker, () => this.context?.mcpSessionId, {
                    projectRoot: workspace.root,
                    // <home>/projects/<id>
                    penforgeHome: resolve(workspace.root, "..", ".."),
                }),
            };
        }
        const tools = this.deps.tools?.forSession(() => this.context?.mcpSessionId) ?? null;
        return { context, workspace, permissions: this.policy.policy, tools };
    }

    private receive(data: RawData, isBinary: boolean): void {
        let raw: unknown;
        try {
            raw = isBinary ? undefined : JSON.parse(data.toString());
        } catch {
            raw = undefined;
        }
        const parsed = ClientMessageSchema.parse(raw);
        if (!this.authenticated) {
            this.authenticate("message" in parsed ? parsed.message : undefined);
            return;
        }
        if ("error" in parsed) {
            this.send({ type: "error", rid: parsed.rid, code: "bad-request", message: parsed.error });
            return;
        }
        const message = parsed.message;
        this.dispatch(message).catch((error) => this.sendError(error, "rid" in message ? message.rid : undefined));
    }

    private authenticate(message: ClientMessage | undefined): void {
        if (message?.type !== "auth") {
            this.reject("The first message must be auth");
            return;
        }
        if (!this.deps.verifyToken(message.token)) {
            this.reject("Invalid token");
            return;
        }
        clearTimeout(this.authTimer);
        this.authenticated = true;
        this.send({ type: "auth.ok", daemonVersion: this.deps.daemonVersion });
    }

    private async dispatch(message: ClientMessage): Promise<void> {
        switch (message.type) {
            case "auth":
                throw new AgentError("bad-request", "Already authenticated");
            case "context.set":
                return this.setContext(message);
            case "chat.send":
                return this.deps.chat.send(this, message);
            case "chat.cancel":
                return this.deps.chat.cancel(this, message);
            case "chat.history":
                return this.deps.chat.history(this, message);
            case "permission.respond":
                if (!this.broker.respond(message.requestId, message.allow, message.remember ?? false)) {
                    throw new AgentError("bad-request", "No such permission request");
                }
                return;
            case "workflow.run":
                return this.deps.workflows.run(this, message);
            case "workflow.cancel":
                return this.deps.workflows.cancel(this, message);
            case "preview.start":
                return this.deps.previews.start(this, message);
            case "preview.stop":
                return this.deps.previews.stop(this, message);
        }
    }

    private async setContext(message: ContextSetMessage): Promise<void> {
        const { type: _type, ...context } = message;
        this.context = context;
        const workspace = this.deps.workspaces.open(context);
        this.workspace = workspace;
        try {
            await workspace;
        } catch (error) {
            if (this.workspace === workspace) {
                this.workspace = undefined;
            }
            throw error;
        }
    }

    private sendError(error: unknown, rid: string | undefined): void {
        if (error instanceof AgentError) {
            this.send({ type: "error", rid, code: error.code, message: error.message });
            return;
        }
        this.logger.error(error, "Request failed");
        this.send({
            type: "error",
            rid,
            code: "internal",
            message: error instanceof Error ? error.message : String(error),
        });
    }

    private reject(reason: string): void {
        clearTimeout(this.authTimer);
        this.logger.warn("Rejecting agent client: %s", reason);
        this.send({ type: "auth.error", reason });
        this.socket.close(POLICY_VIOLATION, reason);
    }

    private dispose(): void {
        clearTimeout(this.authTimer);
        this.closeController.abort();
        this.broker.denyAll();
    }
}
