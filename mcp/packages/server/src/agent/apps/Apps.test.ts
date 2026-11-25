import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import sharp from "sharp";
import type { AppsStatusMessage, WorkflowContext, WorkflowToolResult } from "@penpot/mcp-common";
import { AgentConfig } from "../AgentConfig";
import { PenforgeDaemon } from "../PenforgeDaemon";
import { CommandPolicy } from "../process/CommandPolicy";
import { DevServerManager } from "../process/DevServerManager";
import { PortPool } from "../process/PortPool";
import { FAKE_SERVER } from "../process/testing/fakeServer";
import { PhonePreview, type PhoneSession } from "../publish/PhonePreview";
import { PublishServices } from "../publish/PublishServices";
import { SecretStore } from "../publish/SecretStore";
import { FakeRunner } from "../runner/FakeRunner";
import { AgentTestClient } from "../testing/AgentTestClient";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { WorkspaceManager } from "../workspace/WorkspaceManager";
import { AppCatalog } from "./AppCatalog";
import { AppsService } from "./AppsService";
import { AppThumbnail } from "./AppThumbnail";

const ORIGIN = "https://localhost:3449";
const WEB_APP = "0a1f0e2c-7d33-4f0b-9c55-0e1d2b3c4d01";
const MOBILE_APP = "0a1f0e2c-7d33-4f0b-9c55-0e1d2b3c4d02";
const UNBUILT = "0a1f0e2c-7d33-4f0b-9c55-0e1d2b3c4d03";
const OTHER_TEAM = "0a1f0e2c-7d33-4f0b-9c55-0e1d2b3c4d04";
const FIRST_PORT = 47460;

/** Phone preview that reports a fixed session instead of restarting a dev server for the LAN. */
class FakePhonePreview extends PhonePreview {
    public runs = 0;

    constructor(devServers: DevServerManager) {
        super(devServers);
    }

