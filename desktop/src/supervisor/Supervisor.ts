import { EventEmitter } from "node:events";
import { ManagedProcess, type ExitInfo } from "../process/ManagedProcess";
import type { ServiceContext, ServiceDefinition } from "../services/context";

export type ServiceState = "pending" | "starting" | "ready" | "restarting" | "failed" | "stopped";

export interface ServiceStatus {
    name: string;
    state: ServiceState;
    detail?: string;
    logFile?: string;
}

export interface RestartPolicy {
    /** Restarts allowed inside `windowMs` before the service is marked failed. */
    maxRestarts: number;
    windowMs: number;
    /** Delay before restart n (0-based) is `baseDelayMs * 2^n`. */
    baseDelayMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = { maxRestarts: 3, windowMs: 5 * 60_000, baseDelayMs: 1000 };

export interface SupervisorOptions {
    context: ServiceContext;
    /** In start order; stopped in reverse order. */
    services: ServiceDefinition[];
    restartPolicy?: RestartPolicy;
    /** Builds the process of a service (tests inject fakes). */
    createProcess?: (definition: ServiceDefinition, context: ServiceContext) => ManagedProcess;
}

interface Entry {
    definition: ServiceDefinition;
    status: ServiceStatus;
    process?: ManagedProcess;
    /** The process `stop()` ended, kept for the leftover check. */
    lastProcess?: ManagedProcess;
    restarts: number[];
}

/**
 * Starts the services one after the other (each must be ready before the next starts),
 * restarts a service that crashes (with backoff, a few times), and stops everything in reverse
 * order with process-tree kills.
 *
 * Events: `status` (ServiceStatus[]) on every change, `failed` (ServiceStatus) when a service
 * gives up after its restarts.
 */
export class Supervisor extends EventEmitter {
    private readonly entries: Entry[];
    private stopping = false;
    private readonly policy: RestartPolicy;
    private readonly createProcess: (definition: ServiceDefinition, context: ServiceContext) => ManagedProcess;

    constructor(private readonly options: SupervisorOptions) {
        super();
        this.policy = options.restartPolicy ?? DEFAULT_RESTART_POLICY;
        this.createProcess = options.createProcess ?? ((definition, context) => new ManagedProcess(definition.spec(context), context.platform));
        this.entries = options.services.map((definition) => ({
            definition,
            status: { name: definition.name, state: "pending" },
            restarts: [],
        }));
    }

    public statuses(): ServiceStatus[] {
        return this.entries.map((entry) => ({ ...entry.status }));
    }

    public processOf(name: string): ManagedProcess | undefined {
        return this.entries.find((entry) => entry.definition.name === name)?.process;
    }

    /**
     * Starts every service in order. A critical service that fails stops what already runs and
     * rejects; a non-critical one is marked failed and the boot goes on.
     */
    public async start(): Promise<void> {
        this.stopping = false;
        for (const entry of this.entries) {
            if (this.stopping) {
                throw new Error("stopped during start");
            }
            try {
                await this.startEntry(entry);
            } catch (error) {
                this.setStatus(entry, "failed", (error as Error).message);
                if (entry.definition.critical) {
                    await this.stop();
                    throw error;
                }
            }
        }
    }

    /** Stops every running service, last started first. Safe to call more than once. */
    public async stop(): Promise<void> {
        this.stopping = true;
        for (const entry of [...this.entries].reverse()) {
            const proc = entry.process;
            if (!proc) {
                continue;
            }
            const options = entry.definition.stopOptions?.(this.options.context, proc) ?? {};
            await proc.stop(options);
            await proc.dispose();
            entry.process = undefined;
            entry.lastProcess = proc;
            if (entry.status.state !== "failed") {
                this.setStatus(entry, "stopped");
            }
        }
    }

    /** The pids still alive after `stop()`; empty when the shutdown was clean. */
    public leftovers(): string[] {
        return this.entries
            .filter((entry) => (entry.process ?? entry.lastProcess)?.stillAlive())
            .map((entry) => entry.definition.name);
    }

    private async startEntry(entry: Entry): Promise<void> {
        const { context } = this.options;
        this.setStatus(entry, "starting");
        await entry.definition.prepare?.(context);
        const proc = this.createProcess(entry.definition, context);
        entry.process = proc;
        entry.status.logFile = proc.spec.logFile;
        proc.on("exit", (info: ExitInfo) => this.onExit(entry, proc, info));
        await proc.start();
        await entry.definition.ready(context, proc);
        this.setStatus(entry, "ready");
    }

    private onExit(entry: Entry, proc: ManagedProcess, info: ExitInfo): void {
        if (info.expected || this.stopping || entry.process !== proc || entry.status.state !== "ready") {
            // exits during start are reported by `ready`
            return;
        }
        const now = Date.now();
        entry.restarts = entry.restarts.filter((time) => now - time < this.policy.windowMs);
        if (entry.restarts.length >= this.policy.maxRestarts) {
            this.setStatus(entry, "failed", `crashed ${entry.restarts.length + 1} times (exit ${info.code ?? info.signal})`);
            this.emit("failed", { ...entry.status });
            return;
        }
        const delay = this.policy.baseDelayMs * 2 ** entry.restarts.length;
        entry.restarts.push(now);
        this.setStatus(entry, "restarting", `exit ${info.code ?? info.signal}, restart in ${delay} ms`);
        setTimeout(() => {
            if (this.stopping) {
                return;
            }
            void proc.dispose().then(() =>
                this.startEntry(entry).catch((error: Error) => {
                    this.setStatus(entry, "failed", error.message);
                    this.emit("failed", { ...entry.status });
                }),
            );
        }, delay);
    }

    private setStatus(entry: Entry, state: ServiceState, detail?: string): void {
        entry.status = { ...entry.status, state, detail };
        this.emit("status", this.statuses());
    }
}
