import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentContext, AppInfo } from "@penpot/mcp-common";
import { AgentConfig } from "../AgentConfig";
import { PenforgeDaemon } from "../PenforgeDaemon";
import { RedesignBranch } from "../linked/RedesignBranch";
import { CommandPolicy } from "../process/CommandPolicy";
import { DevServerManager } from "../process/DevServerManager";
import { PortPool } from "../process/PortPool";
import { FakeRunner } from "../runner/FakeRunner";
import { AgentTestClient } from "../testing/AgentTestClient";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { WorkspaceManager } from "../workspace/WorkspaceManager";
import { AppCatalog } from "./AppCatalog";
import { AppFolders } from "./AppFolders";
import { LinkedAppStack } from "./LinkedAppStack";
import { RedesignedApps } from "./RedesignedApps";

const FAKE_SERVER = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "process",
    "testing",
    "fakeDevServer.mjs"
).replace(/\\/g, "/");
const ORIGIN = "https://localhost:3449";
const PROJECT = "a3de49e3-507f-8040-8008-fb2d0ea52a89";
const FILE = "a3de49e3-507f-8040-8008-fb2d12ed0541";
const TEAM = "a3de49e3-507f-8040-8008-fb2cd62f76d4";
const BRANCH = "penforge/redesign-20261122-0142";
const FIRST_PORT = 47480;

let base: string;
let home: string;
let mono: string;

function writeTree(root: string, files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
        const file = join(root, ...path.split("/"));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
    }
}

function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
}

function commit(root: string, message: string): string {
    git(root, "add", "-A");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", message);
    return git(root, "rev-parse", "HEAD");
}

/**
 * Fake monorepo like the user's: no root package.json, a Next.js landing, a Vite web app, a shared
 * UI library without scripts. The user works on branch `ai`.
 */
function monorepo(root: string, landingDev = "next dev -p 3002"): string {
    writeTree(root, {
        "README.md": "# Adissio",
        "landing/package.json": JSON.stringify({
            name: "adissio-landing",
            scripts: { dev: landingDev, build: "next build" },
            dependencies: { next: "^15.2.0", react: "^19.0.0" },
        }),
        "landing/package-lock.json": "{}",
        "landing/app/page.tsx": "export default function Page() { return <main>Old</main>; }",
        "landing/app/globals.css": "body { color: black; }",
        "landing/components/StickyNavbar.tsx": "export const Nav = () => <nav />;",
        "web/package.json": JSON.stringify({
            name: "web",
            scripts: { dev: "vite" },
            dependencies: { vue: "^3.5.0" },
            devDependencies: { vite: "^6.0.0" },
        }),
        "web/src/App.vue": "<template><main /></template>",
        "packages/ui/package.json": JSON.stringify({ name: "ui", dependencies: { react: "^19.0.0" } }),
        "packages/ui/src/Button.tsx": "export const Button = () => <button />;",
        ".gitignore": "node_modules/\n",
    });
    git(root, "init", "-q", "-b", "ai");
    return commit(root, "initial");
}

/** Re-Design branch with changes, then back on the user's branch when `stayOnBranch` is false. */
function redesignBranch(root: string, files: Record<string, string>, stayOnBranch: boolean): string {
    git(root, "switch", "-q", "-c", BRANCH);
    writeTree(root, files);
    const head = commit(root, "penforge(redesign): apply the new look from Penpot");
    if (!stayOnBranch) {
        git(root, "switch", "-q", "ai");
    }
    return head;
}

function projectDir(...parts: string[]): string {
    return join(home, "projects", PROJECT, ...parts);
}

function writeJson(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
}

