import { join } from "path";
import { createLogger } from "../logger";
import { AgentConfig, PENFORGE_DAEMON_VERSION } from "./AgentConfig";
import { AgentServer, PairingToken } from "./AgentServer";
import { AppsService } from "./apps/AppsService";
import { ChatService } from "./chat/ChatService";
import { TurnRunner } from "./chat/TurnRunner";
import { DevServerManager } from "./process/DevServerManager";
import { PreviewService } from "./process/PreviewService";
import type { ServerHosting } from "./hosting/ServerHosting";
import { DownloadRegistry } from "./publish/DownloadRegistry";
import { PublishServices } from "./publish/PublishServices";
import { SecretStore } from "./publish/SecretStore";
import { ChromeScreenshotterFactory } from "./qa/ChromeScreenshotter";
import { DevServerPreviewAccess } from "./qa/PreviewAccess";
import { VisualQaHost, type VisualQaServices } from "./qa/QaRun";
import { PromptRegistry } from "./prompts/promptRegistry";
import type { ClaudeRunner } from "./runner/ClaudeRunner";
import { createRunner } from "./runner/createRunner";
import { McpToolsClient } from "./tools/McpToolsClient";
import type { PluginSessionDirectory } from "./tools/PluginSessions";
import { WorkflowEngine } from "./workflows/WorkflowEngine";
import { WorkflowRegistry } from "./workflows/WorkflowRegistry";
import { WorkspaceManager } from "./workspace/WorkspaceManager";

/** Replaceable parts of the daemon (tests use a fake runner and no MCP endpoint). */
export interface PenforgeDaemonParts {
    runner?: ClaudeRunner;
    registry?: WorkflowRegistry;
    prompts?: PromptRegistry;
    /** null disables direct MCP tool calls */
    tools?: McpToolsClient | null;
    /** dev server manager of the previews */
    devServers?: DevServerManager;
    /** services of the `publish` workflow (W20); built from the config when unset */
    publish?: (downloads: DownloadRegistry, downloadUrl: (id: string) => string) => PublishServices;
    /** MCP plugin sessions of this process, to route tabs that did not send their session */
    pluginSessions?: PluginSessionDirectory;
    authTimeoutMs?: number;
    /** server mode (W24); local mode when unset */
    hosting?: ServerHosting | null;
}

/**
 * Penforge agent daemon: the agent endpoint and its services, next to the Penpot MCP server.
 *
 * Wires the Claude runner, project workspaces, prompts, chat and workflows behind the `/agent`
 * WebSocket endpoint.
 */
export class PenforgeDaemon {
    private readonly logger = createLogger("PenforgeDaemon");
    public readonly token: PairingToken;
    public readonly runner: ClaudeRunner;
    public readonly registry: WorkflowRegistry;
    private readonly chat: ChatService;
    private readonly workflows: WorkflowEngine;
    private readonly tools: McpToolsClient | null;
    private readonly previews: PreviewService;
    private readonly visualQa: VisualQaServices;
    private readonly server: AgentServer;
    private readonly publish: PublishServices;
    private readonly hosting: ServerHosting | null;
    private readonly apps: AppsService;

    /**
     * @param config - the daemon configuration
     * @param parts - replacements for default parts
     */
    constructor(
        public readonly config: AgentConfig,
        parts: PenforgeDaemonParts = {}
    ) {
        this.token = new PairingToken(config.fixedToken);
        this.hosting = parts.hosting ?? null;
        this.runner = parts.runner ?? createRunner(config, this.hosting?.turns());
        this.registry = parts.registry ?? WorkflowRegistry.withShippedWorkflows();
        this.tools = parts.tools === undefined ? new McpToolsClient(config.mcpUrl) : parts.tools;
        const turns = new TurnRunner(this.runner, parts.prompts ?? PromptRegistry.locate());
        this.chat = new ChatService(turns);
        this.workflows = new WorkflowEngine(this.registry, turns);
        const devServers = parts.devServers ?? new DevServerManager();
        const workspaces = this.hosting?.workspaces ?? new WorkspaceManager(config.projectsDir);
        this.previews = new PreviewService(devServers);
        const downloads = new DownloadRegistry();
        // W33: built apps on the dashboard; local mode only (server mode runs apps in the sandbox)
        this.apps = new AppsService(
            devServers,
            workspaces,
            config.projectsDir,
            { get: () => PublishServices.get().phone },
            this.hosting ? "Built apps open from the desktop or local daemon only" : null
        );
        // W18: the visual QA (workflow and chat tool) uses the same dev servers as the preview
        this.visualQa = {
            previews: new DevServerPreviewAccess(devServers, workspaces),
            browsers: new ChromeScreenshotterFactory(),
            clientForMcpSession: async (mcpSessionId) => {
                const client = this.server.clientForMcpSession(mcpSessionId);
                return client ? client.setup() : null;
            },
        };
        this.server = new AgentServer(
            config,
            this.token,
            {
                daemonVersion: PENFORGE_DAEMON_VERSION,
                chat: this.chat,
                workflows: this.workflows,
                previews: this.previews,
                workspaces,
                tools: this.tools,
                pluginSessions: parts.pluginSessions,
                authTimeoutMs: parts.authTimeoutMs ?? 10_000,
                apps: this.apps,
            },
            () => ({
                service: "penforge-agent",
                daemonVersion: PENFORGE_DAEMON_VERSION,
                mode: this.hosting ? "server" : "local",
                runner: this.runner.kind,
                workflows: this.registry.names(),
            }),
            downloads,
            this.hosting?.endpoint()
        );
        const downloadUrl = (id: string) => `${this.server.baseUrl}/download/${id}`;
        this.publish =
            parts.publish?.(downloads, downloadUrl) ??
            new PublishServices(new SecretStore(join(config.home, "secrets.json")), downloads, downloadUrl, devServers);
        PublishServices.install(this.publish);
    }

    /** Pairing URL to open in the browser. */
    public get pairUrl(): string {
        return this.server.pairUrl;
    }

    /** Port of the agent endpoint. */
    public get port(): number {
        return this.server.port;
    }

    /**
     * Starts the agent endpoint and prints the pairing URL.
     */
    public async start(): Promise<void> {
        await this.hosting?.start();
        await this.server.start();
        VisualQaHost.install(this.visualQa);
        this.logger.info("Penforge home: %s; runner: %s", this.config.home, this.runner.kind);
        if (this.hosting) {
            this.logger.info("Server mode: users sign in through Penpot at %s", this.config.publicUri);
        } else if (this.config.requirePairing) {
            this.token.announce(this.config.publicUri);
            this.logger.info("Pairing URL printed on the console: %s", this.token.maskedPairUrl(this.config.publicUri));
        } else {
            this.logger.info("Ready: open %s, the AI tab connects by itself", this.config.publicUri);
        }
    }

    /**
     * Stops all runs, Claude processes and dev servers, then the endpoint.
     */
    public async stop(): Promise<void> {
        this.workflows.cancelAll();
        this.chat.cancelAll();
        this.runner.cancel();
        // closes the QA browsers and releases their dev servers before those stop
        await VisualQaHost.shutdown(this.visualQa);
        await this.previews.stopAll();
        this.apps.dispose();
        await this.server.stop();
        PublishServices.uninstall(this.publish);
        await this.tools?.close();
        await this.hosting?.stop();
    }
}

export { AgentConfig };
