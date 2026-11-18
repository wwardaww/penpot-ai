import { randomBytes } from "crypto";
import { ProviderApi } from "./ProviderApi";
import { PublishError } from "./PublishError";
import type { ProviderId } from "./SecretStore";
import { type DeployStep, type PreviousSite, type SiteDeployment, SiteDeployer } from "./SiteDeployer";
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

    public async deploy(
        token: string,
        site: StaticSite,
        name: string,
        previous: PreviousSite | null,
        onStep: (step: DeployStep) => void,
        signal?: AbortSignal
    ): Promise<SiteDeployment> {
        const api = this.api(token);
        const target = await this.site(api, name, previous);
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
            siteName: target.name ?? name,
        };
    }

    protected api(token: string): ProviderApi {
        return new ProviderApi(this.providerName, NetlifyDeployer.BASE, token, this.transport, this.mask);
    }

    /** Finds the project's earlier site or creates a new one. */
    private async site(
        api: ProviderApi,
        name: string,
        previous: PreviousSite | null
    ): Promise<NetlifySite & { id: string }> {
        if (previous) {
            const found = await api.call<NetlifySite>(
                "GET",
                `/sites/${encodeURIComponent(previous.siteId)}`,
                undefined,
                {
                    accept: [404],
                }
            );
            if (found.status !== 404 && typeof found.data?.id === "string") {
                return { ...found.data, id: found.data.id };
            }
        }
        const base = SiteDeployer.siteName(name);
        for (let attempt = 0; attempt < 4; attempt++) {
            const candidate = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
            const created = await api.call<NetlifySite>("POST", "/sites", { name: candidate }, { accept: [422] });
            if (created.status !== 422 && typeof created.data?.id === "string") {
                return { ...created.data, id: created.data.id };
            }
        }
        throw new PublishError("name-taken", `Netlify has no free site name like ${base}`, {
            provider: this.providerName,
            name: base,
        });
    }
}