/** `project.json` and the pre-W39 `redesign.json` the user has. */
function linkedProject(baseCommit: string, extra: Record<string, unknown> = {}, record: Record<string, unknown> = {}) {
    writeJson(projectDir(".penforge", "project.json"), {
        projectId: PROJECT,
        projectName: "Adissio",
        teamId: TEAM,
        platform: "existing",
        persona: "designer",
        fileIds: [FILE],
        linkedRoot: mono,
        linkedKind: "existing",
        engine: null,
        stack: null,
        linkedAt: "2026-11-21T21:15:12.666Z",
        ...extra,
    });
    writeJson(projectDir(".penforge", "redesign.json"), {
        kind: "existing",
        root: mono,
        branch: BRANCH,
        baseBranch: "ai",
        baseCommit,
        createdAt: "2026-11-21T22:42:18.266Z",
        updatedAt: "2026-11-21T22:42:18.266Z",
        ...record,
    });
}

function context(fileName: string): AgentContext {
    return {
        fileId: FILE,
        fileName,
        projectId: PROJECT,
        projectName: "Adissio",
        teamId: TEAM,
        pageId: "page-1",
        persona: "designer",
        platform: "web",
        projectType: "existing",
    };
}

/** What a read-only listing must leave as it was: branch, head, index and status. */
function gitSnapshot(root: string): string {
    return [
        git(root, "branch", "--show-current"),
        git(root, "rev-parse", "HEAD"),
        git(root, "--no-optional-locks", "status", "--porcelain"),
        statSync(join(root, ".git", "index")).mtimeMs,
        git(root, "branch", "--list"),
    ].join("\n");
}

beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "penforge-redesigned-")));
    home = join(base, "Penforge");
    mono = join(base, "adissio");
    mkdirSync(join(home, "projects"), { recursive: true });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe("Re-Designed apps in the catalog", () => {
    test("an old redesign.json lists the landing under its project, named after the file once known", async () => {
        const baseCommit = monorepo(mono);
        redesignBranch(
            mono,
            {
                "landing/app/page.tsx": "export default function Page() { return <main>New</main>; }",
                "landing/app/globals.css": "body { color: #102030; }",
                "landing/components/StickyNavbar.tsx": "export const Nav = () => <nav className='glass' />;",
                // a library change belongs to no app
                "packages/ui/src/Button.tsx": "export const Button = () => <button className='pill' />;",
            },
            true
        );
        linkedProject(baseCommit);
        const before = gitSnapshot(mono);
        const catalog = new AppCatalog(join(home, "projects"));

        const [app, ...rest] = await catalog.list(TEAM);
        assert.equal(rest.length, 0, "one app: the landing");
        assert.equal(app.name, "landing", "no file name known yet: the folder name");
        assert.equal(app.projectName, "Adissio");
        assert.equal(app.projectId, PROJECT);
        assert.equal(app.fileId, FILE);
        assert.equal(app.fileName, null);
        assert.match(app.appId, new RegExp(`^${PROJECT}~[0-9a-f]{8}$`));
        assert.equal(app.platform, "web");
        assert.deepEqual(app.stack, { name: "next", version: "15.2.0" });
        assert.equal(app.appPath, join(mono, "landing"));
        assert.equal(app.builtAt, null);
        assert.deepEqual(app.redesign, {
            branch: BRANCH,
            baseBranch: "ai",
            currentBranch: BRANCH,
            root: mono,
            appDir: "landing",
            installed: false,
            runnable: true,
            source: "changes",
            updatedAt: "2026-11-21T22:42:18.266Z",
        });
        assert.equal(gitSnapshot(mono), before, "listing changes nothing in the repository");

        // a tab of the file opens: its name is stored and used from then on
        const workspaces = new WorkspaceManager(join(home, "projects"));
        await workspaces.open(context("adissio landing"));
        const stored = JSON.parse(readFileSync(projectDir(".penforge", "project.json"), "utf8"));
        assert.deepEqual(stored.fileNames, { [FILE]: "adissio landing" });
        assert.equal(stored.linkedRoot, mono, "the link stays");
        mkdirSync(join(mono, "landing", "node_modules"));
        const [named] = await catalog.list();
        assert.equal(named.name, "adissio landing");
        assert.equal(named.fileName, "adissio landing");
        assert.equal(named.appId, app.appId, "the app id does not depend on the name");
        assert.equal(named.redesign?.installed, true);
        assert.equal((await catalog.findApp(app.appId))?.name, "adissio landing");
        assert.equal(gitSnapshot(mono), before);
    });

    test("changes in two apps give two apps, most changed first; the user's own branch is reported", async () => {
        const baseCommit = monorepo(mono);
        redesignBranch(
            mono,
            {
                "web/src/App.vue": "<template><main class='new' /></template>",
                "landing/app/page.tsx": "new",
                "landing/app/globals.css": "new",
            },
            false
        );
        linkedProject(baseCommit, { fileNames: { [FILE]: "adissio" } });
        const apps = await new AppCatalog(join(home, "projects")).list();
        assert.deepEqual(
            apps.map((app) => [app.name, app.redesign?.appDir, app.stack.name]),
            [
                ["adissio (landing)", "landing", "next"],
                ["adissio (web)", "web", "vue"],
            ]
        );
        assert.equal(apps[0].redesign?.currentBranch, "ai", "the folder is on the user's branch");
        assert.equal(git(mono, "branch", "--show-current"), "ai", "and stays there");
        assert.notEqual(apps[0].appId, apps[1].appId);
    });

    test("a W39 record names its apps without looking at the changes", async () => {
        const baseCommit = monorepo(mono);
        redesignBranch(mono, { "landing/app/page.tsx": "new" }, true);
        linkedProject(
            baseCommit,
            {},
            { apps: [{ fileId: FILE, fileName: "adissio web", appDir: "web" }], updatedAt: "2026-11-23T10:00:00.000Z" }
        );
        const [app, ...rest] = await new AppCatalog(join(home, "projects")).list();
        assert.equal(rest.length, 0);
        assert.equal(app.name, "adissio web");
        assert.equal(app.redesign?.appDir, "web");
        assert.equal(app.redesign?.source, "record");
        assert.equal(app.redesign?.updatedAt, "2026-11-23T10:00:00.000Z");
    });

    test("no app for an unlinked project, a record of another folder, a deleted branch or an unsafe folder", async () => {
        const baseCommit = monorepo(mono);
        redesignBranch(mono, { "landing/app/page.tsx": "new" }, false);
        const catalog = new AppCatalog(join(home, "projects"));

        linkedProject(baseCommit, { linkedRoot: undefined, linkedKind: undefined });
        assert.deepEqual(await catalog.list(), [], "not linked");

        linkedProject(baseCommit, {}, { root: join(base, "elsewhere") });
        assert.deepEqual(await catalog.list(), [], "record of an earlier link");

        linkedProject(baseCommit, {}, { apps: [{ fileId: FILE, fileName: "x", appDir: "../outside" }] });
        const guessed = await catalog.list();
        assert.equal(guessed.length, 1, "an unsafe app folder is dropped; the changes name the app");
        assert.equal(guessed[0].redesign?.appDir, "landing");

        linkedProject(baseCommit, {}, { apps: [{ fileId: FILE, fileName: "x", appDir: "gone" }] });
        assert.deepEqual(await catalog.list(), [], "a missing app folder lists nothing");

        linkedProject(baseCommit);
        git(mono, "branch", "-q", "-D", BRANCH);
        assert.deepEqual(await catalog.list(), [], "the Re-Design branch is gone");
    });

    test("app ids belong to their project", () => {
        const appId = RedesignedApps.appId(PROJECT, FILE, "landing");
        assert.equal(RedesignedApps.projectOf(appId), PROJECT);
        assert.equal(RedesignedApps.projectOf(PROJECT), null);
        assert.equal(RedesignedApps.projectOf(`../x~0123abcd`), null);
        assert.notEqual(RedesignedApps.appId(PROJECT, FILE, "web"), appId);
        assert.ok(!ProjectWorkspace.ID_PATTERN.test(appId), "never taken for a project id");
    });
});

