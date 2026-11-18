import type { PreviewReason } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import {
    DevServer,
    type DevServerExposure,
    type DevServerObserver,
    type DevServerOptions,
    type LogLine,
    type PreviewStatus,
} from "./DevServer";
import { CommandPolicy } from "./CommandPolicy";
import { PortPool } from "./PortPool";
import { StackConfig } from "./StackConfig";

/** Tunables of the manager; every field has a default. */
export interface DevServerManagerOptions extends Partial<DevServerOptions> {
    /** port pool; defaults to `PENFORGE_PREVIEW_PORTS` or 5200-5299 */
    ports?: PortPool;
    /** time a server keeps running once nobody watches it (survives page reloads) */
    idleStopMs?: number;
    /** rules for the dev command; package managers only by default */
    commandPolicy?: CommandPolicy;
}

/** Options of {@link DevServerManager.start}. */
export interface DevServerStartOptions {
    /**
     * who may reach the server; when it differs from the running server's, the server restarts
     * with it. Unset: the running server's, or loopback only for a new one
     */
    exposure?: DevServerExposure;
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
    private static readonly DEFAULTS: Omit<DevServerOptions, "baseEnv"> = {
        maxRestarts: 3,
        probeIntervalMs: 500,
        restartDelayMs: 1000,
        healthyMs: 60_000,
    };
    private static readonly DEFAULT_IDLE_STOP_MS = 120_000;

    private readonly logger = createLogger("DevServerManager");
    private readonly ports: PortPool;
    private readonly idleStopMs: number;
    private readonly serverOptions: DevServerOptions;
    private readonly policy: CommandPolicy;
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
            healthyMs: options.healthyMs ?? DevServerManager.DEFAULTS.healthyMs,
            baseEnv: options.baseEnv ?? process.env,
            exposureCheck: options.exposureCheck,
            exposureRecheckMs: options.exposureRecheckMs,
        };
        this.policy = options.commandPolicy ?? new CommandPolicy();
    }

    /**
     * Starts the dev server of a project, or reuses the running one.
     *
     * @param workspace - the project workspace
     * @param options - who may reach the server (see {@link DevServerStartOptions})
     * @returns the server's current status
     * @throws AgentError `not-configured` when the project has no generated app
     */
    public async start(workspace: ProjectWorkspace, options: DevServerStartOptions = {}): Promise<PreviewStatus> {
        const projectId = workspace.projectId;
        const wanted = options.exposure;
        await this.pending.get(projectId)?.catch(() => undefined);
        const running = this.servers.get(projectId);
        if (running?.isLive) {
            if (wanted === undefined || DevServerManager.sameExposure(running.exposure, wanted)) {
                this.scheduleIdleStop(projectId);
                return running.currentStatus;
            }
            this.logger.info("Restarting the dev server of project %s for %s access", projectId, wanted.mode);
            await running.stop("restarting");
        }
        let pending = this.pending.get(projectId);
        if (!pending) {
            pending = this.launch(workspace, wanted ?? { mode: "loopback" }).finally(() =>
                this.pending.delete(projectId)
            );
            this.pending.set(projectId, pending);
        }
        return (await pending).currentStatus;
    }

    /**
     * Gets who may reach a project's running dev server.
     *
     * @param projectId - the project
     * @returns the exposure, or undefined when no server is starting or ready
     */
    public exposureOf(projectId: string): DevServerExposure | undefined {
        const server = this.servers.get(projectId);
        return server?.isLive ? server.exposure : undefined;
    }

    /**
     * Stops the dev server of a project.
     *
     * @param projectId - the project
     * @param reason - why, for the client
     * @returns whether a server was running
     */
    public async stop(projectId: string, reason: PreviewReason = "stopped"): Promise<boolean> {
        await this.pending.get(projectId)?.catch(() => undefined);
        const server = this.servers.get(projectId);
        if (!server) {
            return false;
        }
        await server.stop(reason);
        return true;
    }

    /**
     * Stops every dev server.
     */
    public async stopAll(): Promise<void> {
        await Promise.all([...this.pending.values()].map((pending) => pending.catch(() => undefined)));
        await Promise.all([...this.servers.keys()].map((projectId) => this.stop(projectId, "daemon-stopped")));
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

    private async launch(workspace: ProjectWorkspace, exposure: DevServerExposure): Promise<DevServer> {
        const projectId = workspace.projectId;
        const stack = await StackConfig.load(workspace, this.policy);
        const port = await this.ports.acquire();
        const server = new DevServer(
            projectId,
            stack,
            port,
            this.ports,
            {
                onStatus: (status) => this.statusChanged(server, status),
                onLog: (line) => this.forEachWatcher(projectId, (watcher) => watcher.onLog(line)),
            },
            this.serverOptions,
            exposure
        );
        this.servers.set(projectId, server);
        this.installExitHook();
        server.start();
        this.scheduleIdleStop(projectId);
        return server;
    }

    private static sameExposure(a: DevServerExposure, b: DevServerExposure): boolean {
        return a.mode === b.mode && (a.mode !== "lan" || (b.mode === "lan" && a.host === b.host));
    }

    private statusChanged(server: DevServer, status: PreviewStatus): void {
        const projectId = server.projectId;
        if (status.state === "stopped" || status.state === "failed") {
            if (this.servers.get(projectId) === server) {
                this.servers.delete(projectId);
            }
            for (const port of [server.port, ...server.claimedPorts]) {
                this.ports.release(port);
            }
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
                void this.stop(projectId, "project-closed");
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
