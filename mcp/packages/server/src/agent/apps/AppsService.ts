import type {
    AppRunStatus,
    AppsListMessage,
    AppsLogsMessage,
    AppsPhoneStartMessage,
    AppsPhoneStopMessage,
    AppsStartMessage,
    AppsStopMessage,
} from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { AgentError, type AgentClient } from "../AgentClient";
import type { DevServerObserver, PreviewStatus } from "../process/DevServer";
import type { DevServerManager, PreviewWatch } from "../process/DevServerManager";
import type { PhonePreview } from "../publish/PhonePreview";
import { PublishError } from "../publish/PublishError";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import type { WorkspaceManager } from "../workspace/WorkspaceManager";
import { AppCatalog } from "./AppCatalog";

/** Watcher that only keeps a dev server alive (status goes out through the status listener). */
class PinObserver implements DevServerObserver {
    public onStatus(): void {}
    public onLog(): void {}
}

/** Phone preview provider; the daemon's W20 publish services by default. */
export interface PhonePreviewSource {
    /** @throws AgentError `not-configured` when there is none */
    get(): PhonePreview;
}

/**
 * Handler of the `apps.*` messages: the built apps of this computer on the dashboard (W33).
 *
 * Lists the apps ({@link AppCatalog}), starts and stops their dev servers through the W09
 * {@link DevServerManager} (no process code of its own), and opens Expo apps on a phone through
 * the W20 {@link PhonePreview}. The requests need no `context.set`.
 *
 * An app started here is pinned: it keeps running when no tab watches it (the user opened it in a
 * new browser tab) until `apps.stop`, a failure, or the daemon stops. Clients that listed the
 * apps or started one receive every `apps.status` change until they disconnect.
 */
export class AppsService {
    private readonly logger = createLogger("AppsService");
    private readonly catalog: AppCatalog;
    /** pinned dev servers by project id */
    private readonly pins = new Map<string, PreviewWatch>();
    /** clients receiving `apps.status`, by client id */
    private readonly subscribers = new Map<string, AgentClient>();
    /** running phone sessions by project id */
    private readonly phones = new Map<string, AbortController>();
    private readonly removeListener: () => void;

    /**
     * @param devServers - the dev server manager shared with the workspace preview
     * @param workspaces - the project workspaces
     * @param projectsDir - folder holding the project folders
     * @param phone - source of the phone preview
     * @param refusal - English reason why apps are unavailable (server mode), or null
     */
    constructor(
        private readonly devServers: DevServerManager,
        private readonly workspaces: WorkspaceManager,
        projectsDir: string,
        private readonly phone: PhonePreviewSource,
        private readonly refusal: string | null = null
    ) {
        this.catalog = new AppCatalog(projectsDir);
        this.removeListener = devServers.onStatusChange((projectId, status) => this.statusChanged(projectId, status));
    }

    /** Handles `apps.list`. */
    public async list(client: AgentClient, message: AppsListMessage): Promise<void> {
        this.checkAvailable();
        this.subscribe(client);
        const records = await this.catalog.list(message.teamId);
        client.send({
            type: "apps.list",
            rid: message.rid,
            apps: records.map((record) => AppCatalog.withStatus(record, this.runStatus(record.projectId))),
        });
    }

    /** Handles `apps.start`; resolves once the dev server is launched (not when it is ready). */
    public async start(client: AgentClient, message: AppsStartMessage): Promise<void> {
        this.checkAvailable();
        const projectId = await this.builtProject(message.projectId);
        this.subscribe(client);
        const workspace = await this.workspaces.get(projectId);
        this.pin(projectId);
        let status: PreviewStatus;
        try {
            status = await this.devServers.start(workspace);
        } catch (error) {
            this.unpin(projectId);
            throw error;
        }
        // replay for a client joining a server that runs already
        client.send({ type: "apps.status", projectId, ...this.toRunStatus(projectId, status) });
    }

    /** Handles `apps.stop`: ends a phone session, kills the dev server's process tree. */
    public async stop(client: AgentClient, message: AppsStopMessage): Promise<void> {
        this.checkAvailable();
        const projectId = message.projectId;
        if (!ProjectWorkspace.ID_PATTERN.test(projectId) || !(await this.catalog.find(projectId))) {
            throw new AgentError("bad-request", "No built app of this project");
        }
        this.subscribe(client);
        this.phones.get(projectId)?.abort();
        // the pin holds the server until it is gone, so no idle stop races the kill
        const wasRunning = await this.devServers.stop(projectId, "stopped");
        this.unpin(projectId);
        if (!wasRunning) {
            client.send({ type: "apps.status", projectId, state: "stopped", reason: "stopped" });
        }
    }

    /** Handles `apps.logs`. */
    public async logs(client: AgentClient, message: AppsLogsMessage): Promise<void> {
        this.checkAvailable();
        const projectId = await this.builtProject(message.projectId);
        client.send({
            type: "apps.logs",
            rid: message.rid,
            projectId,
            lines: this.devServers.logs(projectId).map((line) => ({ stream: line.stream, text: line.text })),
        });
    }

