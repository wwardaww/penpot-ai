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
import type { DevServerTarget } from "../process/DevServerTarget";
import type { PhonePreview } from "../publish/PhonePreview";
import { PublishError } from "../publish/PublishError";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import type { WorkspaceManager } from "../workspace/WorkspaceManager";
import { AppCatalog, type AppRecord } from "./AppCatalog";
import { RedesignedAppServer } from "./RedesignedAppServer";
import { RedesignedApps } from "./RedesignedApps";

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

/** App reference of an `apps.*` request. */
interface AppRequest {
    projectId: string;
    appId?: string;
}

/**
 * Handler of the `apps.*` messages: the apps of this computer on the dashboard (W33), built ones
 * and (W39) Re-Designed Existing projects.
 *
 * Lists the apps ({@link AppCatalog}), starts and stops their dev servers through the W09
 * {@link DevServerManager} (no process code of its own), and opens Expo apps on a phone through
 * the W20 {@link PhonePreview}. The requests need no `context.set`. A built app's dev server is
 * the project's (shared with the workspace preview); a Re-Designed app's runs in its folder of the
 * linked project ({@link RedesignedAppServer}) under the app id.
 *
 * An app started here is pinned: it keeps running when no tab watches it (the user opened it in a
 * new browser tab) until `apps.stop`, a failure, or the daemon stops. Clients that listed the
 * apps or started one receive every `apps.status` change until they disconnect.
 */
