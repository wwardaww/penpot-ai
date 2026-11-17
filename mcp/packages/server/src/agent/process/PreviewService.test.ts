import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ContextSetMessage } from "@penpot/mcp-common";
import { AgentConfig } from "../AgentConfig";
import { PenforgeDaemon } from "../PenforgeDaemon";
import { FakeRunner } from "../runner/FakeRunner";
import { AgentTestClient } from "../testing/AgentTestClient";
import { DevServerManager } from "./DevServerManager";
import { PortPool } from "./PortPool";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "testing", "fakeDevServer.mjs");
const ORIGIN = "https://localhost:3449";
const PROJECT_ID = "6a1f0e2c-7d33-4f0b-9c55-0e1d2b3c4d01";
const FIRST_PORT = 47360;

function context(persona: "designer" | "developer", projectId = PROJECT_ID): ContextSetMessage {
    return {
        type: "context.set",
        fileId: "file-1",
        fileName: "App",
        projectId,
        teamId: "team-1",
        pageId: "page-1",
        persona,
        platform: "web",
    };
}

let home: string;
let daemon: PenforgeDaemon;
let devServers: DevServerManager;
let clients: AgentTestClient[];

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-preview-"));
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
        idleStopMs: 200,
    });
    daemon = new PenforgeDaemon(config, { runner: new FakeRunner(), tools: null, devServers, authTimeoutMs: 500 });
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

async function client(persona: "designer" | "developer"): Promise<AgentTestClient> {
    const agent = await AgentTestClient.connect(`ws://127.0.0.1:${daemon.port}/agent`, ORIGIN);
    clients.push(agent);
    agent.send({ type: "auth", token: daemon.token.value });
    await agent.next("auth.ok");
    agent.send(context(persona));
    // the history request waits for the workspace, so it doubles as a barrier
    agent.send({ type: "chat.history", rid: "barrier", conversationId: "barrier" });
    await agent.next("chat.history");
    return agent;
}

function writeStack(mode: string): void {
    const file = join(home, "projects", PROJECT_ID, ".penforge", "stack.json");
    writeFileSync(file, JSON.stringify({ name: "fake", dev: `node "${FAKE_SERVER}" ${mode}` }));
}

test("preview.start runs the dev server and reports ready", async () => {
    const designer = await client("designer");
    writeStack("serve");
    designer.send({ type: "preview.start", rid: "p1", projectId: PROJECT_ID });

    const starting = await designer.next("preview.status", (m) => m.state === "starting");
    assert.equal(starting.url, `http://localhost:${FIRST_PORT}/`);
    const ready = await designer.next("preview.ready");
    assert.equal(ready.url, `http://localhost:${FIRST_PORT}/`);
    await designer.next("preview.status", (m) => m.state === "ready");
    const response = await fetch(ready.url.replace("localhost", "127.0.0.1"));
    assert.match(await response.text(), /fake app/);
    assert.ok(!designer.drain().some((m) => m.type === "preview.log"), "designers get no logs");
});

test("a second tab joins the running server and developers get the logs", async () => {
    const designer = await client("designer");
    writeStack("serve");
    designer.send({ type: "preview.start", projectId: PROJECT_ID });
    await designer.next("preview.ready");

    const developer = await client("developer");
    developer.send({ type: "preview.start", projectId: PROJECT_ID });
    const ready = await developer.next("preview.ready");
    assert.equal(ready.url, `http://localhost:${FIRST_PORT}/`);
    const log = await developer.next("preview.log", (m) => m.stream === "stdout");
    assert.match(log.text, /Local:/);
    assert.deepEqual(devServers.liveProjects, [PROJECT_ID]);
});

test("preview.stop stops the server for every watching tab", async () => {
    const a = await client("designer");
    const b = await client("designer");
    writeStack("serve");
    a.send({ type: "preview.start", projectId: PROJECT_ID });
    b.send({ type: "preview.start", projectId: PROJECT_ID });
    await a.next("preview.ready");
    await b.next("preview.ready");

    b.send({ type: "preview.stop", projectId: PROJECT_ID });
    await a.next("preview.stopped");
    await a.next("preview.status", (m) => m.state === "stopped");
    await b.next("preview.stopped");
    assert.deepEqual(devServers.liveProjects, []);
});

test("preview.start without a generated app answers not-configured", async () => {
    const designer = await client("designer");
    designer.send({ type: "preview.start", rid: "p2", projectId: PROJECT_ID });
    const error = await designer.next("error");
    assert.equal(error.rid, "p2");
    assert.equal(error.code, "not-configured");
});

test("a client may only preview its own project", async () => {
    const designer = await client("designer");
    designer.send({ type: "preview.start", rid: "p3", projectId: "another-project" });
    const error = await designer.next("error");
    assert.equal(error.rid, "p3");
    assert.equal(error.code, "bad-request");
});

test("the server stops after the last tab closed", async () => {
    const designer = await client("designer");
    writeStack("serve");
    designer.send({ type: "preview.start", projectId: PROJECT_ID });
    await designer.next("preview.ready");
    designer.close();
    await designer.closed;
    const deadline = Date.now() + 5000;
    while (devServers.liveProjects.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(devServers.liveProjects, []);
});

test("stopping the daemon stops the dev servers", async () => {
    const designer = await client("designer");
    writeStack("serve");
    designer.send({ type: "preview.start", projectId: PROJECT_ID });
    await designer.next("preview.ready");
    await daemon.stop();
    assert.deepEqual(devServers.liveProjects, []);
    assert.equal(await PortPool.isFree(FIRST_PORT), true);
});
