import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import type { AgentContext, WorkflowContext, WorkflowEventKind, WorkflowQuestion } from "@penpot/mcp-common";
import { AgentConfig } from "../AgentConfig";
import type { CommandExecutor } from "../build/CommandExecutor";
import { PenforgeDaemon } from "../PenforgeDaemon";
import { DevServerManager } from "../process/DevServerManager";
import { FakeRunner } from "../runner/FakeRunner";
import { AgentTestClient } from "../testing/AgentTestClient";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { AppArchive } from "./AppArchive";
import { DownloadRegistry } from "./DownloadRegistry";
import { GitHubPublisher } from "./GitHubPublisher";
import type { HttpRequest, HttpResponse, HttpTransport } from "./HttpTransport";
import { NetlifyDeployer } from "./NetlifyDeployer";
import { OpenPublishArgs } from "./OpenPublishTool";
import { PhonePreview } from "./PhonePreview";
import { PublishError, SecretMask } from "./PublishError";
import { PublishRun } from "./PublishRun";
import { PublishRequests, PublishServices } from "./PublishServices";
import { DpapiCipher, OwnerOnlyAccess, PlainCipher, type SecretCipher, SecretStore } from "./SecretStore";
import { StaticSite, StaticSiteBuilder } from "./StaticSite";
import { VercelDeployer } from "./VercelDeployer";

const GITHUB_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const VERCEL_TOKEN = "vercel-token-0123456789abcdef";
const NETLIFY_TOKEN = "nfp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
const ALL_TOKENS = [GITHUB_TOKEN, VERCEL_TOKEN, NETLIFY_TOKEN];

// --- Fakes

type Handler = (request: HttpRequest, url: URL) => { status: number; body?: unknown; headers?: Record<string, string> };

/** Fake provider APIs: routes by `METHOD host/path`, records every request. */
class FakeTransport implements HttpTransport {
    public readonly requests: HttpRequest[] = [];
    private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

    public on(method: string, pattern: RegExp, handler: Handler): this {
        this.routes.push({ method, pattern, handler });
        return this;
    }

    public async send(request: HttpRequest): Promise<HttpResponse> {
        this.requests.push(request);
        const url = new URL(request.url);
        const key = `${url.host}${url.pathname}`;
        const route = this.routes.find((r) => r.method === request.method && r.pattern.test(key));
        if (!route) {
            return { status: 404, headers: {}, body: Buffer.from(JSON.stringify({ message: "Not Found" })) };
        }
        const answer = route.handler(request, url);
        const body = answer.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(answer.body));
        return { status: answer.status, headers: answer.headers ?? {}, body };
    }

    /** Asserts that no token ever went into a URL. */
    public assertNoTokenInUrls(): void {
        for (const sent of this.requests) {
            for (const token of ALL_TOKENS) {
                assert.ok(!sent.url.includes(token), `token in URL ${sent.url}`);
            }
        }
    }
}

/** Access restricter that records the files it restricted (no icacls in tests). */
class RecordingAccess extends OwnerOnlyAccess {
    public readonly restricted: string[] = [];

    public async restrict(path: string): Promise<boolean> {
        this.restricted.push(path);
        if (process.platform !== "win32") {
            await super.restrict(path);
        }
        return true;
    }
}

/** Access restricter that cannot restrict anything. */
class FailingAccess extends OwnerOnlyAccess {
    public async restrict(): Promise<boolean> {
        return false;
    }
}

/** Cipher that scrambles the bytes, standing in for DPAPI. */
class ScrambleCipher implements SecretCipher {
    public readonly kind = "test";

    public async available(): Promise<boolean> {
        return true;
    }

    public async protect(plain: Buffer): Promise<Buffer> {
        return Buffer.from(plain.map((byte) => byte ^ 0x5a));
    }

    public async unprotect(sealed: Buffer): Promise<Buffer> {
        return this.protect(sealed);
    }
}

/** Reads a stream to its end. */
async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
    }
    return Buffer.concat(chunks);
}

/** Site builder that returns fixed files instead of running a build. */
class FakeSiteBuilder extends StaticSiteBuilder {
    public builds = 0;

    public async build(): Promise<StaticSite> {
        this.builds++;
        return new StaticSite("dist", [
            StaticSite.file("index.html", Buffer.from("<!doctype html><title>app</title>")),
            StaticSite.file("assets/app.js", Buffer.from("console.log('app')")),
        ]);
    }
}

/** Command executor that records the commands and writes a `dist/index.html`. */
class RecordingExecutor implements CommandExecutor {
    public readonly commands: string[][] = [];

    public async execute(argv: string[], options: { cwd: string }) {
        this.commands.push(argv);
        if (argv.includes("build")) {
            mkdirSync(join(options.cwd, "dist", "assets"), { recursive: true });
            writeFileSync(join(options.cwd, "dist", "index.html"), "<!doctype html>");
            writeFileSync(join(options.cwd, "dist", "assets", "a.js"), "1");
        }
        return { code: 0, output: "", timedOut: false };
    }
}

// --- Fixtures

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "penforge-publish-"));
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Creates a project with a committed app in `app-src`. */
async function project(id = "project-1"): Promise<ProjectWorkspace> {
    const workspace = new ProjectWorkspace(join(home, "projects"), id);
    await workspace.ensure();
    const app = workspace.appSrcDir;
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "shop", scripts: { build: "vite build" } }));
    writeFileSync(join(app, ".gitignore"), "node_modules/\ndist/\n");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "src", "main.ts"), "export const answer = 42;\n");
    await workspace.commitAll("app-src", "penforge(build): build app");
    await workspace.writeJson("stack.json", {
        name: "vite",
        commands: { install: ["npm", "install"], build: ["npm", "run", "build"], dev: ["npm", "run", "dev"] },
    });
    return workspace;
}

