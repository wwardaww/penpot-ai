import { spawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ChildEnvironment } from "../build/ChildEnvironment";
import type { HttpTransport } from "./HttpTransport";
import { ProviderApi } from "./ProviderApi";
import { PublishError, SecretMask } from "./PublishError";

/** GitHub repository Penforge pushes to. */
export interface GitHubRepo {
    owner: string;
    repo: string;
    /** web URL, `https://github.com/<owner>/<repo>` */
    url: string;
    private: boolean;
    /** whether the repository was created by this call */
    created: boolean;
}

/** Outcome of a git command. */
interface GitOutcome {
    code: number | null;
    stderr: string;
}

/**
 * Runner of git commands (a strategy, so tests can push to a local bare repository).
 */
export interface GitRunner {
    /**
     * Runs git without a shell.
     *
     * @param args - arguments after `git`
     * @param cwd - working directory
     * @param env - full environment of the process
     */
    run(args: string[], cwd: string, env: Record<string, string>): Promise<GitOutcome>;
}

/** Git runner spawning the `git` program. */
export class ProcessGitRunner implements GitRunner {
    public run(args: string[], cwd: string, env: Record<string, string>): Promise<GitOutcome> {
        return new Promise((resolve, reject) => {
            const child = spawn("git", args, {
                cwd,
                env,
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "ignore", "pipe"],
            });
            let stderr = "";
            child.stderr?.on("data", (chunk: Buffer) => {
                stderr = (stderr + chunk.toString("utf8")).slice(-16_000);
            });
            child.once("error", reject);
            child.once("close", (code) => resolve({ code, stderr }));
        });
    }
}

/**
 * Publisher of a project's `app-src` repository to GitHub.
 *
 * Checks tokens (`GET /user`), creates the repository when it does not exist, and pushes the
 * app's `HEAD` to its `main` branch. The push never runs in `app-src` itself, whose git config
 * and hooks Claude can write: the commits are fetched into a new bare repository in a private
 * temporary folder, with system and global git config switched off and hooks disabled, and pushed
 * from there. The token reaches git only through environment config
 * (`http.https://github.com/.extraHeader`, scoped to GitHub), never through a URL, a command
 * argument or a config file, and stored credential helpers are switched off.
 */
export class GitHubPublisher {
    /** Name of the provider in messages. */
    public static readonly PROVIDER = "GitHub";
    private static readonly WEB = "https://github.com";
    private static readonly NAME = /^[A-Za-z0-9._-]{1,100}$/;
    private static readonly TOKEN = /^(?:gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;
    private static readonly BRANCH = "main";

    /**
     * @param transport - sends API requests
     * @param mask - removes secrets from texts
     * @param git - runs git
     * @param webBase - GitHub web URL (a local folder in tests)
     */
    constructor(
        private readonly transport: HttpTransport,
        private readonly mask: SecretMask,
        private readonly git: GitRunner = new ProcessGitRunner(),
        private readonly webBase: string = GitHubPublisher.WEB
    ) {}

    /**
     * Checks a token and gets the account's login.
     *
     * @param token - a classic or fine-grained personal access token
     * @throws PublishError `token-format`, `token-invalid`, …
     */
    public async login(token: string): Promise<string> {
        if (!GitHubPublisher.TOKEN.test(token)) {
            throw new PublishError("token-format", "This is not a GitHub personal access token", {
                provider: GitHubPublisher.PROVIDER,
            });
        }
        const answer = await this.api(token).call<{ login?: unknown }>("GET", "/user");
        if (typeof answer.data?.login !== "string") {
            throw new PublishError("provider", "GitHub did not name the account", {
                provider: GitHubPublisher.PROVIDER,
            });
        }
        return answer.data.login;
    }

    /**
     * Turns a project name into a valid repository name.
     *
     * @param name - any name
     */
    public static repoName(name: string): string {
        const slug = name
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^A-Za-z0-9._-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^[-.]+|[-.]+$/g, "")
            .slice(0, 100);
        return slug.length > 0 ? slug : "penforge-app";
    }

    /**
     * Finds one of the user's repositories, with its visibility.
     *
     * @param token - the token
     * @param login - the account login
     * @param name - repository name (see {@link repoName})
     * @returns the repository (`created: false`), or null when it does not exist
     * @throws PublishError `token-scope` when the token may not push to it
     */
    public async findRepo(token: string, login: string, name: string): Promise<GitHubRepo | null> {
        GitHubPublisher.checkName(name);
        const path = `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}`;
        const existing = await this.api(token).call<RepoAnswer>("GET", path, undefined, { accept: [404] });
        if (existing.status === 404) {
            return null;
        }
        if (existing.data?.permissions && existing.data.permissions.push === false) {
            throw new PublishError("token-scope", `The token may not push to ${login}/${name}`, {
                provider: GitHubPublisher.PROVIDER,
            });
        }
        return this.repo(existing.data, login, name, false);
    }

