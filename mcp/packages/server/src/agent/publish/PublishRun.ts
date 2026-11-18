import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { WorkflowContext } from "@penpot/mcp-common";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { AppArchive } from "./AppArchive";
import { GitHubPublisher } from "./GitHubPublisher";
import { PhonePreview } from "./PhonePreview";
import { PublishError } from "./PublishError";
import { PublishRequests, PublishServices } from "./PublishServices";
import { PROVIDERS, type ProviderId } from "./SecretStore";

/** Params of the `publish` workflow (see `wiki/architecture.md` §7). */
export const PublishParamsSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("status") }),
    z.object({
        action: z.literal("connect"),
        provider: z.enum(PROVIDERS as [ProviderId, ...ProviderId[]]),
        token: z.string().min(1).max(1024),
    }),
    z.object({ action: z.literal("disconnect"), provider: z.enum(PROVIDERS as [ProviderId, ...ProviderId[]]) }),
    z.object({ action: z.literal("zip") }),
    z.object({
        action: z.literal("github"),
        name: z.string().min(1).max(100).optional(),
        private: z.boolean().optional(),
        confirmed: z.boolean().optional(),
        confirmedPublic: z.boolean().optional(),
    }),
    z.object({ action: z.literal("vercel"), confirmed: z.boolean().optional() }),
    z.object({ action: z.literal("netlify"), confirmed: z.boolean().optional() }),
    z.object({ action: z.literal("phone"), confirmed: z.boolean().optional() }),
]);

/** Params of the `publish` workflow. */
export type PublishParams = z.infer<typeof PublishParamsSchema>;

/** Steps reported as `progress {step}`. */
type Step = "save" | "repo" | "push" | "install" | "build" | "upload" | "deploy" | "phone";

const STEP_TEXT: Record<Step, string> = {
    save: "Saving the app",
    repo: "Preparing the GitHub repository",
    push: "Sending the app to GitHub",
    install: "Installing the app's packages",
    build: "Building the app",
    upload: "Uploading the app",
    deploy: "Putting the app online",
    phone: "Starting the app for your phone",
};

/**
 * One run of the `publish` workflow: account status, connecting accounts, ZIP download, GitHub
 * push, Vercel and Netlify deployments, and the phone preview.
 *
 * Steps that send the app somewhere ask the user first (a `question` event) unless the client
 * already asked (`confirmed: true`); creating a public GitHub repository asks separately
 * (`confirmedPublic`). Tokens arrive only with `connect`, go straight to the {@link SecretStore},
 * and never appear in events, summaries or logs. Failures are reported as a `failed` event
 * `{code, params, message, detail?}` (`detail` for the developer persona only) before the run ends.
 */
export class PublishRun {
    constructor(
        private readonly ctx: WorkflowContext,
        private readonly services: PublishServices
    ) {}

    /**
     * Runs the action.
     *
     * @param raw - the workflow params
     * @returns the summary for `workflow.done` (an English fallback)
     */
    public async run(raw: unknown): Promise<{ summary: string }> {
        const parsed = PublishParamsSchema.safeParse(raw);
        if (!parsed.success) {
            // the params may hold a token: report the field, never the value
            const issue = parsed.error.issues[0];
            throw new Error(
                `Invalid publish params: ${issue?.path.join(".") || "action"} ${issue?.message ?? ""}`.trim()
            );
        }
        const params = parsed.data;
        try {
            return await this.dispatch(params);
        } catch (error) {
            if (error instanceof PublishError && error.code === "cancelled") {
                return this.cancelled(params.action);
            }
            throw this.report(error);
        }
    }

    private async dispatch(params: PublishParams): Promise<{ summary: string }> {
        switch (params.action) {
            case "status":
                return this.status();
            case "connect":
                return this.connect(params.provider, params.token);
            case "disconnect":
                return this.disconnect(params.provider);
            case "zip":
                return this.zip();
            case "github":
                return this.github(params);
            case "vercel":
            case "netlify":
                return this.deploy(params.action, params.confirmed === true);
            case "phone":
                return this.phonePreview(params.confirmed === true);
        }
    }

