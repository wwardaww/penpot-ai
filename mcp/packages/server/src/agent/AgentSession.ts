import { randomUUID } from "crypto";
import { resolve } from "path";
import type { WebSocket, RawData } from "ws";
import type { AgentContext, ClientMessage, ContextSetMessage, DaemonMessage } from "@penpot/mcp-common";
import { createLogger } from "../logger";
import { AgentError, type AgentClient } from "./AgentClient";
import type { AppsService } from "./apps/AppsService";
import type { ChatService } from "./chat/ChatService";
import type { LinkService } from "./linked/LinkService";
import { ProjectTypes } from "./linked/ProjectTypes";
import type { TurnSetup } from "./chat/TurnRunner";
import { ClientMessageSchema } from "./ClientMessageSchema";
import type { SessionGate } from "./SessionGate";
import { PermissionBroker } from "./permissions/PermissionBroker";
import { ToolPermissionPolicy } from "./permissions/ToolPermissionPolicy";
import type { PreviewService } from "./process/PreviewService";
import type { ToolPermissionHandler } from "./runner/ClaudeRunner";
import type { McpToolsClient } from "./tools/McpToolsClient";
import type { PluginSessionDirectory } from "./tools/PluginSessions";
import type { WorkflowEngine } from "./workflows/WorkflowEngine";
import type { ProjectWorkspace } from "./workspace/ProjectWorkspace";
import type { OutputService } from "./workspace/OutputService";
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
    /** finds the MCP plugin session of a file when the tab did not send its own */
    pluginSessions?: PluginSessionDirectory;
    /** time the client has to send `auth` */
    authTimeoutMs: number;
    /** access control of a hosting mode; replaces {@link verifyToken} when set */
    gate?: SessionGate;
    /** built apps on the dashboard (W33) */
    apps?: AppsService;
    /** folder browser and project links of Game UI / Existing projects (W38) */
    links?: LinkService;
    /** output folders of web and mobile projects (W41) */
    outputs?: OutputService;
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
    /** pending gate check of the `auth` message; later messages wait for it */
    private authenticating?: Promise<void>;
    private context?: AgentContext;
    private workspace?: Promise<ProjectWorkspace>;
    /** Callbacks waiting for the first `context.set` (see {@link waitForContext}). */
    private contextWaiters: Array<() => void> = [];
    private policy?: { projectId: string; policy: ToolPermissionHandler };

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

    /** Whether this tab is signed in and has an open file (it sent `context.set`). */
    public get showsFile(): boolean {
        return this.authenticated && this.context !== undefined;
    }

    public send(message: DaemonMessage): void {
        if (this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(message));
        }
    }

    /** How long a request that needs the context waits for a `context.set` sent right after it. */
    public static readonly CONTEXT_WAIT_MS = 3000;

    public async setup(): Promise<Omit<TurnSetup, "signal">> {
        const gate = this.deps.gate;
        await this.waitForContext();
        const context = this.context;
        const workspacePromise = this.workspace;
        if (!context || !workspacePromise) {
            throw new AgentError("no-context", "Send context.set first");
        }
        const workspace = await workspacePromise;
        if (this.policy?.projectId !== workspace.projectId) {
            this.policy = {
                projectId: workspace.projectId,
                policy: ToolPermissionPolicyFor.session(
                    gate,
                    workspace,
                    new ToolPermissionPolicy(workspace.guard, this.broker, () => this.mcpSessionId(), {
                        projectRoot: workspace.root,
                        // <home>/projects/<id>
                        penforgeHome: resolve(workspace.root, "..", ".."),
                    })
                ),
            };
        }
        const toolsClient = gate ? gate.tools(this.deps.tools) : this.deps.tools;
        const tools = toolsClient?.forSession(() => this.mcpSessionId()) ?? null;
        const mcpSessionId = this.mcpSessionId();
        // runs and turns carry the tab's MCP session, so their tools reach this tab's plugin
        // an Existing project designs for the platform detected in its code (W38)
        const linkedContext = ProjectTypes.withLink(context, workspace.linked);
        return {
            context: mcpSessionId ? { ...linkedContext, mcpSessionId } : linkedContext,
            workspace,
            permissions: this.policy.policy,
            tools,
        };
    }

    /**
     * The Penpot MCP session of this tab: the one the tab sent in `context.set`, else the session of
     * a tab showing the same file (the plugin may connect after the context was sent).
     */
    public mcpSessionId(): string | undefined {
        const context = this.context;
        if (!context) {
            return undefined;
        }
        return context.mcpSessionId ?? this.deps.pluginSessions?.sessionForFile(context.fileId);
    }

    /**
     * Waits briefly for the first context. A reconnecting tab sends `context.set` and its first
     * requests (e.g. `chat.history`) at about the same time, in no fixed order; a request that
     * arrives first would otherwise fail with `no-context` and, for the history, never be retried.
     */
    private waitForContext(): Promise<void> {
        if (this.context || this.closed.aborted) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this.contextWaiters = this.contextWaiters.filter((waiter) => waiter !== done);
                resolve();
            };
            const timer = setTimeout(done, AgentSession.CONTEXT_WAIT_MS);
            this.contextWaiters.push(done);
        });
    }

    private receive(data: RawData, isBinary: boolean): void {
        if (this.authenticating) {
            // keeps the order of the messages sent right after `auth`
            void this.authenticating.then(() => this.receive(data, isBinary));
            return;
        }
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
        const request = () => this.dispatch(message);
        (this.deps.gate ? this.deps.gate.run(request) : request()).catch((error) =>
            this.sendError(error, "rid" in message ? message.rid : undefined)
        );
    }

    private authenticate(message: ClientMessage | undefined): void {
        if (message?.type !== "auth") {
            this.reject("The first message must be auth");
            return;
        }
        const gate = this.deps.gate;
        if (gate) {
            this.authenticating = gate
                .authenticate(message.token)
                .catch((error: unknown) => {
                    this.logger.warn("Authentication check failed: %s", String(error));
                    return false;
                })
                .then((ok) => {
                    this.authenticating = undefined;
                    if (ok) {
                        this.accept();
                    } else {
                        this.reject("Not logged in");
                    }
                });
            return;
        }
        if (!this.deps.verifyToken(message.token)) {
            this.reject("Invalid token");
            return;
        }
        this.accept();
    }

    private accept(): void {
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
            case "chat.edit":
                return this.deps.chat.edit(this, message);
            case "chat.delete":
                return this.deps.chat.delete(this, message);
            case "chat.revert":
                return this.deps.chat.revert(this, message);
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
            case "apps.list":
                return this.apps().list(this, message);
            case "apps.start":
                return this.apps().start(this, message);
            case "apps.stop":
                return this.apps().stop(this, message);
            case "apps.logs":
                return this.apps().logs(this, message);
            case "apps.phone.start":
                return this.apps().phoneStart(this, message);
            case "apps.phone.stop":
                return this.apps().phoneStop(this, message);
            case "folder.list":
                return this.links().list(this, message);
            case "project.link":
                return this.links().link(this, message);
            case "project.link.status":
                return this.links().status(this, message);
            case "fonts.files":
                return this.links().fonts(this, message);
            case "project.output.status":
                return this.outputs().status(this, message);
            case "project.output.preview":
                return this.outputs().preview(this, message);
            case "project.output.set":
                return this.outputs().set(this, message);
        }
    }

    private outputs(): OutputService {
        if (!this.deps.outputs) {
            throw new AgentError("not-implemented", "Output folders are not available in this daemon");
        }
        return this.deps.outputs;
    }

    private links(): LinkService {
        if (!this.deps.links) {
            throw new AgentError("not-implemented", "Linked folders are not available in this daemon");
        }
        return this.deps.links;
    }

    private apps(): AppsService {
        if (!this.deps.apps) {
            throw new AgentError("not-implemented", "Built apps are not available in this daemon");
        }
        return this.deps.apps;
    }

    private async setContext(message: ContextSetMessage): Promise<void> {
        const { type: _type, ...sent } = message;
        const mapped = ProjectTypes.context(sent);
        const context = this.deps.gate ? await this.deps.gate.authorize(mapped) : mapped;
        this.context = context;
        const workspace = this.deps.workspaces.open(context);
        this.workspace = workspace;
        for (const waiter of [...this.contextWaiters]) {
            waiter();
        }
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
            this.send({
                type: "error",
                rid,
                code: error.code,
                message: error.message,
                ...(error.reason !== undefined ? { reason: error.reason } : {}),
                ...(error.params !== undefined ? { params: error.params } : {}),
            });
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
        for (const waiter of [...this.contextWaiters]) {
            waiter();
        }
    }
}

/** Tool policy of a session: the local policy, narrowed by the hosting gate when there is one. */
class ToolPermissionPolicyFor {
    public static session(
        gate: SessionGate | undefined,
        workspace: ProjectWorkspace,
        policy: ToolPermissionPolicy
    ): ToolPermissionHandler {
        return gate ? gate.permissions(policy, workspace) : policy;
    }
}