    /**
     * Creates a repository in the user's account.
     *
     * @param token - the token
     * @param login - the account login
     * @param name - repository name (see {@link repoName})
     * @param isPrivate - visibility
     * @throws PublishError `name-taken` when GitHub refuses the name
     */
    public async createRepo(token: string, login: string, name: string, isPrivate: boolean): Promise<GitHubRepo> {
        GitHubPublisher.checkName(name);
        const api = this.api(token);
        const created = await api.call<RepoAnswer>(
            "POST",
            "/user/repos",
            { name, private: isPrivate, auto_init: false, description: "App generated with Penforge" },
            { accept: [422] }
        );
        if (created.status === 422) {
            throw new PublishError("name-taken", `GitHub refused the name ${name}: ${api.errorText(created.data)}`, {
                provider: GitHubPublisher.PROVIDER,
                name,
            });
        }
        return this.repo(created.data, login, name, true);
    }

    /**
     * Pushes the `HEAD` commit of a repository to the GitHub repository's `main` branch.
     *
     * @param token - the token
     * @param sourceDir - the local repository (`app-src`)
     * @param repo - the target repository
     * @param baseEnv - environment the git environment is derived from
     * @throws PublishError `repo-diverged` when GitHub has commits the app lacks
     */
    public async push(
        token: string,
        sourceDir: string,
        repo: Pick<GitHubRepo, "owner" | "repo">,
        baseEnv: NodeJS.ProcessEnv = process.env
    ): Promise<void> {
        const scratch = await mkdtemp(join(tmpdir(), "penforge-push-"));
        try {
            const bare = join(scratch, "repo.git");
            const emptyConfig = join(scratch, "gitconfig");
            const noHooks = join(scratch, "no-hooks");
            await writeFile(emptyConfig, "", { mode: 0o600 });
            const plain = GitHubPublisher.gitEnv(baseEnv, emptyConfig);
            const hooksOff = ["-c", `core.hooksPath=${noHooks}`];
            await this.expect(["init", "--bare", "--quiet", bare], scratch, plain, "init");
            await this.expect(
                [
                    ...hooksOff,
                    `--git-dir=${bare}`,
                    "fetch",
                    "--quiet",
                    "--no-tags",
                    sourceDir,
                    `+HEAD:refs/heads/${GitHubPublisher.BRANCH}`,
                ],
                scratch,
                plain,
                "fetch"
            );
            const remote = `${this.webBase}/${repo.owner}/${repo.repo}.git`;
            const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
            const withToken = {
                ...plain,
                GIT_CONFIG_COUNT: "2",
                GIT_CONFIG_KEY_0: `http.${GitHubPublisher.WEB}/.extraHeader`,
                GIT_CONFIG_VALUE_0: header,
                // no stored helper may answer, keep or ask for credentials
                GIT_CONFIG_KEY_1: "credential.helper",
                GIT_CONFIG_VALUE_1: "",
            };
            const pushed = await this.git.run(
                [
                    ...hooksOff,
                    `--git-dir=${bare}`,
                    "push",
                    "--porcelain",
                    "--no-verify",
                    remote,
                    `refs/heads/${GitHubPublisher.BRANCH}:refs/heads/${GitHubPublisher.BRANCH}`,
                ],
                scratch,
                withToken
            );
            if (pushed.code !== 0) {
                throw this.pushFailure(pushed.stderr, token);
            }
        } finally {
            await rm(scratch, { recursive: true, force: true });
        }
    }

    /**
     * Gets the commit of a repository's `HEAD`.
     *
     * @param sourceDir - the repository
     * @returns the commit id, or null when there is none
     */
    public async head(sourceDir: string): Promise<string | null> {
        const outcome = await this.gitOutput(["rev-parse", "--verify", "--quiet", "HEAD"], sourceDir);
        return outcome.code === 0 && /^[0-9a-f]{40,64}$/.test(outcome.stdout.trim()) ? outcome.stdout.trim() : null;
    }