    private async status(): Promise<{ summary: string }> {
        const workspace = this.ctx.workspace;
        const exists = existsSync(join(workspace.appSrcDir, "package.json"));
        const phone = exists && workspace instanceof ProjectWorkspace ? await PhonePreview.supports(workspace) : false;
        this.ctx.emit("result", {
            action: "status",
            accounts: await this.services.secrets.accounts(),
            app: { exists, phone },
            published: await PublishServices.record(workspace),
            requested: PublishRequests.shared.take(this.ctx.context.mcpSessionId),
        });
        return { summary: "Publish status" };
    }

    private async connect(provider: ProviderId, rawToken: string): Promise<{ summary: string }> {
        const token = rawToken.trim();
        const login =
            provider === "github"
                ? await this.services.github.login(token)
                : await this.services.deployers[provider].login(token);
        const account = await this.services.secrets.save(provider, token, login);
        this.ctx.emit("result", { action: "connect", account });
        return { summary: `Connected ${provider} as ${login}` };
    }

    private async disconnect(provider: ProviderId): Promise<{ summary: string }> {
        const removed = await this.services.secrets.remove(provider);
        this.ctx.emit("result", { action: "disconnect", provider, removed });
        return { summary: `Disconnected ${provider}` };
    }

    private async zip(): Promise<{ summary: string }> {
        const name = GitHubPublisher.repoName(this.projectName());
        const content = await AppArchive.zip(this.ctx.workspace.appSrcDir, name);
        const filename = `${name}.zip`;
        const id = this.services.downloads.add({ filename, contentType: "application/zip", content });
        this.ctx.emit("result", {
            action: "zip",
            url: this.services.downloadUrl(id),
            filename,
            size: content.length,
            expiresInS: this.services.downloads.ttlSeconds,
        });
        return { summary: `${filename} is ready` };
    }

    private async github(params: Extract<PublishParams, { action: "github" }>): Promise<{ summary: string }> {
        const workspace = this.ctx.workspace;
        const token = await this.token("github");
        const account = (await this.services.secrets.account("github"))!;
        this.requireApp();
        const record = await PublishServices.record(workspace);
        const name = params.name ?? record.github?.repo ?? GitHubPublisher.repoName(this.projectName());
        const isPrivate = params.private ?? record.github?.private ?? true;
        if (
            !params.confirmed &&
            !(await this.confirm(`Send the app to GitHub (${account.login}/${name})?`, "github"))
        ) {
            return this.cancelled("github");
        }
        return this.services.exclusive(workspace.projectId, async () => {
            this.progress("save");
            await workspace.commitAll("app-src", "penforge(publish): save before sending to GitHub");
            const commit = await this.services.github.head(workspace.appSrcDir);
            if (commit === null) {
                throw new PublishError("no-app", "The app has no saved version yet");
            }
            this.progress("repo");
            const repo = await this.services.github.ensureRepo(token, account.login, name, isPrivate, async () => {
                if (
                    !isPrivate &&
                    !params.confirmedPublic &&
                    !(await this.confirm(
                        `Create the public repository ${account.login}/${name}? Anyone can see its code.`,
                        "github-public"
                    ))
                ) {
                    throw new PublishError("cancelled", "Cancelled");
                }
            });
            this.progress("push");
            await this.services.github.push(token, workspace.appSrcDir, repo);
            const linked = await this.services.github.linkRemote(workspace.appSrcDir, repo).catch(() => false);
            await PublishServices.updateRecord(workspace, {
                github: {
                    owner: repo.owner,
                    repo: repo.repo,
                    url: repo.url,
                    private: repo.private,
                    commit,
                    pushedAt: new Date().toISOString(),
                },
            });
            this.ctx.emit("result", { action: "github", ...repo, commit, linkedRemote: linked });
            return { summary: `Sent to ${repo.url}` };
        });
    }

