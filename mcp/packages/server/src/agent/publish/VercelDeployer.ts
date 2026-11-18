import { ProviderApi } from "./ProviderApi";
import { PublishError } from "./PublishError";
import type { ProviderId } from "./SecretStore";
import { type DeployStep, type PreviousSite, type SiteDeployment, SiteDeployer, type SitePlan } from "./SiteDeployer";
import type { StaticSite } from "./StaticSite";

/** Deployment fields of the Vercel API used here. */
interface VercelDeployment {
    id?: string;
    url?: string;
    name?: string;
    projectId?: string;
    readyState?: string;
    aliasAssigned?: boolean | number | null;
    alias?: string[];
    errorMessage?: string;
}

/**
 * Deployer of static sites to Vercel (REST API, personal access token).
 *
 * Uploads every file (`POST /v2/files`, addressed by SHA-1), creates a production deployment of
 * a project named after the Penforge project (`POST /v13/deployments`), and waits until it is
 * ready and has its production domain. A `vercel.json` with a fallback to `index.html` is added
 * so app routes load on reload; files of the site win over it.
 */
export class VercelDeployer extends SiteDeployer {
    private static readonly BASE = "https://api.vercel.com";
    private static readonly SPA_CONFIG = `${JSON.stringify(
        { rewrites: [{ source: "/(.*)", destination: "/index.html" }] },
        null,
        2
    )}\n`;

    public get provider(): ProviderId {
        return "vercel";
    }

    public get providerName(): string {
        return "Vercel";
    }

    public async login(token: string): Promise<string> {
        this.checkFormat(token);
        const answer = await this.api(token).call<{ user?: { username?: unknown; email?: unknown } }>(
            "GET",
            "/v2/user"
        );
        const user = answer.data?.user;
        const login = typeof user?.username === "string" ? user.username : user?.email;
        if (typeof login !== "string") {
            throw new PublishError("provider", "Vercel did not name the account", { provider: this.providerName });
        }
        return login;
    }

    public async plan(token: string, name: string, previous: PreviousSite | null, seed: string): Promise<SitePlan> {
        const api = this.api(token);
        if (previous) {
            const found = await this.project(api, previous.siteId);
            if (found?.id === previous.siteId && typeof found.name === "string") {
                return {
                    siteName: found.name,
                    siteId: found.id,
                    existing: true,
                    url: `https://${found.name}.vercel.app`,
                };
            }
        }
        const siteName = await this.freeName(SiteDeployer.siteName(name), seed, async (candidate) => {
            return (await this.project(api, candidate)) !== null;
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
        const current = await this.project(api, plan.siteId ?? plan.siteName);
        if (plan.existing ? current?.id !== plan.siteId : current !== null) {
            // never deploy onto a project the user did not confirm
            throw new PublishError("name-taken", `The Vercel project ${plan.siteName} changed since you confirmed`, {
                provider: this.providerName,
                name: plan.siteName,
            });
        }
        const files = site.withFile("vercel.json", VercelDeployer.SPA_CONFIG);
        onStep("upload");
        await SiteDeployer.uploadAll(files, async (file) => {
            await api.call("POST", "/v2/files", undefined, {
                raw: file.content,
                headers: { "x-vercel-digest": file.sha1, "Content-Type": "application/octet-stream" },
            });
        });
        onStep("deploy");
        const projectName = plan.siteName;
        const created = await api.call<VercelDeployment>("POST", "/v13/deployments?skipAutoDetectionConfirmation=1", {
            name: projectName,
            ...(plan.existing && plan.siteId ? { project: plan.siteId } : {}),
            target: "production",
            files: files.map((file) => ({ file: file.path, sha: file.sha1, size: file.size })),
            projectSettings: { framework: null },
        });
        const id = created.data?.id;
        if (typeof id !== "string") {
            throw new PublishError("provider", "Vercel did not start the deployment", { provider: this.providerName });
        }
        const done = await this.waitFor(async () => {
            const current = (await api.call<VercelDeployment>("GET", `/v13/deployments/${encodeURIComponent(id)}`))
                .data;
            const state = current?.readyState;
            const final = state === "ERROR" || state === "CANCELED" || (state === "READY" && !!current?.aliasAssigned);
            return { done: final, value: current };
        }, signal);
        if (done?.readyState !== "READY") {
            throw new PublishError(
                "deploy-failed",
                `Vercel could not deploy the app${done?.errorMessage ? `: ${this.mask.mask(done.errorMessage)}` : ""}`,
                { provider: this.providerName }
            );
        }
        const host = done.alias?.[0] ?? done.url;
        return {
            url: `https://${host}`,
            deploymentId: id,
            siteId: done.projectId ?? plan.siteId ?? projectName,
            siteName: done.name ?? projectName,
        };
    }

    /** Reads a project by id or name; null when the user has none such. */
    private async project(api: ProviderApi, idOrName: string): Promise<{ id?: string; name?: string } | null> {
        const answer = await api.call<{ id?: string; name?: string }>(
            "GET",
            `/v9/projects/${encodeURIComponent(idOrName)}`,
            undefined,
            { accept: [404] }
        );
        return answer.status === 404 ? null : (answer.data ?? {});
    }

    protected api(token: string): ProviderApi {
        return new ProviderApi(this.providerName, VercelDeployer.BASE, token, this.transport, this.mask);
    }
}