function githubFake(): FakeTransport {
    return new FakeTransport()
        .on("GET", /^api\.github\.com\/user$/, (req) =>
            req.headers.Authorization === `Bearer ${GITHUB_TOKEN}`
                ? { status: 200, body: { login: "octo" } }
                : { status: 401, body: { message: "Bad credentials" } }
        )
        .on("GET", /^api\.github\.com\/repos\/octo\/open$/, () => ({
            status: 200,
            body: {
                name: "open",
                html_url: "https://github.com/octo/open",
                private: false,
                owner: { login: "octo" },
                permissions: { push: true },
            },
        }))
        .on("GET", /^api\.github\.com\/repos\/octo\/existing$/, () => ({
            status: 200,
            body: {
                name: "existing",
                html_url: "https://github.com/octo/existing",
                private: true,
                owner: { login: "octo" },
                permissions: { push: true },
            },
        }))
        .on("POST", /^api\.github\.com\/user\/repos$/, (req) => {
            const body = JSON.parse(String(req.body)) as { name: string; private: boolean };
            if (body.name === "taken") {
                return { status: 422, body: { message: "Repository creation failed." } };
            }
            return {
                status: 201,
                body: {
                    name: body.name,
                    html_url: `https://github.com/octo/${body.name}`,
                    private: body.private,
                    owner: { login: "octo" },
                },
            };
        });
}

function context(persona: AgentContext["persona"] = "designer"): AgentContext {
    return {
        fileId: "file-1",
        fileName: "Landing",
        projectId: "project-1",
        projectName: "My Shop",
        teamId: "team-1",
        pageId: "page-1",
        persona,
        platform: "web",
        mcpSessionId: "tab-1",
    };
}

/** Workflow context that records events and answers questions with `answers`. */
function workflowContext(
    workspace: ProjectWorkspace,
    answers: string[] = [],
    persona: AgentContext["persona"] = "designer"
): WorkflowContext & { events: { kind: WorkflowEventKind; payload: any }[]; questions: WorkflowQuestion[] } {
    const events: { kind: WorkflowEventKind; payload: any }[] = [];
    const questions: WorkflowQuestion[] = [];
    const controller = new AbortController();
    return {
        runId: "run-1",
        context: context(persona),
        workspace,
        tools: { call: () => Promise.reject(new Error("no tools")), list: async () => [] },
        signal: controller.signal,
        emit: (kind: WorkflowEventKind, payload: unknown) => events.push({ kind, payload }),
        ask: async (question: WorkflowQuestion) => {
            questions.push(question);
            return answers.shift() ?? "cancel";
        },
        runner: { run: () => Promise.reject(new Error("no Claude")) },
        events,
        questions,
    } as never;
}

function services(
    transport: HttpTransport,
    parts: { github?: GitHubPublisher; sites?: StaticSiteBuilder; poll?: boolean } = {}
): { services: PublishServices; secrets: SecretStore; downloads: DownloadRegistry; access: RecordingAccess } {
    const access = new RecordingAccess();
    const secrets = new SecretStore(join(home, "secrets.json"), access, new PlainCipher());
    const downloads = new DownloadRegistry();
    const mask = new SecretMask(() => secrets.knownTokens());
    const poll = { intervalMs: 1, timeoutMs: 2000 };
    const result = new PublishServices(
        secrets,
        downloads,
        (id) => `http://127.0.0.1:4410/download/${id}`,
        new DevServerManager(),
        {
            transport,
            github: parts.github,
            sites: parts.sites ?? new FakeSiteBuilder(),
            deployers: {
                vercel: new VercelDeployer(transport, mask, poll),
                netlify: new NetlifyDeployer(transport, mask, poll),
            },
        }
    );
    return { services: result, secrets, downloads, access };
}

function eventText(events: { payload: unknown }[]): string {
    return JSON.stringify(events);
}

// --- SecretStore and masking

test("the secret store keeps tokens in a restricted file and reports logins only", async () => {
    const access = new RecordingAccess();
    const store = new SecretStore(join(home, "secrets.json"), access, new PlainCipher());
    assert.deepEqual(await store.accounts(), []);
    await store.save("github", GITHUB_TOKEN, "octo");
    await store.save("vercel", VERCEL_TOKEN, "octo-v");

    const accounts = await store.accounts();
    assert.deepEqual(
        accounts.map(({ provider, login }) => ({ provider, login })),
        [
            { provider: "github", login: "octo" },
            { provider: "vercel", login: "octo-v" },
        ]
    );
    assert.ok(!JSON.stringify(accounts).includes(GITHUB_TOKEN), "accounts carry no token");
    assert.equal(await store.token("github"), GITHUB_TOKEN);
    assert.equal(access.restricted.length, 2, "every write is restricted before the tokens go in");
    assert.deepEqual(
        readdirSync(home).filter((name) => name.startsWith("secrets")),
        ["secrets.json"],
        "no temporary file is left"
    );
    if (process.platform !== "win32") {
        assert.equal(statSync(join(home, "secrets.json")).mode & 0o777, 0o600);
    }

    // a new store reads the file
    const again = new SecretStore(join(home, "secrets.json"), access, new PlainCipher());
    assert.equal(await again.token("vercel"), VERCEL_TOKEN);
    assert.equal(await again.remove("vercel"), true);
    assert.equal(await again.remove("vercel"), false);
    assert.equal(await again.token("vercel"), null);
    assert.ok(!readFileSync(join(home, "secrets.json"), "utf8").includes(VERCEL_TOKEN));
});

