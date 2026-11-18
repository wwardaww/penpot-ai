import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ContextSetMessage, Workflow } from "@penpot/mcp-common";
import { AgentConfig } from "./AgentConfig";
import { PenforgeDaemon } from "./PenforgeDaemon";
import { FakeRunner } from "./runner/FakeRunner";
import { AgentTestClient } from "./testing/AgentTestClient";
import { WorkflowRegistry } from "./workflows/WorkflowRegistry";

const ORIGIN = "https://localhost:3449";
const PROJECT_ID = "0d6c3c1e-4c39-4a0e-9a35-3c4b8f7f1a01";

const CONTEXT: ContextSetMessage = {
    type: "context.set",
    fileId: "file-1",
    fileName: "Landing page",
    projectId: PROJECT_ID,
    projectName: "Shop",
    teamId: "team-1",
    pageId: "page-1",
    persona: "designer",
    platform: "web",
    mcpSessionId: "tab-1",
};

/** Test workflow: asks a question, writes a metadata file and reports the answer. */
const dummyWorkflow: Workflow<{ label?: string }> = {
    name: "dummy",
    description: "Test workflow",
    run: async (ctx, params) => {
        ctx.emit("progress", { step: 1, label: params.label });
        const choice = await ctx.ask({
            text: "Pick one",
            options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
            ],
        });
        await ctx.workspace.writeJson("dummy.json", { choice });
        return { summary: `picked ${choice}` };
    },
};

let home: string;
let runner: FakeRunner;
let daemon: PenforgeDaemon;
let clients: AgentTestClient[];

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-home-"));
    runner = new FakeRunner();
    const registry = WorkflowRegistry.withShippedWorkflows();
    registry.register(dummyWorkflow);
    const config = new AgentConfig({
        home,
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: [ORIGIN],
        publicUri: ORIGIN,
        runner: "fake",
        mcpUrl: "http://127.0.0.1:1/mcp",
        // Most tests check the pairing flow; the default (no pairing) has its own tests.
        requirePairing: true,
    });
    daemon = new PenforgeDaemon(config, { runner, registry, tools: null, authTimeoutMs: 500 });
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

function agentUrl(): string {
    return `ws://127.0.0.1:${daemon.port}/agent`;
}

async function connect(origin: string | undefined = ORIGIN): Promise<AgentTestClient> {
    const client = await AgentTestClient.connect(agentUrl(), origin);
    clients.push(client);
    return client;
}

async function authenticated(): Promise<AgentTestClient> {
    const client = await connect();
    client.send({ type: "auth", token: daemon.token.value });
    await client.next("auth.ok");
    return client;
}

async function withContext(): Promise<AgentTestClient> {
    const client = await authenticated();
    client.send(CONTEXT);
    // a request after context.set waits for the workspace; history doubles as a barrier
    client.send({ type: "chat.history", rid: "barrier", conversationId: "barrier" });
    await client.next("chat.history");
    return client;
}

function httpGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: daemon.port, path, headers }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
    });
}

// --- HTTP endpoints

test("health reports the daemon and its runner", async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    const body = (await response.json()) as { ok: boolean; runner: string; workflows: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.runner, "fake");
    assert.ok(body.workflows.includes("chat"));
});

test("health refuses a foreign origin", async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/health`, {
        headers: { Origin: "https://evil.test" },
    });
    assert.equal(response.status, 403);
});

test("requests naming another host are refused (DNS rebinding)", async () => {
    const response = await httpGet("/health", { Host: `evil.test:${daemon.port}` });
    assert.equal(response.status, 403);
});

test("pair returns the pairing URL to local programs only", async () => {
    const local = await httpGet("/pair", { Host: `127.0.0.1:${daemon.port}` });
    const page = await httpGet("/pair", { Host: `127.0.0.1:${daemon.port}`, Origin: ORIGIN });
    assert.equal(JSON.parse(local.body).pairUrl, `${ORIGIN}/#/penforge/pair?token=${daemon.token.value}`);
    assert.equal(JSON.parse(page.body).pairUrl, undefined);
});

// --- authentication

test("a WebSocket from a foreign origin is refused", async () => {
    await assert.rejects(connect("https://evil.test"), /HTTP 403/);
});

test("a WebSocket without an origin is refused", async () => {
    await assert.rejects(AgentTestClient.connect(agentUrl()), /HTTP 403/);
});

test("a wrong token closes the connection with a policy violation", async () => {
    const client = await connect();
    client.send({ type: "auth", token: "wrong" });
    const error = await client.next("auth.error");
    assert.equal(error.reason, "Invalid token");
    assert.equal((await client.closed).code, 1008);
});

async function withoutPairing<T>(body: (url: string) => Promise<T>): Promise<T> {
    const config = new AgentConfig({
        home,
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: [ORIGIN],
        publicUri: ORIGIN,
        runner: "fake",
        mcpUrl: "http://127.0.0.1:1/mcp",
    });
    const open = new PenforgeDaemon(config, {
        runner,
        registry: WorkflowRegistry.withShippedWorkflows(),
        tools: null,
        authTimeoutMs: 500,
    });
    await open.start();
    try {
        return await body(`ws://127.0.0.1:${open.port}/agent`);
    } finally {
        await open.stop();
    }
}

