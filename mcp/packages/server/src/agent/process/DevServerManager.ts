import { createLogger } from "../../logger";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import {
    DevServer,
    type DevServerObserver,
    type DevServerOptions,
    type LogLine,
    type PreviewStatus,
} from "./DevServer";
import { PortPool } from "./PortPool";
import { StackConfig } from "./StackConfig";

/** Tunables of the manager; every field has a default. */
export interface DevServerManagerOptions extends Partial<DevServerOptions> {
    /** port pool; defaults to `PENFORGE_PREVIEW_PORTS` or 5200-5299 */
    ports?: PortPool;
    /** time a server keeps running once nobody watches it (survives page reloads) */
    idleStopMs?: number;
}

/**
 * Subscription of an observer to one project's dev server; {@link dispose} ends it.
 */
export class PreviewWatch {
    private disposed = false;

    constructor(
        public readonly projectId: string,
        private readonly onDispose: () => void
    ) {}

    /** Ends the subscription (idempotent). */
    public dispose(): void {
        if (!this.disposed) {
            this.disposed = true;
            this.onDispose();
        }
    }
}

/**
 * Manager of the dev servers of all projects: at most one per project, each on its own port.
 *
 * Starts servers on demand, fans their status and output out to the project's watchers, stops a
 * server some time after its last watcher left (project closed in every tab), and kills every
 * process tree when the daemon stops or the node process exits.
 */
export class DevServerManager {
    private static readonly DEFAULTS: DevServerOptions = {
        maxRestarts: 3,
        probeIntervalMs: 500,
        restartDelayMs: 1000,
    };
    private static readonly DEFAULT_IDLE_STOP_MS = 120_000;

    private readonly logger = createLogger("DevServerManager");
    private readonly ports: PortPool;
    private readonly idleStopMs: number;
    private readonly serverOptions: DevServerOptions;
    private readonly servers = new Map<string, DevServer>();
    private readonly pending = new Map<string, Promise<DevServer>>();
    private readonly watchers = new Map<string, Set<DevServerObserver>>();
    private readonly idleTimers = new Map<string, NodeJS.Timeout>();
    private readonly exitHook = () => this.killAllSync();
    private exitHookInstalled = false;

    /**
     * @param options - tunables
     */
    constructor(options: DevServerManagerOptions = {}) {
        this.ports = options.ports ?? PortPool.fromRange(process.env.PENFORGE_PREVIEW_PORTS);
        this.idleStopMs = options.idleStopMs ?? DevServerManager.DEFAULT_IDLE_STOP_MS;
        this.serverOptions = {
            maxRestarts: options.maxRestarts ?? DevServerManager.DEFAULTS.maxRestarts,
            probeIntervalMs: options.probeIntervalMs ?? DevServerManager.DEFAULTS.probeIntervalMs,
            restartDelayMs: options.restartDelayMs ?? DevServerManager.DEFAULTS.restartDelayMs,
        };
    }

    /**
     * Starts the dev server of a project, or reuses the running one.
     *
     * @param workspace - the project workspace
     * @returns the server's current status
     * @throws AgentError `not-configured` when the project has no generated app
     */
    public async start(workspace: ProjectWorkspace): Promise<PreviewStatus> {
        const projectId = workspace.projectId;
        const running = this.servers.get(projectId);
        if (running?.isLive) {
            this.scheduleIdleStop(projectId);
            return running.currentStatus;
        }
        let pending = this.pending.get(projectId);
        if (!pending) {
            pending = this.launch(workspace).finally(() => this.pending.delete(projectId));
            this.pending.set(projectId, pending);
        }
        return (await pending).currentStatus;
    }

    /**
     * Stops the dev server of a project.
     *
     * @param projectId - the project
     * @param message - why, for the client
     * @returns whether a server was running
     */
    public async stop(projectId: string, message?: string): Promise<boolean> {
        await this.pending.get(projectId)?.catch(() => undefined);
        const server = this.servers.get(projectId);
        if (!server) {
            return false;
        }
        await server.stop(message);
        return true;
    }