test("an encrypted store writes no token in clear and reads it back", async () => {
    const path = join(home, "secrets.json");
    const store = new SecretStore(path, new RecordingAccess(), new ScrambleCipher());
    await store.save("github", GITHUB_TOKEN, "octo");
    const file = readFileSync(path, "utf8");
    assert.ok(!file.includes(GITHUB_TOKEN) && !file.includes("octo"), "nothing readable in the file");
    assert.equal(JSON.parse(file).protection, "test");
    assert.equal(
        await new SecretStore(path, new RecordingAccess(), new ScrambleCipher()).token("github"),
        GITHUB_TOKEN
    );
});

test("without encryption no token is stored when the file cannot be restricted", async () => {
    const store = new SecretStore(join(home, "secrets.json"), new FailingAccess(), new PlainCipher());
    await assert.rejects(store.save("github", GITHUB_TOKEN, "octo"), /cannot be limited/);
    assert.deepEqual(
        readdirSync(home).filter((name) => name.startsWith("secrets")),
        [],
        "neither the file nor a temporary file holds the token"
    );
    // an encrypted store still saves
    const encrypted = new SecretStore(join(home, "secrets.json"), new FailingAccess(), new ScrambleCipher());
    await encrypted.save("github", GITHUB_TOKEN, "octo");
    assert.equal(await encrypted.token("github"), GITHUB_TOKEN);
});

test("a failed replace removes the temporary file", async () => {
    // a folder in the way makes the final rename fail
    mkdirSync(join(home, "secrets.json", "blocker"), { recursive: true });
    const store = new SecretStore(join(home, "secrets.json"), new RecordingAccess(), new PlainCipher());
    await assert.rejects(store.save("github", GITHUB_TOKEN, "octo"));
    assert.deepEqual(
        readdirSync(home).filter((name) => name.endsWith(".tmp")),
        [],
        "no temporary file with tokens is left"
    );
});

test("connects at the same time keep every account", async () => {
    const store = new SecretStore(join(home, "secrets.json"), new RecordingAccess(), new PlainCipher());
    await Promise.all([
        store.save("github", GITHUB_TOKEN, "octo"),
        store.save("vercel", VERCEL_TOKEN, "octo-v"),
        store.save("netlify", NETLIFY_TOKEN, "me@x.io"),
    ]);
    const again = new SecretStore(join(home, "secrets.json"), new RecordingAccess(), new PlainCipher());
    assert.deepEqual((await again.accounts()).map((a) => a.provider).sort(), ["github", "netlify", "vercel"]);
});

test("DPAPI protects the secrets file on Windows", { skip: process.platform !== "win32" }, async () => {
    const cipher = new DpapiCipher();
    assert.equal(await cipher.available(), true);
    const path = join(home, "secrets.json");
    const store = new SecretStore(path, new OwnerOnlyAccess(), cipher);
    await store.save("github", GITHUB_TOKEN, "octo");
    const file = readFileSync(path, "utf8");
    assert.ok(!file.includes(GITHUB_TOKEN));
    assert.equal(JSON.parse(file).protection, "dpapi");
    assert.equal(await new SecretStore(path).token("github"), GITHUB_TOKEN);
});

test("a broken secrets file is reported without its content", async () => {
    writeFileSync(join(home, "secrets.json"), `{"accounts": ${GITHUB_TOKEN}`);
    const store = new SecretStore(join(home, "secrets.json"), new RecordingAccess());
    await assert.rejects(store.accounts(), (error: Error) => !error.message.includes(GITHUB_TOKEN));
});

test("the secret mask hides stored tokens and token-shaped text", () => {
    const mask = new SecretMask(() => [VERCEL_TOKEN]);
    const text = mask.mask(
        `push https://x-access-token:${GITHUB_TOKEN}@github.com failed; Authorization: Bearer abc.def; ${VERCEL_TOKEN}; ${NETLIFY_TOKEN}`
    );
    for (const token of [...ALL_TOKENS, "abc.def"]) {
        assert.ok(!text.includes(token), `${token} masked in ${text}`);
    }
});

// --- Downloads

