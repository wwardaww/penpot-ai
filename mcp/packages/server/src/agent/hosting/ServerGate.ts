import type { IncomingHttpHeaders, IncomingMessage } from "http";
import type { AgentContext } from "@penpot/mcp-common";
import { AgentError } from "../AgentClient";
import type { ToolPermissionHandler } from "../runner/ClaudeRunner";
import type { SessionGate, SessionGateFactory } from "../SessionGate";
import type { McpToolsClient } from "../tools/McpToolsClient";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { PenpotCredentials, type PenpotIdentity } from "./PenpotIdentity";
import { ServerToolPolicy } from "./ServerToolPolicy";
import { type PenpotUser, UserScope } from "./UserScope";

/** Services a server gate needs. */
export interface ServerGateServices {
    identity: PenpotIdentity;
    /** name of the Penpot session cookie */
    cookieName: string;
    /** MCP client of a user (with the user's bridge token) */
    toolsFor(user: PenpotUser): McpToolsClient | null;
}

/**
 * Access control of one server-mode connection.
 *
 * The user is the Penpot user of the upgrade request's session cookie (or of an access token);
 * a context is accepted only for a project the Penpot backend lets that user read, and its team
 * id is replaced with the backend's. Requests run in the user's {@link UserScope}.
 */
export class ServerGate implements SessionGate {
    private credentials: PenpotCredentials | null = null;
    private user?: PenpotUser;
    private teamId?: string;

    /**
     * @param services - identity checks and per-user tools
     * @param headers - headers of the upgrade request
     */
    constructor(
        private readonly services: ServerGateServices,
        private readonly headers: IncomingHttpHeaders
    ) {}

    /** The authenticated user, if any. */
    public get currentUser(): PenpotUser | undefined {
        return this.user;
    }

    public async authenticate(token: string): Promise<boolean> {
        this.credentials = PenpotCredentials.from(this.headers, this.services.cookieName, token);
        if (!this.credentials) {
            return false;
        }
        const user = await this.services.identity.user(this.credentials);
        this.user = user ?? undefined;
        return user !== null;
    }

    public async authorize(context: AgentContext): Promise<AgentContext> {
        if (!this.credentials || !this.user) {
            throw new AgentError("not-authenticated", "Log in to Penpot first");
        }
        const teamId = await this.services.identity.projectTeam(this.credentials, this.user, context.projectId);
        if (!teamId) {
            throw new AgentError("forbidden", "You do not have access to this project");
        }
        this.teamId = teamId;
        return { ...context, teamId };
    }

    public run<T>(fn: () => T): T {
        return this.user ? UserScope.run({ user: this.user, teamId: this.teamId }, fn) : fn();
    }

    public permissions(policy: ToolPermissionHandler, workspace: ProjectWorkspace): ToolPermissionHandler {
        return new ServerToolPolicy(policy, workspace.guard);
    }

    public tools(_base: McpToolsClient | null): McpToolsClient | null {
        return this.user ? this.services.toolsFor(this.user) : null;
    }
}

/** Opens a {@link ServerGate} per connection. */
export class ServerGateFactory implements SessionGateFactory {
    constructor(private readonly services: ServerGateServices) {}

    public open(request: IncomingMessage): SessionGate {
        return new ServerGate(this.services, request.headers);
    }
}
