import { createLogger } from "../logger";
import { AgentConfig, PENFORGE_DAEMON_VERSION } from "./AgentConfig";
import { AgentServer, PairingToken } from "./AgentServer";
import { ChatService } from "./chat/ChatService";
import { TurnRunner } from "./chat/TurnRunner";
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
    private readonly server: AgentServer;

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
        this.server = new AgentServer(
            config,
            this.token,
            {
                daemonVersion: PENFORGE_DAEMON_VERSION,
                chat: this.chat,
                workflows: this.workflows,
                workspaces: new WorkspaceManager(config.projectsDir),
                tools: this.tools,
                authTimeoutMs: parts.authTimeoutMs ?? 10_000,
            },
            () => ({
                service: "penforge-agent",
                daemonVersion: PENFORGE_DAEMON_VERSION,
                runner: this.runner.kind,
                workflows: this.registry.names(),
            })
        );
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
        this.logger.info("Pair Penforge with your browser: %s", this.pairUrl);
    }

    /**
     * Stops all runs and Claude processes, then the endpoint.
     */
    public async stop(): Promise<void> {
        this.workflows.cancelAll();
        this.chat.cancelAll();
        this.runner.cancel();
        await this.server.stop();
        await this.tools?.close();
    }
}

export { AgentConfig };