test("a download can be taken once and expires", () => {
    let now = 1000;
    const downloads = new DownloadRegistry(5000, () => now);
    const id = downloads.add({ filename: "a.zip", contentType: "application/zip", content: Buffer.from("zip") });
    assert.match(id, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(downloads.take(id)?.filename, "a.zip");
    assert.equal(downloads.take(id), null, "single use");

    const late = downloads.add({ filename: "b.zip", contentType: "application/zip", content: Buffer.from("zip") });
    now += 6000;
    assert.equal(downloads.take(late), null, "expired");
    assert.equal(downloads.take("../../etc/passwd"), null);
});

test("the ZIP holds the last saved version of the app only", async () => {
    const workspace = await project();
    const app = workspace.appSrcDir;
    writeFileSync(join(app, ".env"), "API_KEY=never-in-the-zip\n");
    writeFileSync(join(app, "src", "new.ts"), "export {};\n");
    const statusBefore = git(app, "status", "--porcelain");

    const archive = await AppArchive.ofHead(app, "my-shop");
    assert.equal(archive.commit, git(app, "rev-parse", "HEAD").trim());
    const zip = await readAll(archive.open());
    assert.equal(zip.subarray(0, 2).toString("latin1"), "PK");
    const names = zip.toString("latin1");
    assert.ok(names.includes("my-shop/src/main.ts"));
    assert.ok(!names.includes("my-shop/src/new.ts"), "unsaved files stay out");
    assert.ok(!names.includes("my-shop/.env") && !names.includes("never-in-the-zip"), "no uncommitted .env");
    assert.equal(git(app, "status", "--porcelain"), statusBefore, "index and files unchanged");
});

test("the agent endpoint serves a download once", async () => {
    const config = new AgentConfig({
        home,
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: ["https://localhost:3449"],
        publicUri: "https://localhost:3449",
        runner: "fake",
        mcpUrl: "http://127.0.0.1:1/mcp",
    });
    let registry: DownloadRegistry | undefined;
    let urlOf: ((id: string) => string) | undefined;
    const daemon = new PenforgeDaemon(config, {
        runner: new FakeRunner(),
        tools: null,
        publish: (downloads, downloadUrl) => {
            registry = downloads;
            urlOf = downloadUrl;
            return services(new FakeTransport()).services;
        },
    });
    await daemon.start();
    try {
        const id = registry!.add({
            filename: "my shop.zip",
            contentType: "application/zip",
            content: Buffer.from("PKdata"),
        });
        const url = new URL(urlOf!(id));
        assert.equal(url.host, `127.0.0.1:${daemon.port}`);
        const streamed = registry!.add({
            filename: "s.zip",
            contentType: "application/zip",
            content: () => Readable.from([Buffer.from("PK"), Buffer.from("stream")]),
        });
        assert.equal((await get(daemon.port, new URL(urlOf!(streamed)).pathname)).body, "PKstream");
        const first = await get(daemon.port, url.pathname);
        assert.equal(first.status, 200);
        assert.equal(first.body, "PKdata");
        assert.equal(first.headers["content-disposition"], 'attachment; filename="my_shop.zip"');
        assert.equal(first.headers["cache-control"], "no-store");
        assert.equal((await get(daemon.port, url.pathname)).status, 404, "single use");
    } finally {
        await daemon.stop();
    }
});

function get(port: number, path: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        });
        req.once("error", reject);
        req.end();
    });
}

// --- GitHub

test("GitHub tokens are checked for their format and with GET /user", async () => {
    const transport = githubFake();
    const github = new GitHubPublisher(transport, new SecretMask());
    assert.equal(await github.login(GITHUB_TOKEN), "octo");
    await assert.rejects(github.login("not a token"), (error: PublishError) => error.code === "token-format");
    await assert.rejects(
        github.login("ghp_" + "Z".repeat(36)),
        (error: PublishError) => error.code === "token-invalid" && !error.message.includes("ghp_")
    );
    transport.assertNoTokenInUrls();
});

test("GitHub repositories are found with their visibility or created", async () => {
    const transport = githubFake();
    const github = new GitHubPublisher(transport, new SecretMask());
    const existing = await github.findRepo(GITHUB_TOKEN, "octo", "existing");
    assert.deepEqual({ created: existing?.created, private: existing?.private }, { created: false, private: true });
    assert.equal((await github.findRepo(GITHUB_TOKEN, "octo", "open"))?.private, false);
    assert.equal(await github.findRepo(GITHUB_TOKEN, "octo", "fresh"), null);
    const created = await github.createRepo(GITHUB_TOKEN, "octo", "fresh", false);
    assert.deepEqual(
        { created: created.created, private: created.private, url: created.url },
        { created: true, private: false, url: "https://github.com/octo/fresh" }
    );
    await assert.rejects(
        github.createRepo(GITHUB_TOKEN, "octo", "taken", true),
        (error: PublishError) => error.code === "name-taken"
    );
    assert.equal(GitHubPublisher.repoName("Mein Café / Shop!"), "Mein-Cafe-Shop");
});

test("the push sends HEAD to main from outside app-src and stores no credential", async () => {
    const workspace = await project();
    const app = workspace.appSrcDir;
    // a hook in app-src must not run, whatever it does
    writeFileSync(join(app, ".git", "hooks", "pre-push"), "#!/bin/sh\ntouch hooked\nexit 1\n", { mode: 0o755 });
    const remotes = join(home, "remotes");
    const bare = join(remotes, "octo", "shop.git");
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "--quiet");

    const github = new GitHubPublisher(new FakeTransport(), new SecretMask(), undefined, remotes);
    await github.push(GITHUB_TOKEN, app, { owner: "octo", repo: "shop" });

    const head = git(app, "rev-parse", "HEAD").trim();
    assert.equal(git(bare, "rev-parse", "refs/heads/main").trim(), head);
    assert.ok(!existsSync(join(app, "hooked")), "no hook of app-src ran");
    for (const config of [join(app, ".git", "config"), join(bare, "config")]) {
        assert.ok(!readFileSync(config, "utf8").includes(GITHUB_TOKEN), `${config} holds no token`);
    }
    assert.equal(await github.linkRemote(app, { owner: "octo", repo: "shop" }), true);
    assert.equal(git(app, "remote", "get-url", "origin").trim(), "https://github.com/octo/shop.git");
    assert.equal(await github.linkRemote(app, { owner: "octo", repo: "other" }), false, "an existing origin stays");

    // the remote moved on: the push is refused, not forced
    const other = join(home, "other");
    git(home, "clone", "--quiet", "--branch", "main", bare, other);
    writeFileSync(join(other, "remote.txt"), "x");
    git(other, "add", ".");
    git(other, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "--quiet", "-m", "remote change");
    git(other, "push", "--quiet", "origin", "HEAD:main");
    writeFileSync(join(app, "src", "local.ts"), "export {};\n");
    await workspace.commitAll("app-src", "local change");
    await assert.rejects(
        github.push(GITHUB_TOKEN, app, { owner: "octo", repo: "shop" }),
        (error: PublishError) => error.code === "repo-diverged" && !JSON.stringify(error).includes(GITHUB_TOKEN)
    );
});

