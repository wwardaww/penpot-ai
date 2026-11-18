import type { IncomingMessage } from "http";
import { join } from "path";
import { createLogger } from "../../logger";
import type { PluginConnectionAuthenticator } from "../../PluginBridge";
import { AgentConfig } from "../AgentConfig";
import type { AgentServerHosting } from "../AgentServer";
import type { ApiKeyTurns } from "../runner/ApiKeyRunner";
import { McpToolsClient } from "../tools/McpToolsClient";
import { AdminRoutes } from "./AdminRoutes";
import { ApiKeyProxy } from "./ApiKeyProxy";
import { CodeExecutionGate } from "./CodeExecutionGate";
import { HostingConfig } from "./HostingConfig";
import { PenpotCredentials, PenpotIdentity } from "./PenpotIdentity";
import { SecretBox } from "./SecretBox";
import { ServerGateFactory } from "./ServerGate";
import { ServerStore } from "./ServerStore";
import { ServerTurns } from "./ServerTurns";
import { TeamWorkspaces } from "./TeamWorkspaces";
import { TurnLimiter } from "./TurnLimiter";
import { UsageLedger } from "./UsageLedger";
import type { PenpotUser } from "./UserScope";

/** Replaceable parts of server mode (tests use fake HTTP clients). */
export interface ServerHostingParts {
    /** HTTP client towards the Penpot backend */
    backendFetch?: typeof fetch;
    /** HTTP client towards the Anthropic API */
    anthropicFetch?: typeof fetch;
}

/**
 * Server mode of the daemon (`PENFORGE_MODE=server`, W24): composes the Penpot identity checks,
 * per-team workspaces, encrypted settings, limits, usage ledger, credential proxy, admin page
 * and the plugin bridge authentication.
 */
export class ServerHosting {
    private readonly logger = createLogger("ServerHosting");
    public readonly box: SecretBox;
    public readonly store: ServerStore;
    public readonly identity: PenpotIdentity;
    public readonly ledger: UsageLedger;
    public readonly limiter: TurnLimiter;
    public readonly proxy: ApiKeyProxy;
    public readonly workspaces: TeamWorkspaces;
    private readonly toolClients = new Map<string, McpToolsClient>();

    /**
     * @param config - server-mode settings
     * @param agent - the daemon configuration
     * @param parts - replacements for tests
     */
    constructor(
        public readonly config: HostingConfig,
        private readonly agent: AgentConfig,
        parts: ServerHostingParts = {}
    ) {
        this.box = new SecretBox(config.secretKey);
        this.store = new ServerStore(
            this.box,
            join(config.serverDir, "settings.json"),
            join(config.serverDir, "secrets.enc.json")
        );
        this.identity = new PenpotIdentity(config.backendUri, parts.backendFetch);
        this.ledger = new UsageLedger(join(config.serverDir, "usage"));
        this.limiter = new TurnLimiter(async () => (await this.store.settings()).limits, this.ledger);
        this.proxy = new ApiKeyProxy(config.values.anthropicUrl, this.ledger, parts.anthropicFetch);
        this.workspaces = new TeamWorkspaces(config.teamsDir);
    }

    /**
     * Builds server mode from the environment when `PENFORGE_MODE=server`.
     *
     * @param env - the environment
     * @param agent - the daemon configuration
     * @returns server mode, or null in local mode
     */
    public static fromEnv(env: Record<string, string | undefined>, agent: AgentConfig): ServerHosting | null {
        return agent.mode === "server" ? new ServerHosting(HostingConfig.load(env, agent.home), agent) : null;
    }

    /**
     * Plugin bridge token of a profile: the multi-user token keying its plugin connections and
     * presented by its Claude turns to the MCP endpoint.
     *
     * @param profileId - the Penpot profile id
     */
    public bridgeToken(profileId: string): string {
        return this.box.digest("mcp-bridge", profileId);
    }

    /** Turns of the API key runner. */
    public turns(): ApiKeyTurns {
        return new ServerTurns(this.store, this.limiter, this.proxy, join(this.agent.home, "claude-config"), (id) =>
            this.bridgeToken(id)
        );
    }

    /** Additions to the agent endpoint: Penpot session gates and the admin page. */
    public endpoint(): AgentServerHosting {
        const admin = new AdminRoutes(this.config, this.identity, this.store, this.ledger);
        return {
            gates: new ServerGateFactory({
                identity: this.identity,
                cookieName: this.config.values.cookieName,
                toolsFor: (user) => this.toolsFor(user),
            }),
            routes: (app) => admin.install(app),
        };
    }

    /**
     * Authenticator of the plugin bridge: the upgrade must come from an allowed origin with a
     * Penpot session; the connection is keyed with the user's bridge token.
     */
    public bridgeAuthenticator(): PluginConnectionAuthenticator {
        const origins = new Set(this.agent.allowedOrigins);
        return {
            userTokenFor: async (request: IncomingMessage) => {
                const origin = request.headers.origin;
                if (origin === undefined || !origins.has(AgentConfig.normalizeOrigin(origin))) {
                    return null;
                }
                const credentials = PenpotCredentials.from(request.headers, this.config.values.cookieName);
                const user = credentials ? await this.identity.user(credentials) : null;
                return user ? this.bridgeToken(user.profileId) : null;
            },
        };
    }

    /** Starts the credential proxy and closes local code execution. */
    public async start(): Promise<void> {
        await this.proxy.start();
        if (!this.config.values.sandboxUrl) {
            CodeExecutionGate.close(
                "Building and previewing apps needs the Penforge sandbox, which this server does not have yet."
            );
        } else {
            // TODO(W24 follow-up): route dev servers and builds to the sandbox controller
            CodeExecutionGate.close("The Penforge sandbox is configured but not supported by this version yet.");
        }
        const status = await this.store.apiKeyStatus();
        this.logger.info(
            "Server mode: teams in %s; API key %s; admins: %d",
            this.config.teamsDir,
            status.configured ? "configured" : "NOT configured (open /penforge/admin/)",
            this.config.values.adminEmails.length
        );
    }

    /** Stops the proxy and the per-user MCP clients. */
    public async stop(): Promise<void> {
        await this.proxy.stop();
        CodeExecutionGate.open();
        const clients = [...this.toolClients.values()];
        this.toolClients.clear();
        await Promise.all(clients.map((client) => client.close()));
    }

    private toolsFor(user: PenpotUser): McpToolsClient {
        let client = this.toolClients.get(user.profileId);
        if (!client) {
            client = new McpToolsClient(this.agent.mcpUrl, {
                Authorization: `Bearer ${this.bridgeToken(user.profileId)}`,
            });
            this.toolClients.set(user.profileId, client);
        }
        return client;
    }
}