    /**
     * Adds the GitHub repository as remote `origin` of the app, without any credential, when
     * the app has no `origin` yet.
     *
     * @param sourceDir - the app repository
     * @param repo - the GitHub repository
     * @returns whether the remote was added
     */
    public async linkRemote(sourceDir: string, repo: Pick<GitHubRepo, "owner" | "repo">): Promise<boolean> {
        const existing = await this.gitOutput(["remote", "get-url", "origin"], sourceDir);
        if (existing.code === 0) {
            return false;
        }
        const added = await this.gitOutput(
            ["remote", "add", "origin", `${GitHubPublisher.WEB}/${repo.owner}/${repo.repo}.git`],
            sourceDir
        );
        return added.code === 0;
    }

    private gitOutput(args: string[], cwd: string): Promise<{ code: number | null; stdout: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn("git", args, {
                cwd,
                env: ChildEnvironment.scrub(process.env, { GIT_TERMINAL_PROMPT: "0" }),
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "ignore"],
            });
            let stdout = "";
            child.stdout?.on("data", (chunk: Buffer) => {
                stdout += chunk.toString("utf8");
            });
            child.once("error", reject);
            child.once("close", (code) => resolve({ code, stdout }));
        });
    }

    private static checkName(name: string): void {
        if (!GitHubPublisher.NAME.test(name) || name === "." || name === "..") {
            throw new PublishError("provider", `Invalid repository name ${JSON.stringify(name)}`, {
                provider: GitHubPublisher.PROVIDER,
            });
        }
    }

    private async expect(args: string[], cwd: string, env: Record<string, string>, step: string): Promise<void> {
        const outcome = await this.git.run(args, cwd, env);
        if (outcome.code !== 0) {
            throw new PublishError(
                "provider",
                `git ${step} failed`,
                { provider: GitHubPublisher.PROVIDER },
                this.mask.mask(outcome.stderr).slice(-2000)
            );
        }
    }

    private pushFailure(stderr: string, token: string): PublishError {
        const text = new SecretMask(() => [token]).mask(this.mask.mask(stderr)).slice(-2000);
        const params = { provider: GitHubPublisher.PROVIDER };
        if (/non-fast-forward|fetch first|\[rejected\]|rejected/i.test(text)) {
            return new PublishError(
                "repo-diverged",
                "The GitHub repository has changes the app does not have",
                params,
                text
            );
        }
        if (/\b403\b|permission|denied to/i.test(text)) {
            return new PublishError("token-scope", "The GitHub token may not push to this repository", params, text);
        }
        if (/\b401\b|authentication failed|invalid username or password|could not read Username/i.test(text)) {
            return new PublishError("token-invalid", "GitHub refused the token", params, text);
        }
        if (/could not resolve host|unable to access|timed out|connection/i.test(text)) {
            return new PublishError("network", "GitHub cannot be reached", params, text);
        }
        return new PublishError("provider", "git push failed", params, text);
    }

    private repo(data: RepoAnswer | null, login: string, name: string, created: boolean): GitHubRepo {
        const owner = typeof data?.owner?.login === "string" ? data.owner.login : login;
        const repo = typeof data?.name === "string" ? data.name : name;
        return {
            owner,
            repo,
            url: typeof data?.html_url === "string" ? data.html_url : `${GitHubPublisher.WEB}/${owner}/${repo}`,
            private: data?.private === true,
            created,
        };
    }

    private api(token: string): ProviderApi {
        return new GitHubApi(this.transport, token, this.mask);
    }

    /**
     * Builds the environment of git: the scrubbed child environment (no secrets of the daemon),
     * the user's proxy settings, no system or global config, and no prompts.
     */
    private static gitEnv(baseEnv: NodeJS.ProcessEnv, emptyConfig: string): Record<string, string> {
        const proxies: Record<string, string> = {};
        for (const [name, value] of Object.entries(baseEnv)) {
            if (value !== undefined && /^(https?_proxy|no_proxy)$/i.test(name) && !/@/.test(value)) {
                proxies[name] = value;
            }
        }
        return ChildEnvironment.scrub(baseEnv, {
            ...proxies,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: emptyConfig,
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "never",
            GIT_ASKPASS: "",
            SSH_ASKPASS: "",
        });
    }
}

/** Repository fields of the GitHub API used here. */
interface RepoAnswer {
    name?: string;
    html_url?: string;
    private?: boolean;
    owner?: { login?: string };
    permissions?: { push?: boolean };
}

/** GitHub REST API client. */
class GitHubApi extends ProviderApi {
    public static readonly BASE = "https://api.github.com";

    constructor(transport: HttpTransport, token: string, mask: SecretMask) {
        super(GitHubPublisher.PROVIDER, GitHubApi.BASE, token, transport, mask, "Bearer", {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        });
    }
}