// --- Vercel and Netlify

function vercelFake(
    state: "READY" | "ERROR" = "READY",
    projects: Record<string, { id: string; name: string }> = {}
): FakeTransport {
    let polls = 0;
    let name = "";
    return new FakeTransport()
        .on("GET", /^api\.vercel\.com\/v2\/user$/, () => ({ status: 200, body: { user: { username: "octo-v" } } }))
        .on("GET", /^api\.vercel\.com\/v9\/projects\//, (_req, url) => {
            const key = decodeURIComponent(url.pathname.split("/projects/")[1]);
            const project = Object.values(projects).find((p) => p.id === key || p.name === key);
            return project ? { status: 200, body: project } : { status: 404, body: { error: { code: "not_found" } } };
        })
        .on("POST", /^api\.vercel\.com\/v2\/files$/, () => ({ status: 200, body: {} }))
        .on("POST", /^api\.vercel\.com\/v13\/deployments$/, (req) => {
            name = (JSON.parse(String(req.body)) as { name: string }).name;
            projects[name] = { id: `prj_${name}`, name };
            return { status: 200, body: { id: "dpl_1", url: `${name}-abc.vercel.app`, readyState: "QUEUED" } };
        })
        .on("GET", /^api\.vercel\.com\/v13\/deployments\/dpl_1$/, () => {
            polls++;
            return polls < 2
                ? { status: 200, body: { id: "dpl_1", readyState: "BUILDING" } }
                : {
                      status: 200,
                      body: {
                          id: "dpl_1",
                          name,
                          projectId: `prj_${name}`,
                          readyState: state,
                          aliasAssigned: state === "READY",
                          alias: [`${name}.vercel.app`],
                          url: `${name}-abc.vercel.app`,
                          errorMessage: state === "ERROR" ? `boom ${VERCEL_TOKEN}` : undefined,
                      },
                  };
        });
}

test("Vercel deploys upload every file and return the production URL", async () => {
    const transport = vercelFake();
    const deployer = new VercelDeployer(transport, new SecretMask(), { intervalMs: 1, timeoutMs: 2000 });
    const steps: string[] = [];
    const site = await new FakeSiteBuilder().build();
    const plan = await deployer.plan(VERCEL_TOKEN, "My Shop", null, "p1");
    assert.deepEqual(plan, { siteName: "my-shop", existing: false });
    const result = await deployer.deploy(VERCEL_TOKEN, site, plan, (step) => steps.push(step));
    assert.deepEqual(result, {
        url: "https://my-shop.vercel.app",
        deploymentId: "dpl_1",
        siteId: "prj_my-shop",
        siteName: "my-shop",
    });
    assert.deepEqual(steps, ["upload", "deploy"]);
    const uploads = transport.requests.filter((r) => r.url.endsWith("/v2/files"));
    assert.equal(uploads.length, 3, "two site files and the vercel.json fallback");
    const create = transport.requests.find((r) => r.url.includes("/v13/deployments?"))!;
    const body = JSON.parse(String(create.body)) as { name: string; target: string; files: { file: string }[] };
    assert.equal(body.name, "my-shop");
    assert.equal(body.target, "production");
    assert.deepEqual(body.files.map((f) => f.file).sort(), ["assets/app.js", "index.html", "vercel.json"]);
    transport.assertNoTokenInUrls();

    // the next deployment of this project updates the same project
    const next = await deployer.plan(VERCEL_TOKEN, "My Shop", { siteId: "prj_my-shop", siteName: "my-shop" }, "p1");
    assert.deepEqual(next, {
        siteName: "my-shop",
        siteId: "prj_my-shop",
        existing: true,
        url: "https://my-shop.vercel.app",
    });
});

test("Vercel never deploys onto a project the user made elsewhere", async () => {
    const transport = vercelFake("READY", { other: { id: "prj_live", name: "my-shop" } });
    const deployer = new VercelDeployer(transport, new SecretMask(), { intervalMs: 1, timeoutMs: 2000 });
    const plan = await deployer.plan(VERCEL_TOKEN, "My Shop", null, "p1");
    assert.match(plan.siteName, /^my-shop-[0-9a-f]{6}$/);
    assert.equal(plan.existing, false);
    const result = await deployer.deploy(VERCEL_TOKEN, await new FakeSiteBuilder().build(), plan, () => {});
    assert.equal(result.siteName, plan.siteName);

    // a name taken after the confirmation is refused, not deployed onto
    const raced = vercelFake("READY", { other: { id: "prj_live", name: "my-shop" } });
    const racedDeployer = new VercelDeployer(raced, new SecretMask(), { intervalMs: 1, timeoutMs: 2000 });
    await assert.rejects(
        racedDeployer.deploy(
            VERCEL_TOKEN,
            await new FakeSiteBuilder().build(),
            { siteName: "my-shop", existing: false },
            () => {}
        ),
        (error: PublishError) => error.code === "name-taken"
    );
    assert.ok(!raced.requests.some((r) => r.url.includes("/v13/deployments?")), "nothing deployed");
});