describe("app folders and dev commands", () => {
    test("the nearest folder with an app owns a change; a library or nothing falls back to the root", async () => {
        monorepo(mono);
        const folders = new AppFolders(mono);
        assert.deepEqual(
            await folders.fromChanges(["landing/app/page.tsx", "web/src/App.vue", "landing/x.css", "README.md"]),
            ["landing", "web"]
        );
        assert.deepEqual(await folders.fromChanges(["packages/ui/src/Button.tsx"]), [""]);
        assert.deepEqual(await folders.fromChanges([]), [""]);
    });

    test("dev commands follow the lockfile and the framework; nothing to run is reported", async () => {
        writeTree(base, {
            "next/package.json": JSON.stringify({ scripts: { dev: "next dev -p 3002" }, dependencies: { next: "15" } }),
            "next/pnpm-lock.yaml": "",
            "vite/package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }),
            "expo/package.json": JSON.stringify({
                scripts: { start: "expo start" },
                dependencies: { expo: "52", "react-native": "0.76" },
            }),
            "expo/yarn.lock": "",
            "flutter/pubspec.yaml": "name: app",
            "lib/package.json": JSON.stringify({ dependencies: { react: "19" } }),
        });
        const next = await LinkedAppStack.inspect(base, "next");
        assert.deepEqual(next?.devArgv, ["pnpm", "run", "dev", "--port", "{port}", "--hostname", "127.0.0.1"]);
        const vite = await LinkedAppStack.inspect(base, "vite");
        assert.deepEqual(vite?.devArgv, [
            "npm",
            "run",
            "dev",
            "--",
            "--host",
            "127.0.0.1",
            "--port",
            "{port}",
            "--strictPort",
        ]);
        const expo = await LinkedAppStack.inspect(base, "expo");
        assert.deepEqual(expo?.devArgv, ["yarn", "run", "start", "--port", "{port}"]);
        assert.equal(expo?.expo, true);
        assert.equal(expo?.web, false, "no react-native-web");
        assert.equal(expo?.stack?.platform, "mobile");
        const flutter = await LinkedAppStack.inspect(base, "flutter");
        assert.equal(flutter?.isApp(false), true);
        assert.equal(flutter?.devArgv, null, "Penforge cannot run it");
        assert.equal((await LinkedAppStack.inspect(base, "lib"))?.isApp(false), false, "a library");
        assert.equal(await LinkedAppStack.inspect(base, "../"), null, "outside the linked folder");
        assert.equal(next?.installed, false);
        mkdirSync(join(base, "node_modules"));
        assert.equal((await LinkedAppStack.inspect(base, "next"))?.installed, true, "hoisted node_modules");
        // every command passes the stack command rules
        for (const stack of [next, vite, expo]) {
            assert.doesNotThrow(() => new CommandPolicy().validate(stack!.devArgv));
        }
    });
});

describe("redesign.json apps", () => {
    test("a run's apps replace the earlier ones of the same file; other files stay", async () => {
        const workspace = new ProjectWorkspace(join(home, "projects"), PROJECT);
        await workspace.ensure();
        await workspace.writeJson(RedesignBranch.RECORD_FILE, {
            kind: "existing",
            root: mono,
            branch: BRANCH,
            baseBranch: "ai",
            baseCommit: "d8fedc31e634d5a9f0fcefad05dcf8c800c5d89f",
            createdAt: "t",
            updatedAt: "t",
        });
        await RedesignBranch.recordApps(workspace, { fileId: "f1", fileName: "Landing" }, ["landing"]);
        await RedesignBranch.recordApps(workspace, { fileId: "f2", fileName: "Web" }, ["web"]);
        await RedesignBranch.recordApps(workspace, { fileId: "f1", fileName: "Landing v2" }, ["landing", "docs"]);
        const record = RedesignBranch.readRecord(await workspace.readJson(RedesignBranch.RECORD_FILE, null));
        assert.deepEqual(record?.apps, [
            { fileId: "f1", fileName: "Landing v2", appDir: "landing" },
            { fileId: "f1", fileName: "Landing v2", appDir: "docs" },
            { fileId: "f2", fileName: "Web", appDir: "web" },
        ]);
        assert.equal(record?.branch, BRANCH, "the rest of the record stays");
        assert.equal(
            RedesignBranch.readRecord({ kind: "existing", root: mono, branch: "main", baseCommit: "x" }),
            null
        );
    });
});

