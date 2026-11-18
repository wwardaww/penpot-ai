import type { HttpTransport } from "./HttpTransport";
import type { ProviderApi } from "./ProviderApi";
import { PublishError, type SecretMask } from "./PublishError";
import type { ProviderId } from "./SecretStore";
import type { StaticSite } from "./StaticSite";

/** Progress of a deployment. */
export type DeployStep = "upload" | "deploy";

/** Where a site went live. */
export interface SiteDeployment {
    /** public URL of the site */
    url: string;
    /** provider id of the deployment */
    deploymentId: string;
    /** provider id of the project or site (kept for the next deployment) */
    siteId: string;
    /** name of the project or site */
    siteName: string;
}

/** Earlier deployment of the project to the same provider, from `.penforge/publish.json`. */
export interface PreviousSite {
    siteId: string;
    siteName: string;
}

/** Timing of status polls (shortened in tests). */
export interface PollTiming {
    intervalMs: number;
    timeoutMs: number;
}

/**
 * Deployer of a built static site to a hosting provider (Vercel, Netlify).
 */
export abstract class SiteDeployer {
    /** Default polling: every 2 s, at most 10 minutes. */
    public static readonly POLL: PollTiming = { intervalMs: 2000, timeoutMs: 10 * 60_000 };

    /**
     * @param transport - sends API requests
     * @param mask - removes secrets from texts
     * @param poll - polling of the deployment status
     */
    constructor(
        protected readonly transport: HttpTransport,
        protected readonly mask: SecretMask,
        protected readonly poll: PollTiming = SiteDeployer.POLL
    ) {}

    /** Provider id. */
    public abstract get provider(): ProviderId;

    /** Provider name in messages ("Vercel"). */
    public abstract get providerName(): string;

    /**
     * Checks a token and gets the account's name.
     *
     * @param token - the token
     */
    public abstract login(token: string): Promise<string>;

    /**
     * Deploys a site to production and waits until it is live.
     *
     * @param token - the token
     * @param site - the built site
     * @param name - wanted project/site name
     * @param previous - the project's earlier site at this provider
     * @param onStep - progress
     * @param signal - cancels waiting
     */
    public abstract deploy(
        token: string,
        site: StaticSite,
        name: string,
        previous: PreviousSite | null,
        onStep: (step: DeployStep) => void,
        signal?: AbortSignal
    ): Promise<SiteDeployment>;

    /**
     * Turns a project name into a lower-case DNS-friendly name.
     *
     * @param name - any name
     */
    public static siteName(name: string): string {
        const slug = name
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 50)
            .replace(/-+$/g, "");
        return slug.length > 0 ? slug : "penforge-app";
    }

    /**
     * Rejects a token that is blank or not plain printable text.
     *
     * @param token - the token
     */
    protected checkFormat(token: string): void {
        if (!/^[\x21-\x7e]{16,512}$/.test(token)) {
            throw new PublishError("token-format", `This is not a ${this.providerName} token`, {
                provider: this.providerName,
            });
        }
    }

    /**
     * Polls a status until it is final.
     *
     * @param read - reads the current state
     * @param signal - cancels waiting
     * @returns the final state
     */
    protected async waitFor<T>(read: () => Promise<{ done: boolean; value: T }>, signal?: AbortSignal): Promise<T> {
        const deadline = Date.now() + this.poll.timeoutMs;
        for (;;) {
            const { done, value } = await read();
            if (done) {
                return value;
            }
            if (signal?.aborted) {
                throw new PublishError("cancelled", "Stopped");
            }
            if (Date.now() > deadline) {
                throw new PublishError("timeout", `${this.providerName} did not finish the deployment in time`, {
                    provider: this.providerName,
                });
            }
            await new Promise((resolve) => setTimeout(resolve, this.poll.intervalMs));
        }
    }

    /**
     * Uploads files with at most a few requests at a time.
     *
     * @param items - what to upload
     * @param upload - uploads one item
     */
    protected static async uploadAll<T>(items: T[], upload: (item: T) => Promise<void>): Promise<void> {
        const queue = [...items];
        const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
            for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
                await upload(item);
            }
        });
        await Promise.all(workers);
    }

    /** Creates the API client of a token. */
    protected abstract api(token: string): ProviderApi;
}