test("a failed Vercel deployment is reported without the token", async () => {
    const mask = new SecretMask(() => [VERCEL_TOKEN]);
    const deployer = new VercelDeployer(vercelFake("ERROR"), mask, { intervalMs: 1, timeoutMs: 2000 });
    await assert.rejects(
        deployer.deploy(
            VERCEL_TOKEN,
            await new FakeSiteBuilder().build(),
            { siteName: "my-shop", existing: false },
            () => {}
        ),
        (error: PublishError) =>
            error.code === "deploy-failed" && error.message.includes("boom") && !error.message.includes(VERCEL_TOKEN)
    );
});

test("Netlify deploys skip the user's own site names and upload only required files", async () => {
    let created: string[] = [];
    let uploaded: string[] = [];
    const transport = new FakeTransport()
        .on("GET", /^api\.netlify\.com\/api\/v1\/sites\//, (_req, url) => {
            const key = decodeURIComponent(url.pathname.split("/sites/")[1]);
            return key === "my-shop.netlify.app"
                ? { status: 200, body: { id: "live-site", name: "my-shop" } }
                : { status: 404, body: { message: "Not Found" } };
        })
        .on("POST", /^api\.netlify\.com\/api\/v1\/sites$/, (req) => {
            const { name } = JSON.parse(String(req.body)) as { name: string };
            created = [...created, name];
            return { status: 201, body: { id: "site-1", name, ssl_url: `https://${name}.netlify.app` } };
        })
        .on("POST", /^api\.netlify\.com\/api\/v1\/sites\/site-1\/deploys$/, (req) => {
            const { files } = JSON.parse(String(req.body)) as { files: Record<string, string> };
            assert.deepEqual(Object.keys(files).sort(), ["/_redirects", "/assets/app.js", "/index.html"]);
            return { status: 200, body: { id: "dep-1", required: [files["/index.html"]] } };
        })
        .on("PUT", /^api\.netlify\.com\/api\/v1\/deploys\/dep-1\/files\//, (_req, url) => {
            uploaded = [...uploaded, decodeURIComponent(url.pathname.split("/files/")[1])];
            return { status: 200, body: {} };
        })
        .on("GET", /^api\.netlify\.com\/api\/v1\/deploys\/dep-1$/, () => ({
            status: 200,
            body: { id: "dep-1", state: "ready" },
        }));
    const deployer = new NetlifyDeployer(transport, new SecretMask(), { intervalMs: 1, timeoutMs: 2000 });
    const plan = await deployer.plan(NETLIFY_TOKEN, "My Shop", null, "p1");
    assert.match(plan.siteName, /^my-shop-[0-9a-f]{6}$/, "the user's own my-shop site is left alone");
    const result = await deployer.deploy(NETLIFY_TOKEN, await new FakeSiteBuilder().build(), plan, () => {});
    assert.deepEqual(created, [plan.siteName]);
    assert.equal(result.url, `https://${plan.siteName}.netlify.app`);
    assert.equal(result.siteId, "site-1");
    assert.deepEqual(uploaded, ["index.html"]);
    assert.ok(!transport.requests.some((r) => r.url.includes("live-site/deploys")), "the live site is untouched");
    transport.assertNoTokenInUrls();
});

test("the static site builder runs the stack commands and reads the output folder", async () => {
    const workspace = await project();
    const executor = new RecordingExecutor();
    const steps: string[] = [];
    const site = await new StaticSiteBuilder(executor).build(workspace, undefined, (step) => steps.push(step));
    assert.deepEqual(executor.commands, [
        ["npm", "install"],
        ["npm", "run", "build"],
    ]);
    assert.deepEqual(steps, ["install", "build"]);
    assert.equal(site.folder, "dist");
    assert.deepEqual(
        site.files.map((file) => file.path),
        ["assets/a.js", "index.html"]
    );
});

// --- The workflow

test("connect checks and stores a token; no event carries it", async () => {
    const workspace = await project();
    const { services: s, secrets } = services(githubFake());
    const ctx = workflowContext(workspace);
    await new PublishRun(ctx, s).run({ action: "connect", provider: "github", token: ` ${GITHUB_TOKEN} ` });
    assert.equal(await secrets.token("github"), GITHUB_TOKEN, "trimmed and stored");
    const result = ctx.events.find((e) => e.kind === "result")!.payload;
    assert.equal(result.account.login, "octo");
    assert.ok(!eventText(ctx.events).includes(GITHUB_TOKEN));

    const status = workflowContext(workspace);
    PublishRequests.shared.record("tab-1", "github");
    await new PublishRun(status, s).run({ action: "status" });
    const payload = status.events.find((e) => e.kind === "result")!.payload;
    assert.deepEqual(
        payload.accounts.map((a: { login: string }) => a.login),
        ["octo"]
    );
    assert.deepEqual(payload.app, { exists: true, phone: false });
    assert.equal(payload.requested, "github", "the chat's request is handed over once");
    assert.ok(!eventText(status.events).includes(GITHUB_TOKEN));
});