describe("Re-Designed apps on the dashboard", () => {
    let daemon: PenforgeDaemon;
    let clients: AgentTestClient[];

    beforeEach(async () => {
        const config = new AgentConfig({
            home,
            host: "127.0.0.1",
            port: 0,
            allowedOrigins: [ORIGIN],
            publicUri: ORIGIN,
            runner: "fake",
            mcpUrl: "http://127.0.0.1:1/mcp",
        });
        daemon = new PenforgeDaemon(config, {
            runner: new FakeRunner(),
            tools: null,
            devServers: new DevServerManager({
                ports: new PortPool(FIRST_PORT, FIRST_PORT + 9),
                probeIntervalMs: 50,
                restartDelayMs: 50,
                idleStopMs: 150,
                commandPolicy: new CommandPolicy(["npm"]),
            }),
            authTimeoutMs: 500,
        });
        await daemon.start();
        clients = [];
    });

    afterEach(async () => {
        for (const client of clients) {
            client.close();
        }
        await daemon.stop();
    });

    async function dashboard(): Promise<AgentTestClient> {
        const agent = await AgentTestClient.connect(`ws://127.0.0.1:${daemon.port}/agent`, ORIGIN);
        clients.push(agent);
        agent.send({ type: "auth", token: daemon.token.value });
        await agent.next("auth.ok");
        return agent;
    }

    function portFree(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = createServer();
            server.once("error", () => resolve(false));
            server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
        });
    }

    test("start runs the app's dev script in its folder after the install; stop frees the port", async () => {
        // the landing's dev script runs the fake server on $PORT
        const baseCommit = monorepo(mono, `node ${FAKE_SERVER} serve`);
        redesignBranch(mono, { "landing/app/page.tsx": "new" }, true);
        linkedProject(baseCommit, { fileNames: { [FILE]: "adissio landing" } });
        const before = gitSnapshot(mono);
        const client = await dashboard();

        client.send({ type: "apps.list", rid: "l", teamId: TEAM });
        const apps: AppInfo[] = (await client.next("apps.list")).apps;
        assert.deepEqual(
            apps.map((app) => [app.name, app.projectName, app.redesign?.branch]),
            [["adissio landing", "Adissio", BRANCH]]
        );
        const app = apps[0];
        assert.deepEqual(app.status, { state: "stopped" });

        // no node_modules: refused with a reason, nothing installed
        client.send({ type: "apps.start", rid: "s0", projectId: PROJECT, appId: app.appId });
        const refused = await client.next("error", (m) => m.rid === "s0");
        assert.equal(refused.code, "not-configured");
        assert.equal(refused.reason, "not-installed");

        mkdirSync(join(mono, "landing", "node_modules"));
        client.send({ type: "apps.start", rid: "s1", projectId: PROJECT, appId: app.appId });
        const ready = await client.next("apps.status", (m) => m.appId === app.appId && m.state === "ready");
        assert.equal(ready.projectId, PROJECT);
        const response = await fetch(ready.url!);
        assert.match(await response.text(), /fake app/);
        const port = Number(new URL(ready.url!).port);

        client.send({ type: "apps.logs", rid: "g", projectId: PROJECT, appId: app.appId });
        const logs = await client.next("apps.logs");
        assert.equal(logs.appId, app.appId);
        assert.ok(logs.lines.length > 0);

        // another project cannot name this app
        client.send({ type: "apps.stop", rid: "x", projectId: "other-project", appId: app.appId });
        assert.equal((await client.next("error", (m) => m.rid === "x")).code, "bad-request");

        client.send({ type: "apps.stop", rid: "s2", projectId: PROJECT, appId: app.appId });
        await client.next("apps.status", (m) => m.appId === app.appId && m.state === "stopped");
        const end = Date.now() + 10_000;
        while (!(await portFree(port)) && Date.now() < end) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(await portFree(port), "the port is free again");
        assert.equal(git(mono, "branch", "--show-current"), BRANCH);
        assert.equal(gitSnapshot(mono).split("\n")[2], before.split("\n")[2], "no file changed");
    });
});