    public override async run(
        _workspace: ProjectWorkspace,
        signal: AbortSignal,
        onReady: (session: PhoneSession) => void
    ): Promise<void> {
        this.runs++;
        onReady({
            url: "exp://192.168.1.20:5200",
            host: "192.168.1.20",
            port: 5200,
            qr: PhonePreview.qr("exp://192.168.1.20:5200"),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
}

let home: string;
let daemon: PenforgeDaemon;
let devServers: DevServerManager;
let phone: FakePhonePreview;
let clients: AgentTestClient[];

function projectDir(projectId: string, ...parts: string[]): string {
    return join(home, "projects", projectId, ...parts);
}

function writeJson(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
}

/** Writes the files a build leaves: stack, map, project record, optional checkpoints. */
function builtApp(
    projectId: string,
    options: { dev: string[]; platform: "web" | "mobile"; teamId?: string; name?: string; builtAt?: string }
): void {
    mkdirSync(projectDir(projectId, "app-src"), { recursive: true });
    writeJson(projectDir(projectId, ".penforge", "stack.json"), {
        schemaVersion: 1,
        platform: options.platform,
        name: options.platform === "web" ? "React + Vite" : "Expo",
        version: "react 19",
        commands: { install: ["npm", "install"], build: ["npm", "run", "build"], dev: options.dev },
    });
    writeJson(projectDir(projectId, ".penforge", "map.json"), {
        schemaVersion: 1,
        builtAt: options.builtAt ?? "2026-11-19T10:00:00.000Z",
        fileId: `file-of-${projectId.slice(-2)}`,
        commit: "abc123",
        boards: { "board-1": { name: "Home", hash: "h", route: "/", files: [] } },
    });
    writeJson(projectDir(projectId, ".penforge", "project.json"), {
        projectId,
        projectName: options.name ?? `App ${projectId.slice(-2)}`,
        teamId: options.teamId ?? "team-1",
        platform: options.platform,
        persona: "designer",
        fileIds: ["file-x"],
    });
}

async function png(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
        .png()
        .toBuffer();
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > end) {
            throw new Error("Timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

function portFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-apps-"));
    const config = new AgentConfig({
        home,
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: [ORIGIN],
        publicUri: ORIGIN,
        runner: "fake",
        mcpUrl: "http://127.0.0.1:1/mcp",
    });
    devServers = new DevServerManager({
        ports: new PortPool(FIRST_PORT, FIRST_PORT + 9),
        probeIntervalMs: 50,
        restartDelayMs: 50,
        idleStopMs: 150,
        commandPolicy: new CommandPolicy(["node"]),
    });
    phone = new FakePhonePreview(devServers);
    daemon = new PenforgeDaemon(config, {
        runner: new FakeRunner(),
        tools: null,
        devServers,
        authTimeoutMs: 500,
        publish: (downloads, downloadUrl) =>
            new PublishServices(new SecretStore(join(home, "secrets.json")), downloads, downloadUrl, devServers, {
                phone,
            }),
    });
    await daemon.start();
    clients = [];
});

afterEach(async () => {
    for (const client of clients) {
        client.close();
    }
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
});

/** Connects a dashboard client: auth only, no `context.set`. */
async function dashboard(): Promise<AgentTestClient> {
    const agent = await AgentTestClient.connect(`ws://127.0.0.1:${daemon.port}/agent`, ORIGIN);
    clients.push(agent);
    agent.send({ type: "auth", token: daemon.token.value });
    await agent.next("auth.ok");
    return agent;
}

function webApp(mode: string[] = ["serve"]): void {
    builtApp(WEB_APP, { dev: ["node", FAKE_SERVER, ...mode], platform: "web", builtAt: "2026-11-19T11:00:00.000Z" });
}

function mobileApp(): void {
    builtApp(MOBILE_APP, { dev: ["npx", "expo", "start", "--port", "{port}"], platform: "mobile" });
}

test("apps.list shows built apps with their details and no unbuilt project", async () => {
    webApp();
    mobileApp();
    builtApp(OTHER_TEAM, { dev: ["npm", "run", "dev"], platform: "web", teamId: "team-2" });
    // a project without a build (plan only) is not an app
    writeJson(projectDir(UNBUILT, ".penforge", "stack.json"), { name: "x", commands: { dev: ["npm", "run", "dev"] } });
    writeFileSync(projectDir(WEB_APP, ".penforge", "thumbnail.png"), await png(1200, 800));
    writeJson(projectDir(WEB_APP, ".penforge", "checkpoints.json"), {
        version: 1,
        checkpoints: [
            { id: "cp-1", n: 1, label: "Before build", at: "2026-11-19T09:00:00.000Z" },
            { id: "cp-2", n: 2, label: "Before fixing 3 comments", at: "2026-11-19T09:30:00.000Z" },
        ],
    });
    writeJson(projectDir(MOBILE_APP, "app-src", "package.json"), { dependencies: { "react-native-web": "0.21" } });

    const client = await dashboard();
    client.send({ type: "apps.list", rid: "l1", teamId: "team-1" });
    const reply = await client.next("apps.list");
    assert.equal(reply.rid, "l1");
    assert.deepEqual(
        reply.apps.map((app) => app.projectId),
        [WEB_APP, MOBILE_APP],
        "newest build first, other teams and unbuilt projects left out"
    );
    const [web, mobile] = reply.apps;
    assert.equal(web.name, "App 01");
    assert.equal(web.fileId, "file-of-01");
    assert.equal(web.platform, "web");
    assert.deepEqual(web.stack, { name: "React + Vite", version: "react 19" });
    assert.equal(web.expo, false);
    assert.equal(web.web, true);
    assert.deepEqual(web.checkpoint, { n: 2, label: "Before fixing 3 comments", at: "2026-11-19T09:30:00.000Z" });
    assert.equal(web.thumbnailPath, ".penforge/thumbnail.png");
    assert.match(web.thumbnail ?? "", /^data:image\/png;base64,/);
    const size = await sharp(Buffer.from(web.thumbnail!.split(",")[1], "base64")).metadata();
    assert.equal(size.width, AppThumbnail.CARD_WIDTH);
    assert.equal(web.path, projectDir(WEB_APP));
    assert.deepEqual(web.status, { state: "stopped" });
    assert.equal(mobile.expo, true);
    assert.equal(mobile.web, true, "react-native-web makes the Expo app show in a browser");
    assert.equal(mobile.thumbnail, null);
    assert.equal(mobile.checkpoint, null);

    client.send({ type: "apps.list", rid: "l2" });
    assert.equal((await client.next("apps.list")).apps.length, 3, "no team filter lists every app");
    assert.ok(!existsSync(projectDir(UNBUILT, "design")), "listing creates no project folders");
});

test("apps.start runs a web app, keeps it without watchers, and apps.stop frees the port", async () => {
    // the stack command policy allows forward slashes only
    const pidFile = join(home, "grandchild.pid").replace(/\\/g, "/");
    webApp(["tree", pidFile]);
    const client = await dashboard();
    const other = await dashboard();
    other.send({ type: "apps.list", rid: "l" });
    await other.next("apps.list");

    client.send({ type: "apps.start", rid: "s1", projectId: WEB_APP });
    const ready = await client.next("apps.status", (m) => m.state === "ready");
    assert.equal(ready.url, `http://localhost:${FIRST_PORT}/`);
    assert.equal(ready.exposure, "loopback");
    const response = await fetch(ready.url!.replace("localhost", "127.0.0.1"));
    assert.match(await response.text(), /fake app/);
    await other.next("apps.status", (m) => m.projectId === WEB_APP && m.state === "ready");

    // pinned: the idle stop (150 ms) of unwatched previews does not apply
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(devServers.liveProjects, [WEB_APP]);

    // a second start reuses the server and replays its status
    client.send({ type: "apps.start", rid: "s2", projectId: WEB_APP });
    const again = await client.next("apps.status", (m) => m.state === "ready");
    assert.equal(again.url, ready.url);

    client.send({ type: "apps.list", rid: "l2" });
    const listed = (await client.next("apps.list")).apps[0];
    assert.equal(listed.status.state, "ready");
    assert.equal(listed.status.url, ready.url);

    const grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.ok(isAlive(grandchild));
    client.send({ type: "apps.stop", rid: "x1", projectId: WEB_APP });
    const stopped = await client.next("apps.status", (m) => m.state === "stopped");
    assert.equal(stopped.reason, "stopped");
    await other.next("apps.status", (m) => m.state === "stopped");
    await waitUntil(() => !isAlive(grandchild));
    assert.ok(await portFree(FIRST_PORT), "the port is free again");
    assert.deepEqual(devServers.liveProjects, []);
});

test("two apps run at the same time on their own ports", async () => {
    webApp();
    builtApp(OTHER_TEAM, { dev: ["node", FAKE_SERVER, "serve"], platform: "web" });
    const client = await dashboard();
    client.send({ type: "apps.start", rid: "a", projectId: WEB_APP });
    client.send({ type: "apps.start", rid: "b", projectId: OTHER_TEAM });
    const a = await client.next("apps.status", (m) => m.projectId === WEB_APP && m.state === "ready");
    const b = await client.next("apps.status", (m) => m.projectId === OTHER_TEAM && m.state === "ready");
    assert.notEqual(a.url, b.url);
    assert.deepEqual(devServers.liveProjects.sort(), [OTHER_TEAM, WEB_APP].sort());
});

test("unbuilt or unknown projects are refused without creating folders", async () => {
    const client = await dashboard();
    client.send({ type: "apps.start", rid: "s", projectId: UNBUILT });
    const error = await client.next("error");
    assert.equal(error.rid, "s");
    assert.equal(error.code, "not-configured");
    assert.ok(!existsSync(projectDir(UNBUILT)));

    client.send({ type: "apps.start", rid: "bad", projectId: "../escape" });
    assert.equal((await client.next("error", (m) => m.rid === "bad")).code, "bad-request");

    client.send({ type: "apps.stop", rid: "x", projectId: UNBUILT });
    assert.equal((await client.next("error", (m) => m.rid === "x")).code, "bad-request");
});

test("a crashing app reports failed and is no longer kept", async () => {
    webApp(["crash"]);
    const client = await dashboard();
    client.send({ type: "apps.start", rid: "s", projectId: WEB_APP });
    const failed = await client.next("apps.status", (m) => m.state === "failed");
    assert.equal(failed.reason, "crashed");
    await waitUntil(() => !(daemon as unknown as { apps: AppsService }).apps.pinnedProjects.includes(WEB_APP));
});

test("apps.logs returns the dev server output", async () => {
    webApp();
    const client = await dashboard();
    client.send({ type: "apps.start", rid: "s", projectId: WEB_APP });
    await client.next("apps.status", (m) => m.state === "ready");
    client.send({ type: "apps.logs", rid: "g", projectId: WEB_APP });
    const logs = await client.next("apps.logs");
    assert.equal(logs.rid, "g");
    assert.ok(logs.lines.some((line) => line.stream === "stdout" && /Local:/.test(line.text)));
});

test("the phone session needs the user's consent and an Expo app", async () => {
    webApp();
    mobileApp();
    const client = await dashboard();
    client.send({ type: "apps.phone.start", rid: "p0", projectId: MOBILE_APP });
    assert.equal((await client.next("error", (m) => m.rid === "p0")).code, "bad-request", "no consent, no LAN");
    assert.equal(phone.runs, 0);

    client.send({ type: "apps.phone.start", rid: "p1", projectId: WEB_APP, confirmed: true });
    const refused = await client.next("apps.phone", (m) => m.projectId === WEB_APP);
    assert.equal(refused.state, "failed");
    assert.equal(refused.code, "no-phone-preview");

    client.send({ type: "apps.phone.start", rid: "p2", projectId: MOBILE_APP, confirmed: true });
    await client.next("apps.phone", (m) => m.state === "starting");
    const ready = await client.next("apps.phone", (m) => m.state === "ready");
    assert.equal(ready.url, "exp://192.168.1.20:5200");
    assert.equal(ready.qr!.size, ready.qr!.rows.length);
    client.send({ type: "apps.phone.stop", projectId: MOBILE_APP });
    await client.next("apps.phone", (m) => m.state === "stopped");
    assert.equal(phone.runs, 1);
});

test("a client that disconnects ends its phone session", async () => {
    mobileApp();
    const client = await dashboard();
    let ended = false;
    const original = phone.run.bind(phone);
    phone.run = async (workspace, signal, onReady) => {
        await original(workspace, signal, onReady);
        ended = true;
    };
    client.send({ type: "apps.phone.start", rid: "p", projectId: MOBILE_APP, confirmed: true });
    await client.next("apps.phone", (m) => m.state === "ready");
    client.close();
    await waitUntil(() => ended);
});

test("apps are refused in server mode and without the service", async () => {
    const workspaces = new WorkspaceManager(join(home, "projects"));
    const service = new AppsService(
        devServers,
        workspaces,
        join(home, "projects"),
        { get: () => phone },
        "server mode"
    );
    const sent: unknown[] = [];
    const client = {
        id: "c",
        closed: new AbortController().signal,
        send: (m: unknown) => sent.push(m),
        setup: () => Promise.reject(),
    };
    await assert.rejects(service.list(client, { type: "apps.list", rid: "r" }), (error: Error & { code?: string }) => {
        return error.code === "not-configured";
    });
    service.dispose();
    assert.deepEqual(sent, []);
});

test("statuses of previews started elsewhere reach dashboard clients", async () => {
    webApp();
    const client = await dashboard();
    client.send({ type: "apps.list", rid: "l" });
    await client.next("apps.list");
    const workspace = await new WorkspaceManager(join(home, "projects")).get(WEB_APP);
    // a workspace preview watches its server
    const watch = devServers.watch(WEB_APP, { onStatus: () => undefined, onLog: () => undefined });
    await devServers.start(workspace);
    const status: AppsStatusMessage = await client.next("apps.status", (m) => m.state === "ready");
    assert.equal(status.projectId, WEB_APP);
    watch.dispose();
});

test("the newest of the build thumbnail and the visual QA screenshot is used", async () => {
    webApp();
    const meta = projectDir(WEB_APP, ".penforge");
    writeFileSync(join(meta, "thumbnail.png"), await png(800, 600));
    const run = join(meta, "qa", "20261119T120000-ab12");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "home-app.png"), await png(390, 844));
    writeFileSync(join(run, "home-app-before.png"), await png(390, 844));
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(meta, "thumbnail.png"), past, past);

    const source = await AppThumbnail.locate(projectDir(WEB_APP));
    assert.equal(source?.relativePath, ".penforge/qa/20261119T120000-ab12/home-app.png");
    const record = await new AppCatalog(join(home, "projects")).find(WEB_APP);
    const size = await sharp(Buffer.from(record!.thumbnail!.split(",")[1], "base64")).metadata();
    assert.equal(size.width, 390, "small images are not enlarged");
});