test("by default the frontend origin connects without a pairing token", async () => {
    await withoutPairing(async (url) => {
        const client = await AgentTestClient.connect(url, ORIGIN);
        clients.push(client);
        client.send({ type: "auth", token: "" });
        await client.next("auth.ok");
    });
});

test("by default a foreign origin is still refused", async () => {
    await withoutPairing(async (url) => {
        await assert.rejects(AgentTestClient.connect(url, "https://evil.test"), /HTTP 403/);
        await assert.rejects(AgentTestClient.connect(url), /HTTP 403/);
    });
});

test("a first message other than auth closes the connection", async () => {
    const client = await connect();
    client.send(CONTEXT);
    await client.next("auth.error");
    assert.equal((await client.closed).code, 1008);
});

test("a client that never authenticates is disconnected", async () => {
    const client = await connect();
    assert.equal((await client.closed).code, 1008);
});

test("the right token is accepted", async () => {
    const client = await connect();
    client.send({ type: "auth", token: daemon.token.value });
    const ok = await client.next("auth.ok");
    assert.equal(typeof ok.daemonVersion, "string");
});

// --- context and chat

test("requests before context.set fail with no-context", async () => {
    const client = await authenticated();
    client.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "hi" });
    const error = await client.next("error");
    assert.equal(error.code, "no-context");
    assert.equal(error.rid, "r1");
});

test("invalid messages are answered with bad-request", async () => {
    const client = await authenticated();
    client.send({ type: "chat.send", rid: "r1" });
    const error = await client.next("error");
    assert.equal(error.code, "bad-request");
    assert.equal(error.rid, "r1");
});

test("context.set creates the project folder with two git repos", async () => {
    await withContext();
    const root = join(home, "projects", PROJECT_ID);
    for (const repo of ["design", "app-src"]) {
        const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: join(root, repo) });
        assert.equal(count.toString().trim(), "1");
    }
    assert.equal(existsSync(join(root, ".penforge", "project.json")), true);
});

test("chat.send streams deltas and ends with chat.done", async () => {
    const client = await withContext();
    client.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "hello" });
    const done = await client.next("chat.done");
    const deltas = client.drain().filter((message) => message.type === "chat.delta");
    assert.equal(deltas.map((delta) => (delta as { text: string }).text).join(""), "You said: hello");
    assert.ok(deltas.every((delta) => (delta as { messageId: string }).messageId === done.messageId));
});

test("chat turns run in the project folder with the persona prompt", async () => {
    const client = await withContext();
    client.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "hello" });
    await client.next("chat.done");
    const { opts } = runner.received[0];
    assert.equal(opts.cwd, join(home, "projects", PROJECT_ID));
    assert.match(opts.systemPromptAppend, /a designer/);
    assert.match(opts.systemPromptAppend, /`tab-1`/);
});

test("tool calls are reported in designer language", async () => {
    const client = await withContext();
    client.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "/tool" });
    const tool = await client.next("chat.tool", (message) => message.status === "done");
    assert.equal(tool.summary, "Working on the design");
    assert.equal(tool.detail, undefined);
});

test("a conversation keeps its history and resumes its Claude session", async () => {
    const client = await withContext();
    client.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "one" });
    await client.next("chat.done");
    client.send({ type: "chat.send", rid: "r2", conversationId: "c1", text: "two" });
    await client.next("chat.done");

    client.send({ type: "chat.history", rid: "h1", conversationId: "c1" });
    const history = await client.next("chat.history", (message) => message.rid === "h1");

    assert.deepEqual(
        history.messages.map((message) => [message.role, message.text]),
        [
            ["user", "one"],
            ["assistant", "You said: one"],
            ["user", "two"],
            ["assistant", "You said: two"],
        ]
    );
    assert.equal(runner.received[1].conversation.resumeSessionId, "fake-c1");
});

test("history survives a reconnect", async () => {
    const first = await withContext();
    first.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "one" });
    await first.next("chat.done");
    first.close();

    const second = await withContext();
    second.send({ type: "chat.history", rid: "h1", conversationId: "c1" });
    const history = await second.next("chat.history", (message) => message.rid === "h1");
    assert.equal(history.messages.length, 2);
});

test("permission requests round-trip to the browser", async () => {
    const client = await withContext();
    client.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "/permission" });
    const request = await client.next("permission.request");
    assert.equal(request.risk, "medium");
    client.send({ type: "permission.respond", requestId: request.requestId, allow: true });
    await client.next("chat.done");
    const text = client
        .drain()
        .filter((message) => message.type === "chat.delta")
        .map((delta) => (delta as { text: string }).text)
        .join("");
    assert.equal(text, "Permission granted");
});

