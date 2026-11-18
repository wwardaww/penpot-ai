import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ContextSetMessage } from "@penpot/mcp-common";
import { AgentConfig } from "./AgentConfig";
import { AgentServer, PairingToken } from "./AgentServer";
import { PenforgeDaemon } from "./PenforgeDaemon";
import { DownloadRegistry } from "./publish/DownloadRegistry";
import { FakeRunner, ReplayScript } from "./runner/FakeRunner";
import { AgentTestClient } from "./testing/AgentTestClient";

// W11 end-to-end tests: the daemon is built from environment variables, exactly as
// `PENFORGE_RUNNER=fake PENFORGE_FAKE_RECORDING=<file>` starts it for the Playwright runs, and
// driven over its WebSocket like the frontend does.

const ORIGIN = "https://localhost:3449";
const RECORDING = join(dirname(fileURLToPath(import.meta.url)), "testing", "recordings", "chat-basic.json");

const CONTEXT: ContextSetMessage = {
    type: "context.set",
    fileId: "file-e2e",
    fileName: "Checkout",
    projectId: "5b0c7a4e-1f0e-4f43-9d1f-2a1d6f0e9e11",
    projectName: "Shop",
    teamId: "team-e2e",
    pageId: "page-1",
    persona: "designer",
    platform: "web",
    mcpSessionId: "tab-e2e",
};

let home: string;
let daemon: PenforgeDaemon;
let clients: AgentTestClient[];

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-e2e-"));
    const config = AgentConfig.load(
        {
            PENFORGE_HOME: home,
            PENFORGE_AGENT_PORT: "0",
            PENFORGE_RUNNER: "fake",
            PENFORGE_FAKE_RECORDING: RECORDING,
            PENFORGE_ALLOWED_ORIGINS: ORIGIN,
        },
        "http://127.0.0.1:1/mcp"
    );
    daemon = new PenforgeDaemon(config, { tools: null, authTimeoutMs: 500 });
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

async function connect(): Promise<AgentTestClient> {
    const client = await AgentTestClient.connect(`ws://127.0.0.1:${daemon.port}/agent`, ORIGIN);
    clients.push(client);
    client.send({ type: "auth", token: "" });
    await client.next("auth.ok");
    client.send(CONTEXT);
    client.send({ type: "chat.history", rid: "barrier", conversationId: "barrier" });
    await client.next("chat.history");
    return client;
}

function deltaText(client: AgentTestClient): string {
    return client
        .drain()
        .filter((message) => message.type === "chat.delta")
        .map((message) => (message as { text: string }).text)
        .join("");
}

test("the environment selects the replaying fake runner", () => {
    assert.equal(daemon.runner.kind, "fake");
    assert.equal(daemon.config.host, "127.0.0.1");
    assert.equal(daemon.config.requirePairing, false);
});

test("a recorded chat turn streams its tools and text to the browser", async () => {
    const client = await connect();
    client.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "make the button blue" });
    const reading = await client.next("chat.tool", (message) => message.status === "done");
    assert.equal(reading.summary, "Reading the design");
    const working = await client.next("chat.tool", (message) => message.status === "done");
    assert.equal(working.summary, "Working on the design");
    const done = await client.next("chat.done");
    assert.equal(deltaText(client), "I made the button blue.");
    assert.deepEqual(done.usage, { inputTokens: 120, outputTokens: 12 });
});

test("the recorded answer is kept in the conversation history", async () => {
    const client = await connect();
    client.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "make the button blue" });
    await client.next("chat.done");
    client.send({ type: "chat.history", rid: "h1", conversationId: "c1" });
    const history = await client.next("chat.history", (message) => message.rid === "h1");
    const texts = history.messages.map((message) => message.text);
    assert.deepEqual(texts, ["make the button blue", "I made the button blue."]);
});

test("a recorded failure reaches the browser as an error and still ends the turn", async () => {
    const client = await connect();
    client.send({ type: "chat.send", rid: "r2", conversationId: "c2", text: "break it" });
    const failed = await client.next("chat.tool", (message) => message.status === "error");
    assert.equal(failed.toolName, "mcp__penpot__execute_code");
    const error = await client.next("error");
    assert.equal(error.rid, "r2");
    assert.equal(error.code, "internal");
    await client.next("chat.done");
});