test("a build saves a screenshot of the flow's start board as the thumbnail", async () => {
    webApp();
    writeJson(projectDir(WEB_APP, ".penforge", "map.json"), {
        schemaVersion: 1,
        builtAt: "2026-11-19T10:00:00.000Z",
        fileId: "f",
        commit: null,
        boards: {
            "board-home": { name: "Home", hash: "h", route: "/", files: [] },
            "board-login": { name: "Login", hash: "h", route: "/login", files: [] },
            "board-icon": { name: "Icon", hash: "h", route: null, files: [] },
        },
    });
    const workspace = await new WorkspaceManager(join(home, "projects")).get(WEB_APP);
    const shot = (await png(1440, 1024)).toString("base64");
    const calls: { name: string; args?: Record<string, unknown> }[] = [];
    const result = (text: string, content: unknown[] = []): WorkflowToolResult => ({ isError: false, text, content });
    const ctx = {
        workspace,
        tools: {
            call: async (name: string, args?: Record<string, unknown>) => {
                calls.push({ name, args });
                if (name === "get_prototype_graph") {
                    return result(JSON.stringify({ flows: [{ name: "Main", startingBoardId: "board-login" }] }));
                }
                return result("{}", [{ type: "image", data: shot, mimeType: "image/png" }]);
            },
            list: async () => [],
        },
    } as unknown as WorkflowContext;

    assert.equal(await AppThumbnail.saveAfterBuild(ctx), true);
    assert.deepEqual(calls[1], {
        name: "capture_node_screenshot",
        args: { nodeId: "board-login", scale: 1, format: "png" },
    });
    const saved = await sharp(readFileSync(projectDir(WEB_APP, ".penforge", "thumbnail.png"))).metadata();
    assert.equal(saved.width, AppThumbnail.SAVED_WIDTH);

    const failing = {
        workspace,
        tools: {
            call: async () => ({ isError: true, text: "no plugin", content: [] }),
            list: async () => [],
        },
    } as unknown as WorkflowContext;
    assert.equal(await AppThumbnail.saveAfterBuild(failing), false, "a failed capture never throws");
});