export class AppsService {
    private readonly logger = createLogger("AppsService");
    private readonly catalog: AppCatalog;
    /** pinned dev servers by app id */
    private readonly pins = new Map<string, PreviewWatch>();
    /** clients receiving `apps.status`, by client id */
    private readonly subscribers = new Map<string, AgentClient>();
    /** running phone sessions by app id */
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
        this.removeListener = devServers.onStatusChange((appId, status) => this.statusChanged(appId, status));
    }

    /** Handles `apps.list`. */
    public async list(client: AgentClient, message: AppsListMessage): Promise<void> {
        this.checkAvailable();
        this.subscribe(client);
        const records = await this.catalog.list(message.teamId);
        client.send({
            type: "apps.list",
            rid: message.rid,
            apps: records.map((record) => AppCatalog.withStatus(record, this.runStatus(record.appId))),
        });
    }

    /** Handles `apps.start`; resolves once the dev server is launched (not when it is ready). */
    public async start(client: AgentClient, message: AppsStartMessage): Promise<void> {
        this.checkAvailable();
        const app = await this.app(message);
        const appId = app.appId;
        this.subscribe(client);
        const target = await this.target(app);
        this.pin(appId);
        let status: PreviewStatus;
        try {
            status = await this.devServers.start(target);
        } catch (error) {
            this.unpin(appId);
            throw error;
        }
        // replay for a client joining a server that runs already
        client.send({ type: "apps.status", ...this.ids(appId), ...this.toRunStatus(appId, status) });
    }

    /** Handles `apps.stop`: ends a phone session, kills the dev server's process tree. */
    public async stop(client: AgentClient, message: AppsStopMessage): Promise<void> {
        this.checkAvailable();
        const appId = this.appIdOf(message);
        if (!(await this.catalog.findApp(appId))) {
            throw new AgentError("bad-request", "No app with this id");
        }
        this.subscribe(client);
        this.phones.get(appId)?.abort();
        // the pin holds the server until it is gone, so no idle stop races the kill
        const wasRunning = await this.devServers.stop(appId, "stopped");
        this.unpin(appId);
        if (!wasRunning) {
            client.send({ type: "apps.status", ...this.ids(appId), state: "stopped", reason: "stopped" });
        }
    }

    /** Handles `apps.logs`. */
    public async logs(client: AgentClient, message: AppsLogsMessage): Promise<void> {
        this.checkAvailable();
        const appId = (await this.app(message)).appId;
        client.send({
            type: "apps.logs",
            rid: message.rid,
            ...this.ids(appId),
            lines: this.devServers.logs(appId).map((line) => ({ stream: line.stream, text: line.text })),
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
        const record = await this.app(message);
        const appId = record.appId;
        const ids = this.ids(appId);
        if (!record.expo) {
            client.send({
                type: "apps.phone",
                ...ids,
                state: "failed",
                code: "no-phone-preview",
                message: "This app has no phone preview",
            });
            return;
        }
        const phone = this.phone.get();
        const target = await this.target(record);
        this.phones.get(appId)?.abort();
        const own = new AbortController();
        this.phones.set(appId, own);
        const signal = AbortSignal.any([own.signal, client.closed]);
        this.subscribe(client);
        this.pin(appId);
        client.send({ type: "apps.phone", ...ids, state: "starting" });
        try {
            await phone.run(target, signal, (session) => {
                client.send({ type: "apps.phone", ...ids, state: "ready", ...session });
            });
            client.send({ type: "apps.phone", ...ids, state: "stopped" });
        } catch (error) {
            if (signal.aborted) {
                client.send({ type: "apps.phone", ...ids, state: "stopped" });
            } else {
                const known = error instanceof PublishError;
                if (!known) {
                    this.logger.warn("Phone session failed: %s", error instanceof Error ? error.message : error);
                }
                client.send({
                    type: "apps.phone",
                    ...ids,
                    state: "failed",
                    code: known ? error.code : "internal",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        } finally {
            if (this.phones.get(appId) === own) {
                this.phones.delete(appId);
            }
        }
    }

    /** Handles `apps.phone.stop`. */
    public async phoneStop(client: AgentClient, message: AppsPhoneStopMessage): Promise<void> {
        this.checkAvailable();
        const appId = this.appIdOf(message);
        const session = this.phones.get(appId);
        if (session) {
            session.abort();
        } else {
            client.send({ type: "apps.phone", ...this.ids(appId), state: "stopped" });
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

    /** Apps whose dev server is pinned (for tests). */
    public get pinnedProjects(): string[] {
        return [...this.pins.keys()];
    }

    private checkAvailable(): void {
        if (this.refusal !== null) {
            throw new AgentError("not-configured", this.refusal);
        }
    }

    /** The app id a request names: `appId`, else the project id (its built app). */
    private appIdOf(message: AppRequest): string {
        if (!ProjectWorkspace.ID_PATTERN.test(message.projectId)) {
            throw new AgentError("bad-request", "Invalid project id");
        }
        const appId = message.appId ?? message.projectId;
        if ((RedesignedApps.projectOf(appId) ?? appId) !== message.projectId) {
            throw new AgentError("bad-request", "The app does not belong to the project");
        }
        return appId;
    }

    /** The app a request names. */
    private async app(message: AppRequest): Promise<AppRecord> {
        const app = await this.catalog.findApp(this.appIdOf(message));
        if (!app) {
            throw new AgentError("not-configured", "There is no app with this id");
        }
        return app;
    }

    /** What the dev server runs for: the project's generated app, or the Re-Designed app folder. */
    private async target(app: AppRecord): Promise<ProjectWorkspace | DevServerTarget> {
        return app.redesign
            ? new RedesignedAppServer(app.appId, app.redesign.root, app.redesign.appDir)
            : this.workspaces.get(app.projectId);
    }

    /** The ids of `apps.*` replies for an app id (a dev server key). */
    private ids(appId: string): { projectId: string; appId: string } {
        return { projectId: RedesignedApps.projectOf(appId) ?? appId, appId };
    }

    private runStatus(appId: string): AppRunStatus {
        const status = this.devServers.status(appId);
        return status ? this.toRunStatus(appId, status) : { state: "stopped" };
    }

    private toRunStatus(appId: string, status: PreviewStatus): AppRunStatus {
        const exposure = this.devServers.exposureOf(appId);
        return {
            state: status.state,
            url: status.url,
            reason: status.reason,
            message: status.message,
            exposure: exposure?.mode,
        };
    }

    private pin(appId: string): void {
        if (!this.pins.has(appId)) {
            this.pins.set(appId, this.devServers.watch(appId, new PinObserver()));
        }
    }

    private unpin(appId: string): void {
        const pin = this.pins.get(appId);
        if (pin) {
            this.pins.delete(appId);
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

    private statusChanged(appId: string, status: PreviewStatus): void {
        // a server that failed or stopped by itself is not kept any more; a phone session's
        // restart (stopped with reason `restarting`) keeps the pin
        if ((status.state === "failed" || status.state === "stopped") && status.reason !== "restarting") {
            this.unpin(appId);
        }
        if (this.subscribers.size === 0) {
            return;
        }
        const message = { type: "apps.status" as const, ...this.ids(appId), ...this.toRunStatus(appId, status) };
        for (const client of this.subscribers.values()) {
            client.send(message);
        }
    }
}
