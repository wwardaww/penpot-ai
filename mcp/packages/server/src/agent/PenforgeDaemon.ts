import { join } from "path";
import { createLogger } from "../logger";
import { AgentConfig, PENFORGE_DAEMON_VERSION } from "./AgentConfig";
import { AgentServer, PairingToken } from "./AgentServer";
import { ChatService } from "./chat/ChatService";
import { TurnRunner } from "./chat/TurnRunner";
import { DevServerManager } from "./process/DevServerManager";
import { PreviewService } from "./process/PreviewService";
import { DownloadRegistry } from "./publish/DownloadRegistry";
import { PublishServices } from "./publish/PublishServices";
import { SecretStore } from "./publish/SecretStore";
import { PromptRegistry } from "./prompts/promptRegistry";
import type { ClaudeRunner } from "./runner/ClaudeRunner";
import { createRunner } from "./runner/createRunner";
import { McpToolsClient } from "./tools/McpToolsClient";
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
    authTimeoutMs?: number;
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
    private readonly server: AgentServer;
    private readonly publish: PublishServices;

    /**
     * @param config - the daemon configuration
     * @param parts - replacements for default parts
     */
    constructor(
        public readonly config: AgentConfig,
        parts: PenforgeDaemonParts = {}
    ) {
        this.token = new PairingToken(config.fixedToken);
        this.runner = parts.runner ?? createRunner(config);
        this.registry = parts.registry ?? WorkflowRegistry.withShippedWorkflows();
        this.tools = parts.tools === undefined ? new McpToolsClient(config.mcpUrl) : parts.tools;
        const turns = new TurnRunner(this.runner, parts.prompts ?? PromptRegistry.locate());
        this.chat = new ChatService(turns);
        this.workflows = new WorkflowEngine(this.registry, turns);
        const devServers = parts.devServers ?? new DevServerManager();
        this.previews = new PreviewService(devServers);
        const downloads = new DownloadRegistry();
        this.server = new AgentServer(
            config,
            this.token,
            {
                daemonVersion: PENFORGE_DAEMON_VERSION,
                chat: this.chat,
                workflows: this.workflows,
                previews: this.previews,
                workspaces: new WorkspaceManager(config.projectsDir),
                tools: this.tools,
                authTimeoutMs: parts.authTimeoutMs ?? 10_000,
            },
            () => ({
                service: "penforge-agent",
                daemonVersion: PENFORGE_DAEMON_VERSION,
                runner: this.runner.kind,
                workflows: this.registry.names(),
            }),
            downloads
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
        await this.server.start();
        this.logger.info("Penforge home: %s; runner: %s", this.config.home, this.runner.kind);
        if (this.config.requirePairing) {
            this.logger.info("Pair Penforge with your browser: %s", this.pairUrl);
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
        await this.previews.stopAll();
        await this.server.stop();
        PublishServices.uninstall(this.publish);
        await this.tools?.close();
    }
}

export { AgentConfig };