test("a refused token ends the run with a failed event, masked", async () => {
    const workspace = await project();
    const { services: s, secrets } = services(githubFake());
    const ctx = workflowContext(workspace, [], "developer");
    const bad = "ghp_" + "Q".repeat(36);
    await assert.rejects(
        new PublishRun(ctx, s).run({ action: "connect", provider: "github", token: bad }),
        (error: Error) => !error.message.includes(bad)
    );
    const failed = ctx.events.find((e) => e.kind === "failed")!.payload;
    assert.equal(failed.code, "token-invalid");
    assert.ok(!eventText(ctx.events).includes(bad));
    assert.equal(await secrets.token("github"), null);

    // invalid params never echo the token
    await assert.rejects(
        new PublishRun(workflowContext(workspace), s).run({ action: "connect", provider: "gitlab", token: bad }),
        (error: Error) => !error.message.includes(bad)
    );
});

test("zip makes a single-use download", async () => {
    const workspace = await project();
    const { services: s, downloads } = services(new FakeTransport());
    const ctx = workflowContext(workspace);
    await new PublishRun(ctx, s).run({ action: "zip" });
    const result = ctx.events.find((e) => e.kind === "result")!.payload;
    assert.equal(result.filename, "My-Shop.zip");
    assert.match(result.url, /^http:\/\/127\.0\.0\.1:4410\/download\/[A-Za-z0-9_-]{43}$/);
    const id = result.url.split("/").pop();
    const content = downloads.take(id)?.content;
    assert.equal(typeof content, "function", "streamed when downloaded");
    const zip = await readAll((content as () => NodeJS.ReadableStream)());
    assert.equal(zip.subarray(0, 2).toString("latin1"), "PK");
});

test("GitHub publishing asks first, and asks again for a public repository", async () => {
    const workspace = await project();
    const remotes = join(home, "remotes");
    mkdirSync(join(remotes, "octo", "My-Shop.git"), { recursive: true });
    git(join(remotes, "octo", "My-Shop.git"), "init", "--bare", "--quiet");
    const transport = githubFake();
    const github = new GitHubPublisher(transport, new SecretMask(), undefined, remotes);
    const { services: s, secrets } = services(transport, { github });
    await secrets.save("github", GITHUB_TOKEN, "octo");

    const cancelled = workflowContext(workspace, ["cancel"]);
    await new PublishRun(cancelled, s).run({ action: "github" });
    assert.equal(cancelled.questions.length, 1);
    assert.match(cancelled.questions[0].text, /private GitHub repository octo\/My-Shop \(new\)/);
    assert.equal(cancelled.events.find((e) => e.kind === "result")!.payload.cancelled, true);

    const declinedPublic = workflowContext(workspace, ["publish", "cancel"]);
    await new PublishRun(declinedPublic, s).run({ action: "github", private: false });
    assert.equal(declinedPublic.questions.length, 2);
    assert.match(declinedPublic.questions[0].text, /public GitHub repository/);
    assert.match(declinedPublic.questions[1].text, /public/);
    assert.ok(
        !transport.requests.some((r) => r.method === "POST" && r.url.endsWith("/user/repos")),
        "no repository made"
    );

    // an existing public repository asks again, even when the client asked for a private one
    const existingPublic = workflowContext(workspace, ["cancel"]);
    await new PublishRun(existingPublic, s).run({ action: "github", name: "open", private: true, confirmed: true });
    assert.equal(existingPublic.questions.length, 1);
    assert.match(existingPublic.questions[0].text, /octo\/open is public/);

    const plan = workflowContext(workspace);
    await new PublishRun(plan, s).run({ action: "plan", target: "github", name: "open" });
    assert.deepEqual(
        (({ fullName, exists, private: isPrivate }) => ({ fullName, exists, isPrivate }))(
            plan.events.find((e) => e.kind === "result")!.payload
        ),
        { fullName: "octo/open", exists: true, isPrivate: false }
    );

    const ctx = workflowContext(workspace);
    await new PublishRun(ctx, s).run({ action: "github", confirmed: true });
    assert.equal(ctx.questions.length, 0);
    const result = ctx.events.find((e) => e.kind === "result")!.payload;
    assert.equal(result.url, "https://github.com/octo/My-Shop");
    assert.equal(result.private, true);
    assert.deepEqual(
        ctx.events.filter((e) => e.kind === "progress").map((e) => e.payload.step),
        ["save", "repo", "push"]
    );
    const record = await workspace.readJson<{ github?: { repo: string } }>("publish.json", {});
    assert.equal(record.github?.repo, "My-Shop");
    assert.ok(!readFileSync(join(workspace.metaDir, "publish.json"), "utf8").includes(GITHUB_TOKEN));
    assert.ok(!eventText(ctx.events).includes(GITHUB_TOKEN));
});

