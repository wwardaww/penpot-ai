import { AgentError } from "../AgentClient";
import type { DevServerManager } from "../process/DevServerManager";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import type { DownloadRegistry } from "./DownloadRegistry";
import { GitHubPublisher } from "./GitHubPublisher";
import { FetchTransport, type HttpTransport } from "./HttpTransport";
import { NetlifyDeployer } from "./NetlifyDeployer";
import { PhonePreview } from "./PhonePreview";
import { PublishError, SecretMask } from "./PublishError";
import type { ProviderId, SecretStore } from "./SecretStore";
import type { SiteDeployer } from "./SiteDeployer";
import { StaticSiteBuilder } from "./StaticSite";
import { VercelDeployer } from "./VercelDeployer";

/** Where the project was published, kept in `.penforge/publish.json` (no tokens). */
export interface PublishRecord {
    github?: { owner: string; repo: string; url: string; private: boolean; commit: string; pushedAt: string };
    vercel?: SiteRecord;
    netlify?: SiteRecord;
}

/** Last deployment of a site provider. */
export interface SiteRecord {
    url: string;
    siteId: string;
    siteName: string;
    deployedAt: string;
}

/**
 * Requests from the AI chat to open the publish panel, by the tab's MCP session.
 *
 * The chat's `penforge_open_publish` tool records the target here; the panel the client then
 * opens reads it once with the `publish` workflow's `status` action.
 */
export class PublishRequests {
    /** Requests of this daemon process. */
    public static readonly shared = new PublishRequests();
    private static readonly TTL_MS = 2 * 60_000;
    private readonly requests = new Map<string, { target: string; at: number }>();

    /**
     * Records a request.
     *
     * @param sessionId - the tab's MCP session
     * @param target - what to publish
     */
    public record(sessionId: string, target: string): void {
        this.requests.set(sessionId, { target, at: Date.now() });
    }

    /**
     * Takes the request of a tab, if a recent one exists.
     *
     * @param sessionId - the tab's MCP session
     */
    public take(sessionId: string | undefined): string | null {
        if (sessionId === undefined) {
            return null;
        }
        const request = this.requests.get(sessionId);
        this.requests.delete(sessionId);
        return request && Date.now() - request.at < PublishRequests.TTL_MS ? request.target : null;
    }
}

/**
 * Daemon services the `publish` workflow uses (workflows get only their run context).
 *
 * Installed once by the daemon; tests install their own with fake providers.
 */
export class PublishServices {
    private static current?: PublishServices;

    /** Removes secrets from texts that leave the daemon. */
    public readonly mask: SecretMask;
    public readonly github: GitHubPublisher;
    public readonly deployers: Record<Exclude<ProviderId, "github">, SiteDeployer>;
    public readonly sites: StaticSiteBuilder;
    public readonly phone: PhonePreview;
    private readonly busy = new Set<string>();

    /**
     * @param secrets - the token store
     * @param downloads - files waiting for the browser
     * @param downloadUrl - turns a download id into the URL the browser opens
     * @param devServers - the dev server manager (phone preview)
     * @param parts - replacements (tests)
     */
    constructor(
        public readonly secrets: SecretStore,
        public readonly downloads: DownloadRegistry,
        public readonly downloadUrl: (id: string) => string,
        devServers: DevServerManager,
        parts: {
            transport?: HttpTransport;
            github?: GitHubPublisher;
            deployers?: Record<Exclude<ProviderId, "github">, SiteDeployer>;
            sites?: StaticSiteBuilder;
            phone?: PhonePreview;
        } = {}
    ) {
        this.mask = new SecretMask(() => secrets.knownTokens());
        const transport = parts.transport ?? new FetchTransport();
        this.github = parts.github ?? new GitHubPublisher(transport, this.mask);
        this.deployers = parts.deployers ?? {
            vercel: new VercelDeployer(transport, this.mask),
            netlify: new NetlifyDeployer(transport, this.mask),
        };
        this.sites = parts.sites ?? new StaticSiteBuilder(undefined, this.mask);
        this.phone = parts.phone ?? new PhonePreview(devServers);
    }

    /**
     * Installs the services of this daemon process.
     *
     * @param services - the services
     */
    public static install(services: PublishServices): void {
        PublishServices.current = services;
    }

    /**
     * Removes installed services (daemon stop), unless others were installed since.
     *
     * @param services - the services to remove
     */
    public static uninstall(services: PublishServices): void {
        if (PublishServices.current === services) {
            PublishServices.current = undefined;
        }
    }

    /**
     * Gets the installed services.
     *
     * @throws AgentError `not-configured` when the daemon installed none
     */
    public static get(): PublishServices {
        if (!PublishServices.current) {
            throw new AgentError("not-configured", "Publishing is not available in this daemon");
        }
        return PublishServices.current;
    }

    /**
     * Runs a step that changes something outside the project, one at a time per project.
     *
     * @param projectId - the project
     * @param step - the step
     * @throws PublishError `busy` while another step of the project runs
     */
    public async exclusive<T>(projectId: string, step: () => Promise<T>): Promise<T> {
        if (this.busy.has(projectId)) {
            throw new PublishError("busy", "Another publish step of this project is running");
        }
        this.busy.add(projectId);
        try {
            return await step();
        } finally {
            this.busy.delete(projectId);
        }
    }

    /**
     * Reads where a project was published.
     *
     * @param workspace - the project
     */
    public static async record(workspace: WorkflowWorkspaceApi): Promise<PublishRecord> {
        const value = await workspace.readJson<PublishRecord | null>("publish.json", null).catch(() => null);
        return value && typeof value === "object" ? value : {};
    }

    /**
     * Updates where a project was published.
     *
     * @param workspace - the project
     * @param change - the fields to replace
     */
    public static async updateRecord(workspace: WorkflowWorkspaceApi, change: PublishRecord): Promise<PublishRecord> {
        const next = { ...(await PublishServices.record(workspace)), ...change };
        await workspace.writeJson("publish.json", next);
        return next;
    }
}