    /**
     * Stops every dev server.
     */
    public async stopAll(): Promise<void> {
        await Promise.all([...this.pending.values()].map((pending) => pending.catch(() => undefined)));
        await Promise.all([...this.servers.keys()].map((projectId) => this.stop(projectId, "Penforge stopped")));
    }

    /**
     * Gets the status of a project's dev server.
     *
     * @param projectId - the project
     */
    public status(projectId: string): PreviewStatus | undefined {
        return this.servers.get(projectId)?.currentStatus;
    }

    /**
     * Gets the buffered output of a project's dev server.
     *
     * @param projectId - the project
     */
    public logs(projectId: string): LogLine[] {
        return this.servers.get(projectId)?.recentLogs ?? [];
    }

    /** Projects with a starting or ready dev server. */
    public get liveProjects(): string[] {
        return [...this.servers.values()].filter((server) => server.isLive).map((server) => server.projectId);
    }

    /**
     * Subscribes an observer to a project's dev server (also to servers started later).
     *
     * @param projectId - the project
     * @param observer - receives status changes and output
     */
    public watch(projectId: string, observer: DevServerObserver): PreviewWatch {
        let set = this.watchers.get(projectId);
        if (!set) {
            set = new Set();
            this.watchers.set(projectId, set);
        }
        set.add(observer);
        this.cancelIdleStop(projectId);
        return new PreviewWatch(projectId, () => {
            set.delete(observer);
            if (set.size === 0) {
                this.watchers.delete(projectId);
            }
            this.scheduleIdleStop(projectId);
        });
    }

    private async launch(workspace: ProjectWorkspace): Promise<DevServer> {
        const projectId = workspace.projectId;
        const stack = await StackConfig.load(workspace);
        const port = await this.ports.acquire();
        const server = new DevServer(
            projectId,
            stack,
            port,
            {
                onStatus: (status) => this.statusChanged(server, status),
                onLog: (line) => this.forEachWatcher(projectId, (watcher) => watcher.onLog(line)),
            },
            this.serverOptions
        );
        this.servers.set(projectId, server);
        this.installExitHook();
        server.start();
        this.scheduleIdleStop(projectId);
        return server;
    }

    private statusChanged(server: DevServer, status: PreviewStatus): void {
        const projectId = server.projectId;
        if (status.state === "stopped" || status.state === "failed") {
            if (this.servers.get(projectId) === server) {
                this.servers.delete(projectId);
            }
            this.ports.release(server.port);
            this.cancelIdleStop(projectId);
            if (this.servers.size === 0) {
                this.removeExitHook();
            }
        }
        this.forEachWatcher(projectId, (watcher) => watcher.onStatus(status));
    }

    private forEachWatcher(projectId: string, call: (watcher: DevServerObserver) => void): void {
        for (const watcher of [...(this.watchers.get(projectId) ?? [])]) {
            try {
                call(watcher);
            } catch (error) {
                this.logger.warn("Preview watcher failed: %s", error instanceof Error ? error.message : error);
            }
        }
    }

    private scheduleIdleStop(projectId: string): void {
        if ((this.watchers.get(projectId)?.size ?? 0) > 0 || !this.servers.has(projectId)) {
            return;
        }
        this.cancelIdleStop(projectId);
        const timer = setTimeout(() => {
            this.idleTimers.delete(projectId);
            if ((this.watchers.get(projectId)?.size ?? 0) === 0) {
                this.logger.info("Stopping the unwatched dev server of project %s", projectId);
                void this.stop(projectId, "The project was closed");
            }
        }, this.idleStopMs);
        timer.unref();
        this.idleTimers.set(projectId, timer);
    }

    private cancelIdleStop(projectId: string): void {
        const timer = this.idleTimers.get(projectId);
        if (timer) {
            clearTimeout(timer);
            this.idleTimers.delete(projectId);
        }
    }

    private killAllSync(): void {
        for (const server of this.servers.values()) {
            server.killSync();
        }
    }

    private installExitHook(): void {
        if (!this.exitHookInstalled) {
            process.once("exit", this.exitHook);
            this.exitHookInstalled = true;
        }
    }

    private removeExitHook(): void {
        if (this.exitHookInstalled) {
            process.off("exit", this.exitHook);
            this.exitHookInstalled = false;
        }
    }
}
