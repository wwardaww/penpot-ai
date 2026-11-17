import type { AgentContext, PreviewStartMessage, PreviewStopMessage } from "@penpot/mcp-common";
import { AgentError, type AgentClient } from "../AgentClient";
import type { DevServerObserver, LogLine, PreviewStatus } from "./DevServer";
import type { DevServerManager, PreviewWatch } from "./DevServerManager";

/**
 * Forwards one project's dev server status and output to one client.
 *
 * Status goes to every client as `preview.status`, plus `preview.ready` / `preview.stopped` on
 * those transitions; output lines (`preview.log`) only to the developer persona.
 */
class ClientPreviewObserver implements DevServerObserver {
    constructor(
        private readonly client: AgentClient,
        private readonly projectId: string,
        private readonly persona: AgentContext["persona"]
    ) {}

    public onStatus(status: PreviewStatus): void {
        const { projectId } = this;
        this.client.send({
            type: "preview.status",
            projectId,
            state: status.state,
            url: status.url,
            reason: status.reason,
            message: status.message,
            restarts: status.restarts,
        });
        if (status.state === "ready" && status.url) {
            this.client.send({ type: "preview.ready", projectId, url: status.url });
        } else if (status.state === "stopped" || status.state === "failed") {
            this.client.send({ type: "preview.stopped", projectId, url: status.url ?? "" });
        }
    }

    public onLog(line: LogLine): void {
        if (this.persona === "developer") {
            this.client.send({ type: "preview.log", projectId: this.projectId, stream: line.stream, text: line.text });
        }
    }
}

/**
 * Handler of the `preview.start` / `preview.stop` messages.
 *
 * A client may only preview the project of its `context.set`. `preview.start` subscribes the
 * client to that project's dev server (one project per client; the subscription ends when the
 * client disconnects) and starts the server, or replays the status of the running one.
 */
export class PreviewService {
    /** current subscription of each client, by client id */
    private readonly watches = new Map<string, PreviewWatch>();

    /**
     * @param manager - the dev server manager
     */
    constructor(private readonly manager: DevServerManager) {}

    /**
     * Handles `preview.start`; resolves once the server process is launched (not when it is ready).
     */
    public async start(client: AgentClient, message: PreviewStartMessage): Promise<void> {
        const { context, workspace } = await client.setup();
        PreviewService.checkProject(context, message.projectId);
        // subscribe first: a server launched below reports `starting` to every watcher
        const observer = this.subscribe(client, context);
        const status = this.manager.status(context.projectId);
        if (status) {
            // replay for a client joining a server that is already there
            for (const line of this.manager.logs(context.projectId)) {
                observer.onLog(line);
            }
            observer.onStatus(status);
        }
        await this.manager.start(workspace);
    }

    /**
     * Handles `preview.stop`.
     */
    public async stop(client: AgentClient, message: PreviewStopMessage): Promise<void> {
        const { context } = await client.setup();
        PreviewService.checkProject(context, message.projectId);
        const wasRunning = await this.manager.stop(context.projectId, "stopped");
        if (!wasRunning) {
            client.send({ type: "preview.status", projectId: context.projectId, state: "stopped", restarts: 0 });
        }
    }

    /**
     * Stops every dev server (daemon shutdown).
     */
    public async stopAll(): Promise<void> {
        await this.manager.stopAll();
    }

    private subscribe(client: AgentClient, context: AgentContext): ClientPreviewObserver {
        const previous = this.watches.get(client.id);
        if (previous) {
            previous.dispose();
        } else {
            // one listener per client, however often it starts the preview
            client.closed.addEventListener(
                "abort",
                () => {
                    this.watches.get(client.id)?.dispose();
                    this.watches.delete(client.id);
                },
                { once: true }
            );
        }
        const observer = new ClientPreviewObserver(client, context.projectId, context.persona);
        this.watches.set(client.id, this.manager.watch(context.projectId, observer));
        return observer;
    }

    /** Number of clients with a preview subscription (for tests). */
    public get subscriberCount(): number {
        return this.watches.size;
    }

    private static checkProject(context: AgentContext, projectId: string): void {
        if (context.projectId !== projectId) {
            throw new AgentError("bad-request", "The preview must be of the open project");
        }
    }
}