    private async deploy(provider: "vercel" | "netlify", confirmed: boolean): Promise<{ summary: string }> {
        const workspace = this.ctx.workspace;
        const deployer = this.services.deployers[provider];
        const token = await this.token(provider);
        this.requireApp();
        if (!confirmed && !(await this.confirm(`Put the app online with ${deployer.providerName}?`, provider))) {
            return this.cancelled(provider);
        }
        return this.services.exclusive(workspace.projectId, async () => {
            const site = await this.services.sites.build(workspace, this.ctx.signal, (step) => this.progress(step));
            const record = await PublishServices.record(workspace);
            const previous = record[provider] ?? null;
            const deployment = await deployer.deploy(
                token,
                site,
                this.projectName(),
                previous,
                (step) => this.progress(step),
                this.abortSignal()
            );
            await PublishServices.updateRecord(workspace, {
                [provider]: {
                    url: deployment.url,
                    siteId: deployment.siteId,
                    siteName: deployment.siteName,
                    deployedAt: new Date().toISOString(),
                },
            });
            this.ctx.emit("result", {
                action: provider,
                provider,
                url: deployment.url,
                siteName: deployment.siteName,
                files: site.files.length,
            });
            return { summary: `Online at ${deployment.url}` };
        });
    }

    private async phonePreview(confirmed: boolean): Promise<{ summary: string }> {
        const workspace = this.ctx.workspace;
        if (!(workspace instanceof ProjectWorkspace)) {
            throw new PublishError("no-phone-preview", "The phone preview needs a project workspace");
        }
        this.requireApp();
        if (
            !confirmed &&
            !(await this.confirm(
                "Open the app on your phone? While the QR code is shown, devices on your local network can open the app.",
                "phone"
            ))
        ) {
            return this.cancelled("phone");
        }
        this.progress("phone");
        await this.services.phone.run(workspace, this.abortSignal(), (session) => {
            this.ctx.emit("phone", { state: "ready", ...session });
        });
        this.ctx.emit("phone", { state: "stopped" });
        return { summary: "Phone preview stopped" };
    }

    private async token(provider: ProviderId): Promise<string> {
        const token = await this.services.secrets.token(provider);
        if (token === null) {
            throw new PublishError("not-connected", `Connect your ${provider} account first`, { provider });
        }
        return token;
    }

    private requireApp(): void {
        if (!existsSync(join(this.ctx.workspace.appSrcDir, "package.json"))) {
            throw new PublishError("no-app", "There is no generated app to publish yet");
        }
    }

    private async confirm(text: string, target: string): Promise<boolean> {
        const answer = await this.ctx.ask({
            text,
            options: [
                { id: "publish", label: "Yes, go ahead" },
                { id: "cancel", label: "Cancel" },
            ],
        });
        if (answer !== "publish") {
            this.ctx.emit("log", { code: "publish-cancelled", params: { target }, text: "Cancelled" });
        }
        return answer === "publish";
    }

    private cancelled(action: string): { summary: string } {
        this.ctx.emit("result", { action, cancelled: true });
        return { summary: "Cancelled" };
    }

    private progress(step: Step): void {
        this.ctx.emit("progress", { step, text: STEP_TEXT[step] });
    }

    private projectName(): string {
        return this.ctx.context.projectName || this.ctx.context.fileName || "penforge-app";
    }

    /** The run's signal as a real AbortSignal. */
    private abortSignal(): AbortSignal {
        const controller = new AbortController();
        if (this.ctx.signal.aborted) {
            controller.abort();
        } else {
            this.ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        return controller.signal;
    }

    /**
     * Emits the `failed` event of an error and returns the error that ends the run (masked).
     */
    private report(error: unknown): Error {
        const mask = this.services.mask;
        const developer = this.ctx.context.persona === "developer";
        if (error instanceof PublishError) {
            const message = mask.mask(error.message);
            this.ctx.emit("failed", {
                code: error.code,
                params: error.params,
                message,
                ...(developer && error.detail ? { detail: mask.mask(error.detail) } : {}),
            });
            return new Error(message);
        }
        const message = mask.mask(error instanceof Error ? error.message : String(error));
        this.ctx.emit("failed", { code: "internal", params: {}, message });
        return new Error(message);
    }
}