test("attached files are saved in the project and reach Claude", async () => {
    const client = await withContext();
    const markdown = Buffer.from("# DESIGN\nPrimary #3366FF", "utf8");
    client.send({
        type: "chat.send",
        rid: "r1",
        conversationId: "c1",
        text: "use this",
        attachments: [
            {
                kind: "file",
                name: "DESIGN.md",
                mime: "text/markdown",
                size: markdown.length,
                base64: markdown.toString("base64"),
            },
        ],
    });
    await client.next("chat.done");

    const { input } = runner.received[0];
    assert.match(input.text, /<attached-file name="DESIGN.md">\n# DESIGN\nPrimary #3366FF\n<\/attached-file>/);
    assert.match(runner.received[0].opts.systemPromptAppend, /No layer is selected on the canvas/);

    client.send({ type: "chat.history", rid: "h1", conversationId: "c1" });
    const history = await client.next("chat.history", (message) => message.rid === "h1");
    const [stored] = history.messages[0].attachments ?? [];
    assert.equal(stored.kind, "file");
    assert.equal("base64" in stored, false);
    const path = (stored as { path: string }).path;
    assert.match(path, /^\.penforge\/uploads\/.*-DESIGN\.md$/);
    assert.deepEqual(readFileSync(join(home, "projects", PROJECT_ID, path)), markdown);
});

test("messages with attached layers get no missing-selection note", async () => {
    const client = await withContext();
    client.send({
        type: "chat.send",
        rid: "r1",
        conversationId: "c1",
        text: "make it blue",
        attachments: [{ kind: "node", fileId: "file-1", pageId: "page-1", nodeId: "n1", name: "Button", type: "rect" }],
    });
    await client.next("chat.done");
    assert.doesNotMatch(runner.received[0].opts.systemPromptAppend, /No layer is selected/);
    assert.match(runner.received[0].input.text, /Layer "Button"/);
});

test("a refused file ends the turn with an error and stores nothing", async () => {
    const client = await withContext();
    client.send({
        type: "chat.send",
        rid: "r1",
        conversationId: "c1",
        text: "look",
        attachments: [
            {
                kind: "file",
                name: "evil.png",
                mime: "image/png",
                size: 5,
                base64: Buffer.from("hello").toString("base64"),
            },
        ],
    });
    const error = await client.next("error");
    assert.equal(error.rid, "r1");
    assert.equal(error.code, "bad-request");
    assert.match(error.message, /evil\.png/);
    await client.next("chat.done");
    assert.equal(runner.received.length, 0);

    client.send({ type: "chat.history", rid: "h1", conversationId: "c1" });
    const history = await client.next("chat.history", (message) => message.rid === "h1");
    assert.deepEqual(history.messages, []);
});

// --- workflows

test("workflow.run chat streams progress and finishes with the answer", async () => {
    const client = await withContext();
    client.send({ type: "workflow.run", rid: "w1", name: "chat", params: { text: "hi" } });
    const started = await client.next("workflow.started");
    const done = await client.next("workflow.done");
    assert.equal(started.rid, "w1");
    assert.equal(done.runId, started.runId);
    assert.equal(done.ok, true);
    assert.equal(done.summary, "You said: hi");
});

test("a workflow question is answered with the built-in answer workflow", async () => {
    const client = await withContext();
    client.send({ type: "workflow.run", rid: "w1", name: "dummy", params: { label: "x" } });
    const { runId } = await client.next("workflow.started");
    const question = await client.next("workflow.event", (event) => event.kind === "question");
    const payload = question.payload as { questionId: string; options: { id: string }[] };
    assert.deepEqual(
        payload.options.map((option) => option.id),
        ["a", "b"]
    );

    client.send({
        type: "workflow.run",
        rid: "w2",
        name: "answer",
        params: { runId, questionId: payload.questionId, optionId: "b" },
    });
    const done = await client.next("workflow.done");

    assert.equal(done.summary, "picked b");
    const progress = await client.next("workflow.event", (event) => event.kind === "progress");
    assert.deepEqual(progress.payload, { step: 1, label: "x" });
});

test("cancelling a waiting workflow ends it as not ok", async () => {
    const client = await withContext();
    client.send({ type: "workflow.run", rid: "w1", name: "dummy", params: {} });
    const { runId } = await client.next("workflow.started");
    await client.next("workflow.event", (event) => event.kind === "question");
    client.send({ type: "workflow.cancel", runId });
    const done = await client.next("workflow.done");
    assert.equal(done.ok, false);
    assert.equal(done.error, "cancelled");
});

test("an unknown workflow is reported", async () => {
    const client = await withContext();
    client.send({ type: "workflow.run", rid: "w1", name: "nope", params: {} });
    const error = await client.next("error");
    assert.equal(error.code, "unknown-workflow");
    assert.equal(error.rid, "w1");
});

test("an answer for no pending question is refused", async () => {
    const client = await withContext();
    client.send({
        type: "workflow.run",
        rid: "w1",
        name: "answer",
        params: { runId: "x", questionId: "y", optionId: "z" },
    });
    const error = await client.next("error");
    assert.equal(error.code, "bad-request");
});

test("the registry is append-only and reserves answer", () => {
    const registry = WorkflowRegistry.withShippedWorkflows();
    assert.throws(() => registry.register({ ...dummyWorkflow, name: "chat" }), /already registered/);
    assert.throws(() => registry.register({ ...dummyWorkflow, name: "answer" }), /reserved/);
});
