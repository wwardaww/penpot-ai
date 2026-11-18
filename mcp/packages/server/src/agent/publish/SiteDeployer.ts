import { createHash } from "crypto";
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

/**
 * Where a deployment will go, decided before the user confirms.
 *
 * `existing` is the site this Penforge project deployed to before (its id is in
 * `.penforge/publish.json` and still exists at the provider). Otherwise `siteName` is a name no
 * project or site of the user has yet: a deployment never lands on a site the user made
 * elsewhere.
 */
export interface SitePlan {
    siteName: string;
    siteId?: string;
    existing: boolean;
    /** public URL of the existing site */
    url?: string;
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
     * Decides where a deployment goes: the project's earlier site when it still exists, else a
     * free name derived from `name`.
     *
     * @param token - the token
     * @param name - wanted project/site name (the Penforge project name)
     * @param previous - the project's earlier site at this provider
     * @param seed - the Penforge project id; makes the suffix of a taken name the same on every call
     * @throws PublishError `name-taken` when no free name is found
     */
    public abstract plan(token: string, name: string, previous: PreviousSite | null, seed: string): Promise<SitePlan>;

    /**
     * Deploys a site to production and waits until it is live.
     *
     * @param token - the token
     * @param site - the built site
     * @param plan - where it goes (from {@link plan}, confirmed by the user)
     * @param onStep - progress
     * @param signal - cancels waiting
     * @throws PublishError `name-taken` when a new name was taken since the plan
     */
    public abstract deploy(
        token: string,
        site: StaticSite,
        plan: SitePlan,
        onStep: (step: DeployStep) => void,
        signal?: AbortSignal
    ): Promise<SiteDeployment>;

    /**
     * Finds the first free name among `base`, `base-<6 hex>`, ... The suffixes derive from
     * `seed`, so planning twice for one project gives the same name.
     *
     * @param base - the wanted name
     * @param seed - the Penforge project id
     * @param taken - tells whether a name is used by one of the user's projects or sites
     */
    protected async freeName(base: string, seed: string, taken: (name: string) => Promise<boolean>): Promise<string> {
        for (let attempt = 0; attempt < 5; attempt++) {
            const suffix = createHash("sha1").update(`${seed}:${attempt}`).digest("hex").slice(0, 6);
            const candidate = attempt === 0 ? base : `${base.slice(0, 43)}-${suffix}`;
            if (!(await taken(candidate))) {
                return candidate;
            }
        }
        throw new PublishError("name-taken", `${this.providerName} has no free name like ${base}`, {
            provider: this.providerName,
            name: base,
        });
    }

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
