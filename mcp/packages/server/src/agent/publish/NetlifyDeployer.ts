import { ProviderApi } from "./ProviderApi";
import { PublishError } from "./PublishError";
import type { ProviderId } from "./SecretStore";
import { type DeployStep, type PreviousSite, type SiteDeployment, SiteDeployer, type SitePlan } from "./SiteDeployer";
import type { SiteFile, StaticSite } from "./StaticSite";

/** Site fields of the Netlify API used here. */
interface NetlifySite {
    id?: string;
    name?: string;
    url?: string;
    ssl_url?: string;
}

/** Deploy fields of the Netlify API used here. */
interface NetlifyDeploy {
    id?: string;
    state?: string;
    required?: string[];
    ssl_url?: string;
    url?: string;
    error_message?: string;
}

/**
 * Deployer of static sites to Netlify (REST API, personal access token).
 *
 * Reuses the project's site or creates one named after the project (with a short suffix when
 * the name is taken), creates a deploy from the files' SHA-1 digests, uploads only the files
 * Netlify does not have yet, and waits until the deploy is ready. A `_redirects` fallback to
 * `index.html` is added so app routes load on reload; files of the site win over it.
 */
export class NetlifyDeployer extends SiteDeployer {
    private static readonly BASE = "https://api.netlify.com/api/v1";
    private static readonly SPA_REDIRECTS = "/*    /index.html    200\n";

    public get provider(): ProviderId {
        return "netlify";
    }

    public get providerName(): string {
        return "Netlify";
    }

    public async login(token: string): Promise<string> {
        this.checkFormat(token);
        const answer = await this.api(token).call<{ email?: unknown; full_name?: unknown; slug?: unknown }>(
            "GET",
            "/user"
        );
        const user = answer.data;
        const login = [user?.email, user?.full_name, user?.slug].find((value) => typeof value === "string" && value);
        if (typeof login !== "string") {
            throw new PublishError("provider", "Netlify did not name the account", { provider: this.providerName });
        }
        return login;
    }

    public async plan(token: string, name: string, previous: PreviousSite | null, seed: string): Promise<SitePlan> {
        const api = this.api(token);
        if (previous) {
            const found = await this.findSite(api, previous.siteId);
            if (found) {
                return {
                    siteName: found.name ?? previous.siteName,
                    siteId: found.id,
                    existing: true,
                    url: found.ssl_url ?? found.url,
                };
            }
        }
        const siteName = await this.freeName(SiteDeployer.siteName(name), seed, async (candidate) => {
            return (await this.findSite(api, `${candidate}.netlify.app`)) !== null;
        });
        return { siteName, existing: false };
    }

    public async deploy(
        token: string,
        site: StaticSite,
        plan: SitePlan,
        onStep: (step: DeployStep) => void,
        signal?: AbortSignal
    ): Promise<SiteDeployment> {
        const api = this.api(token);
        const target = await this.site(api, plan);
        const files = site.withFile("_redirects", NetlifyDeployer.SPA_REDIRECTS);
        onStep("upload");
        const digests = Object.fromEntries(files.map((file) => [`/${file.path}`, file.sha1]));
        const created = (
            await api.call<NetlifyDeploy>("POST", `/sites/${encodeURIComponent(target.id)}/deploys`, { files: digests })
        ).data;
        const deployId = created?.id;
        if (typeof deployId !== "string") {
            throw new PublishError("provider", "Netlify did not start the deploy", { provider: this.providerName });
        }
        const required = new Set(created?.required ?? []);
        const uploads = new Map<string, SiteFile>();
        for (const file of files) {
            if (required.has(file.sha1) && !uploads.has(file.sha1)) {
                uploads.set(file.sha1, file);
            }
        }
        await SiteDeployer.uploadAll([...uploads.values()], async (file) => {
            const path = file.path.split("/").map(encodeURIComponent).join("/");
            await api.call("PUT", `/deploys/${encodeURIComponent(deployId)}/files/${path}`, undefined, {
                raw: file.content,
            });
        });
        onStep("deploy");
        const done = await this.waitFor(async () => {
            const current = (await api.call<NetlifyDeploy>("GET", `/deploys/${encodeURIComponent(deployId)}`)).data;
            return { done: current?.state === "ready" || current?.state === "error", value: current };
        }, signal);
        if (done?.state !== "ready") {
            throw new PublishError(
                "deploy-failed",
                `Netlify could not deploy the app${done?.error_message ? `: ${this.mask.mask(done.error_message)}` : ""}`,
                { provider: this.providerName }
            );
        }
        return {
            url: target.ssl_url ?? done.ssl_url ?? target.url ?? done.url ?? "",
            deploymentId: deployId,
            siteId: target.id,
            siteName: target.name ?? plan.siteName,
        };
    }

    protected api(token: string): ProviderApi {
        return new ProviderApi(this.providerName, NetlifyDeployer.BASE, token, this.transport, this.mask);
    }

    /** Reads a site by id or `<name>.netlify.app`; null when the user has none such. */
    private async findSite(api: ProviderApi, idOrDomain: string): Promise<(NetlifySite & { id: string }) | null> {
        const found = await api.call<NetlifySite>("GET", `/sites/${encodeURIComponent(idOrDomain)}`, undefined, {
            accept: [404],
        });
        return found.status !== 404 && typeof found.data?.id === "string" ? { ...found.data, id: found.data.id } : null;
    }

    /** Gets the confirmed site: the existing one, or a new one with the confirmed name. */
    private async site(api: ProviderApi, plan: SitePlan): Promise<NetlifySite & { id: string }> {
        if (plan.existing && plan.siteId) {
            const found = await this.findSite(api, plan.siteId);
            if (found) {
                return found;
            }
        } else {
            const created = await api.call<NetlifySite>("POST", "/sites", { name: plan.siteName }, { accept: [422] });
            if (created.status !== 422 && typeof created.data?.id === "string") {
                return { ...created.data, id: created.data.id };
            }
        }
        throw new PublishError("name-taken", `The Netlify site ${plan.siteName} changed since you confirmed`, {
            provider: this.providerName,
            name: plan.siteName,
        });
    }
}