    /**
     * Handles `apps.phone.start`: runs a phone session until it is stopped. Failures are reported
     * as `apps.phone` `failed` (not as `error`), so the client shows them where it shows the QR.
     */
    public async phoneStart(client: AgentClient, message: AppsPhoneStartMessage): Promise<void> {
        this.checkAvailable();
        if (message.confirmed !== true) {
            throw new AgentError("bad-request", "The user must agree to the local network access first");
        }
        const projectId = await this.builtProject(message.projectId);
        const record = await this.catalog.find(projectId);
        if (!record?.expo) {
            client.send({
                type: "apps.phone",
                projectId,
                state: "failed",
                code: "no-phone-preview",
                message: "This app has no phone preview",
            });
            return;
        }
        const phone = this.phone.get();
        const workspace = await this.workspaces.get(projectId);
        this.phones.get(projectId)?.abort();
        const own = new AbortController();
        this.phones.set(projectId, own);
        const signal = AbortSignal.any([own.signal, client.closed]);
        this.subscribe(client);
        this.pin(projectId);
        client.send({ type: "apps.phone", projectId, state: "starting" });
        try {
            await phone.run(workspace, signal, (session) => {
                client.send({ type: "apps.phone", projectId, state: "ready", ...session });
            });
            client.send({ type: "apps.phone", projectId, state: "stopped" });
        } catch (error) {
            if (signal.aborted) {
                client.send({ type: "apps.phone", projectId, state: "stopped" });
            } else {
                const known = error instanceof PublishError;
                if (!known) {
                    this.logger.warn("Phone session failed: %s", error instanceof Error ? error.message : error);
                }
                client.send({
                    type: "apps.phone",
                    projectId,
                    state: "failed",
                    code: known ? error.code : "internal",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        } finally {
            if (this.phones.get(projectId) === own) {
                this.phones.delete(projectId);
            }
        }
    }

    /** Handles `apps.phone.stop`. */
    public async phoneStop(client: AgentClient, message: AppsPhoneStopMessage): Promise<void> {
        this.checkAvailable();
        const session = this.phones.get(message.projectId);
        if (session) {
            session.abort();
        } else {
            client.send({ type: "apps.phone", projectId: message.projectId, state: "stopped" });
        }
    }

    /** Ends every phone session and pin (daemon stop; the manager kills the servers). */
    public dispose(): void {
        for (const session of this.phones.values()) {
            session.abort();
        }
        for (const projectId of [...this.pins.keys()]) {
            this.unpin(projectId);
        }
        this.removeListener();
    }

    /** Projects whose dev server is pinned (for tests). */
    public get pinnedProjects(): string[] {
        return [...this.pins.keys()];
    }

    private checkAvailable(): void {
        if (this.refusal !== null) {
            throw new AgentError("not-configured", this.refusal);
        }
    }

    private async builtProject(projectId: string): Promise<string> {
        if (!ProjectWorkspace.ID_PATTERN.test(projectId)) {
            throw new AgentError("bad-request", "Invalid project id");
        }
        if (!(await this.catalog.find(projectId))) {
            throw new AgentError("not-configured", "There is no built app for this project");
        }
        return projectId;
    }

    private runStatus(projectId: string): AppRunStatus {
        const status = this.devServers.status(projectId);
        return status ? this.toRunStatus(projectId, status) : { state: "stopped" };
    }

    private toRunStatus(projectId: string, status: PreviewStatus): AppRunStatus {
        const exposure = this.devServers.exposureOf(projectId);
        return {
            state: status.state,
            url: status.url,
            reason: status.reason,
            message: status.message,
            exposure: exposure?.mode,
        };
    }

    private pin(projectId: string): void {
        if (!this.pins.has(projectId)) {
            this.pins.set(projectId, this.devServers.watch(projectId, new PinObserver()));
        }
    }

    private unpin(projectId: string): void {
        const pin = this.pins.get(projectId);
        if (pin) {
            this.pins.delete(projectId);
            pin.dispose();
        }
    }

    private subscribe(client: AgentClient): void {
        if (this.subscribers.has(client.id)) {
            return;
        }
        this.subscribers.set(client.id, client);
        client.closed.addEventListener("abort", () => this.subscribers.delete(client.id), { once: true });
    }

    private statusChanged(projectId: string, status: PreviewStatus): void {
        // a server that failed or stopped by itself is not kept any more; a phone session's
        // restart (stopped with reason `restarting`) keeps the pin
        if ((status.state === "failed" || status.state === "stopped") && status.reason !== "restarting") {
            this.unpin(projectId);
        }
        if (this.subscribers.size === 0) {
            return;
        }
        const message = { type: "apps.status" as const, projectId, ...this.toRunStatus(projectId, status) };
        for (const client of this.subscribers.values()) {
            client.send(message);
        }
    }
}