test("text without a recorded turn falls back to the echo script", async () => {
    const client = await connect();
    client.send({ type: "chat.send", rid: "r3", conversationId: "c3", text: "hello" });
    await client.next("chat.done");
    assert.equal(deltaText(client), "You said: hello");
});

test("stopping the daemon closes the browser sessions", async () => {
    const client = await connect();
    await daemon.stop();
    const closed = await client.closed;
    assert.equal(closed.code, 1001);
    // afterEach stops again; a second stop must be harmless
});

test("a malformed recording is refused when the runner is built", () => {
    assert.throws(() => new ReplayScript({ turns: [{ events: [{ kind: "nope" } as never] }] }), /invalid event list/);
    assert.throws(() => new ReplayScript({} as never), /turns/);
});

test("the replay pauses between events when the recording asks for it", async () => {
    const pauses: number[] = [];
    const runner = new FakeRunner(
        new ReplayScript(
            { turns: [{ delayMs: 25, events: [{ kind: "done", messageId: "m", text: "ok" }] }] },
            async (ms) => {
                pauses.push(ms);
            }
        )
    );
    const events = [];
    for await (const event of runner.send({ id: "c" }, { text: "x" } as never, {} as never)) {
        events.push(event);
    }
    assert.deepEqual(pauses, [25]);
    assert.equal(events.length, 1);
});

// --- security checks of the HTTP endpoint (W11 review) ---

function httpGet(
    port: number,
    path: string,
    headers: Record<string, string>
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end();
    });
}

test("the download route answers allowed origins once and refuses foreign ones", async () => {
    const downloads = new DownloadRegistry();
    const config = new AgentConfig({
        home,
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: [ORIGIN],
        publicUri: ORIGIN,
        runner: "fake",
        mcpUrl: "http://127.0.0.1:1/mcp",
    });
    const server = new AgentServer(config, new PairingToken(), {} as never, () => ({}), downloads);
    await server.start();
    try {
        const host = `127.0.0.1:${server.port}`;
        const id = downloads.add({ filename: "app.zip", contentType: "application/zip", content: Buffer.from("PK") });

        const foreign = await httpGet(server.port, `/download/${id}`, { host, origin: "https://evil.example" });
        assert.equal(foreign.status, 403);
        assert.equal(foreign.headers["access-control-allow-origin"], undefined);

        const rebound = await httpGet(server.port, `/download/${id}`, { host: `evil.example:${server.port}` });
        assert.equal(rebound.status, 403);

        const ok = await httpGet(server.port, `/download/${id}`, { host, origin: ORIGIN });
        assert.equal(ok.status, 200);
        assert.equal(ok.body, "PK");
        assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
        assert.equal(ok.headers["cache-control"], "no-store");

        const again = await httpGet(server.port, `/download/${id}`, { host, origin: ORIGIN });
        assert.equal(again.status, 404);
    } finally {
        await server.stop();
    }
});

test("a daemon bound beyond loopback always requires the pairing token", () => {
    const at = (host: string) =>
        AgentConfig.load({ PENFORGE_HOME: home, PENFORGE_AGENT_HOST: host }, "http://127.0.0.1:1/mcp").requirePairing;
    assert.equal(at("127.0.0.1"), false);
    assert.equal(at("localhost"), false);
    assert.equal(at("::1"), false);
    assert.equal(at("[::1]"), false);
    assert.equal(at("127.10.0.3"), false);
    assert.equal(at("0.0.0.0"), true);
    assert.equal(at("::"), true);
    assert.equal(at("192.168.1.20"), true);
    assert.equal(at("penforge.example"), true);
    assert.equal(at("127.0.0.1.example"), true);
});

test("the pairing URL goes to the console, never into the log", () => {
    const token = new PairingToken();
    const lines: string[] = [];
    token.announce(ORIGIN, (line) => lines.push(line));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(encodeURIComponent(token.value)));
    const masked = token.maskedPairUrl(ORIGIN);
    assert.ok(!masked.includes(token.value));
    assert.match(masked, /^https:\/\/localhost:3449\/#\/penforge\/pair\?token=/);
});