test("deploying needs a connected account, a named confirmation, and reuses the site", async () => {
    const workspace = await project();
    const transport = vercelFake("READY", { live: { id: "prj_live", name: "my-shop" } });
    const sites = new FakeSiteBuilder();
    const { services: s, secrets } = services(transport, { sites });

    const notConnected = workflowContext(workspace);
    await assert.rejects(new PublishRun(notConnected, s).run({ action: "vercel", confirmed: true }));
    assert.equal(notConnected.events.find((e) => e.kind === "failed")!.payload.code, "not-connected");

    await secrets.save("vercel", VERCEL_TOKEN, "octo-v");
    const planCtx = workflowContext(workspace);
    await new PublishRun(planCtx, s).run({ action: "plan", target: "vercel" });
    const plan = planCtx.events.find((e) => e.kind === "result")!.payload;
    assert.match(plan.siteName, /^my-shop-[0-9a-f]{6}$/);
    assert.equal(plan.existing, false);

    // a confirmation without the site name is asked again, naming the site
    const unnamed = workflowContext(workspace, ["cancel"]);
    await new PublishRun(unnamed, s).run({ action: "vercel", confirmed: true });
    assert.ok(unnamed.questions[0].text.includes("new site my-shop-"));
    assert.equal(sites.builds, 0);

    const ctx = workflowContext(workspace);
    await new PublishRun(ctx, s).run({ action: "vercel", confirmed: true, siteName: plan.siteName });
    assert.equal(ctx.questions.length, 0);
    assert.equal(ctx.events.find((e) => e.kind === "result")!.payload.url, `https://${plan.siteName}.vercel.app`);
    const record = await workspace.readJson<{ vercel?: { siteName: string; siteId: string } }>("publish.json", {});
    assert.equal(record.vercel?.siteName, plan.siteName);
    assert.equal(sites.builds, 1);

    const again = workflowContext(workspace);
    await new PublishRun(again, s).run({ action: "plan", target: "vercel" });
    const second = again.events.find((e) => e.kind === "result")!.payload;
    assert.deepEqual([second.siteName, second.existing], [plan.siteName, true]);

    // a name that no longer matches the plan is refused
    const stale = workflowContext(workspace);
    await assert.rejects(new PublishRun(stale, s).run({ action: "vercel", confirmed: true, siteName: "my-shop" }));
    assert.equal(stale.events.find((e) => e.kind === "failed")!.payload.code, "name-taken");
});

test("the phone preview asks first and is refused for stacks without one", async () => {
    const workspace = await project();
    const { services: s } = services(new FakeTransport());
    const declined = workflowContext(workspace, ["cancel"]);
    await new PublishRun(declined, s).run({ action: "phone" });
    assert.match(declined.questions[0].text, /local network/);

    const ctx = workflowContext(workspace);
    await assert.rejects(new PublishRun(ctx, s).run({ action: "phone", confirmed: true }));
    assert.equal(ctx.events.find((e) => e.kind === "failed")!.payload.code, "no-phone-preview");
});

test("the phone preview opens the dev server to the network while it runs", async () => {
    const workspace = await project();
    await workspace.writeJson("stack.json", {
        name: "expo",
        commands: { dev: ["npx", "expo", "start", "--web", "--host", "localhost", "--port", "{port}"] },
    });
    const calls: unknown[] = [];
    let exposure: { mode: string; host?: string } | undefined = { mode: "loopback" };
    const fakeManager = {
        watch: () => ({ dispose: () => calls.push("dispose") }),
        start: async (_ws: unknown, options: { exposure: { mode: string; host?: string } }) => {
            calls.push(options.exposure);
            exposure = options.exposure;
            return { state: "ready", url: "http://localhost:5207/", restarts: 0 };
        },
        exposureOf: () => exposure,
    } as unknown as DevServerManager;
    const network = { lanAddress: async () => "192.168.1.50" } as never;
    const phone = new PhonePreview(fakeManager, network);
    const stop = new AbortController();
    const sessions: { url: string; qr: { size: number; rows: string[] } }[] = [];
    await phone.run(workspace, stop.signal, (session) => {
        sessions.push(session);
        stop.abort();
    });
    assert.equal(sessions[0].url, "exp://192.168.1.50:5207");
    assert.equal(sessions[0].qr.rows.length, sessions[0].qr.size);
    assert.ok(sessions[0].qr.rows.every((row) => /^[01]+$/.test(row) && row.length === sessions[0].qr.size));
    assert.deepEqual(calls, [{ mode: "lan", host: "192.168.1.50" }, "dispose", { mode: "loopback" }]);
});

test("the chat tool records the publish request of its tab", () => {
    assert.ok(OpenPublishArgs.schema.target.safeParse("github").success);
    assert.ok(!OpenPublishArgs.schema.target.safeParse("ftp").success);
    PublishRequests.shared.record("tab-9", "netlify");
    assert.equal(PublishRequests.shared.take("tab-9"), "netlify");
    assert.equal(PublishRequests.shared.take("tab-9"), null);
});

test("the publish workflow runs over the agent socket", async () => {
    const config = new AgentConfig({
        home,
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: ["https://localhost:3449"],
        publicUri: "https://localhost:3449",
        runner: "fake",
        mcpUrl: "http://127.0.0.1:1/mcp",
    });
    const daemon = new PenforgeDaemon(config, {
        runner: new FakeRunner(),
        tools: null,
        publish: (downloads, downloadUrl) =>
            new PublishServices(
                new SecretStore(join(home, "secrets.json"), new RecordingAccess()),
                downloads,
                downloadUrl,
                new DevServerManager(),
                {
                    transport: githubFake(),
                }
            ),
    });
    await daemon.start();
    const client = await AgentTestClient.connect(`ws://127.0.0.1:${daemon.port}/agent`, "https://localhost:3449");
    try {
        client.send({ type: "auth", token: "" });
        await client.next("auth.ok");
        client.send({ ...context(), type: "context.set", projectId: "project-ws" });
        client.send({
            type: "workflow.run",
            rid: "p1",
            name: "publish",
            params: { action: "connect", provider: "github", token: GITHUB_TOKEN },
        });
        const done = await client.next("workflow.done");
        assert.equal(done.ok, true);
        const seen = JSON.stringify(client.drain());
        assert.ok(!seen.includes(GITHUB_TOKEN), "nothing sent back holds the token");
        assert.ok(existsSync(join(home, "secrets.json")));
        assert.ok(!existsSync(join(home, "projects", "project-ws", "secrets.json")));
    } finally {
        client.close();
        await daemon.stop();
    }
});
