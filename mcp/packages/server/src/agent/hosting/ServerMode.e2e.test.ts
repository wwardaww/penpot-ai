import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ContextSetMessage } from "@penpot/mcp-common";
import { AgentConfig } from "../AgentConfig";
import { PenforgeDaemon } from "../PenforgeDaemon";
import { FakeRunner } from "../runner/FakeRunner";
import { AgentTestClient } from "../testing/AgentTestClient";
import { HostingConfig } from "./HostingConfig";
import { ServerHosting } from "./ServerHosting";
import { FakePenpotBackend } from "./testing/FakePenpotBackend";

const ORIGIN = "https://penforge.example.test";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_A = "a0000000-0000-4000-8000-00000000000a";
const PROJECT_B = "b0000000-0000-4000-8000-00000000000b";

function context(projectId: string, mcpSessionId: string): ContextSetMessage {
    return {
        type: "context.set",
        fileId: `file-${projectId.slice(0, 4)}`,
        fileName: "Screens",
        projectId,
        projectName: "Shop",
        // the browser's claim; the daemon must use the backend's team instead
        teamId: "browser-claimed-team",
        pageId: "page-1",
        persona: "designer",
        platform: "web",
        mcpSessionId,
    };
}

let home: string;
let backend: FakePenpotBackend;
let hosting: ServerHosting;
let daemon: PenforgeDaemon;
let clients: AgentTestClient[];

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-server-"));
    backend = new FakePenpotBackend()
        .addUser("alice-session", { id: ALICE, email: "alice@example.test" }, [TEAM_A])
        .addUser("bob-session", { id: BOB, email: "bob@example.test" }, [TEAM_B])
        .addUser("admin-session", { id: ADMIN, email: "admin@example.test" }, [])
        .addProject(PROJECT_A, TEAM_A)
        .addProject(PROJECT_B, TEAM_B);
    const agent = new AgentConfig({
        home,
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: [ORIGIN],
        publicUri: ORIGIN,
        runner: "fake",
        mcpUrl: "http://127.0.0.1:1/mcp",
        mode: "server",
    });
    const config = new HostingConfig({
        home,
        backendUri: "http://penpot-backend:6060",
        secretKey: randomBytes(32),
        adminEmails: ["admin@example.test"],
        anthropicUrl: "https://api.test",
        cookieName: "auth-token",
    });
    hosting = new ServerHosting(config, agent, { backendFetch: backend.fetch });
    daemon = new PenforgeDaemon(agent, { runner: new FakeRunner(), tools: null, hosting, authTimeoutMs: 1000 });
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

async function connect(session?: string): Promise<AgentTestClient> {
    const client = await AgentTestClient.connect(
        `ws://127.0.0.1:${daemon.port}/agent`,
        ORIGIN,
        session ? { Cookie: `theme=dark; auth-token=${session}` } : undefined
    );
    clients.push(client);
    return client;
}

async function signedIn(session: string, projectId: string, tab: string): Promise<AgentTestClient> {
    const client = await connect(session);
    client.send({ type: "auth", token: "" });
    await client.next("auth.ok");
    client.send(context(projectId, tab));
    client.send({ type: "chat.history", rid: "barrier", conversationId: "barrier" });
    await client.next("chat.history");
    return client;
}

function http(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown
): Promise<{ status: number; text: string }> {
    return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
    }).then(async (response) => ({ status: response.status, text: await response.text() }));
}

test("a connection without a Penpot session is refused", async () => {
    const client = await connect();
    client.send({ type: "auth", token: "" });
    const error = await client.next("auth.error");
    assert.match(error.reason, /Not logged in/);
    assert.equal((await client.closed).code, 1008);
});

test("an expired session is refused, a valid one is accepted", async () => {
    const expired = await connect("expired-session");
    expired.send({ type: "auth", token: "" });
    await expired.next("auth.error");
    const alice = await connect("alice-session");
    alice.send({ type: "auth", token: "" });
    assert.equal((await alice.next("auth.ok")).type, "auth.ok");
});

test("messages sent right after auth wait for the session check", async () => {
    const client = await connect("alice-session");
    client.send({ type: "auth", token: "" });
    client.send(context(PROJECT_A, "tab-a"));
    client.send({ type: "chat.history", rid: "h", conversationId: "c" });
    await client.next("auth.ok");
    const history = await client.next("chat.history");
    assert.deepEqual(history.messages, []);
});

test("project folders live under the backend's team, never the browser's claim", async () => {
    await signedIn("alice-session", PROJECT_A, "tab-a");
    assert.ok(existsSync(join(home, "teams", TEAM_A, "projects", PROJECT_A, "app-src")));
    assert.ok(!existsSync(join(home, "teams", "browser-claimed-team")));
    assert.ok(!existsSync(join(home, "projects")));
    const info = JSON.parse(
        readFileSync(join(home, "teams", TEAM_A, "projects", PROJECT_A, ".penforge", "project.json"), "utf8")
    );
    assert.equal(info.teamId, TEAM_A);
});

test("a project of another team is refused", async () => {
    const alice = await connect("alice-session");
    alice.send({ type: "auth", token: "" });
    await alice.next("auth.ok");
    alice.send(context(PROJECT_B, "tab-a"));
    const error = await alice.next("error");
    assert.equal(error.code, "forbidden");
    alice.send({ type: "chat.send", rid: "r1", conversationId: "c1", text: "hello" });
    assert.equal((await alice.next("error", (message) => message.rid === "r1")).code, "no-context");
    assert.ok(!existsSync(join(home, "teams", TEAM_B)));
});

test("two users chat at the same time, each in their own team's project", async () => {
    const [alice, bob] = await Promise.all([
        signedIn("alice-session", PROJECT_A, "tab-a"),
        signedIn("bob-session", PROJECT_B, "tab-b"),
    ]);
    alice.send({ type: "chat.send", rid: "a1", conversationId: "same-id", text: "from alice" });
    bob.send({ type: "chat.send", rid: "b1", conversationId: "same-id", text: "from bob" });
    await Promise.all([alice.next("chat.done"), bob.next("chat.done")]);
    alice.send({ type: "chat.history", rid: "ha", conversationId: "same-id" });
    bob.send({ type: "chat.history", rid: "hb", conversationId: "same-id" });
    const historyA = JSON.stringify((await alice.next("chat.history", (m) => m.rid === "ha")).messages);
    const historyB = JSON.stringify((await bob.next("chat.history", (m) => m.rid === "hb")).messages);
    assert.ok(historyA.includes("from alice") && !historyA.includes("from bob"));
    assert.ok(historyB.includes("from bob") && !historyB.includes("from alice"));
});

test("previews refuse to run generated code on the server", async () => {
    const alice = await signedIn("alice-session", PROJECT_A, "tab-a");
    alice.send({ type: "preview.start", rid: "p1", projectId: PROJECT_A });
    const error = await alice.next("error", (message) => message.rid === "p1");
    assert.equal(error.code, "not-configured");
    assert.match(error.message, /sandbox/);
});

test("health tells the mode and pairing is off", async () => {
    const health = JSON.parse((await http("GET", "/health")).text);
    assert.equal(health.mode, "server");
    assert.equal((await http("GET", "/pair")).status, 404);
});

test("the admin page is for admins only", async () => {
    assert.equal((await http("GET", "/admin/")).status, 401);
    assert.equal((await http("GET", "/admin/", { Cookie: "auth-token=bob-session" })).status, 403);
    const page = await http("GET", "/admin/", { Cookie: "auth-token=admin-session" });
    assert.equal(page.status, 200);
    assert.match(page.text, /Penforge admin/);
    assert.equal((await http("GET", "/admin")).status, 302);
});

test("admins set the API key with a same-origin JSON request; the key never comes back", async () => {
    const admin = { Cookie: "auth-token=admin-session", "Content-Type": "application/json" };
    const key = "sk-ant-api03-very-secret-key-WXYZ";
    assert.equal((await http("PUT", "/admin/api/api-key", admin, { apiKey: key })).status, 403);
    assert.equal(
        (await http("PUT", "/admin/api/api-key", { ...admin, Origin: "https://evil.test" }, { apiKey: key })).status,
        403
    );
    assert.equal(
        (
            await http(
                "PUT",
                "/admin/api/api-key",
                { Cookie: "auth-token=bob-session", "Content-Type": "application/json", Origin: ORIGIN },
                { apiKey: key }
            )
        ).status,
        403
    );
    const saved = await http("PUT", "/admin/api/api-key", { ...admin, Origin: ORIGIN }, { apiKey: key });
    assert.equal(saved.status, 200);
    assert.ok(!saved.text.includes("very-secret"));
    assert.deepEqual(JSON.parse(saved.text).apiKey, { configured: true, hint: "WXYZ" });
    assert.equal(await hosting.store.apiKey(), key);
    const state = await http("GET", "/admin/api/state", { Cookie: "auth-token=admin-session" });
    assert.ok(!state.text.includes("very-secret"));

    const limits = await http(
        "PUT",
        "/admin/api/settings",
        { ...admin, Origin: ORIGIN },
        { limits: { turnsPerMinutePerUser: 3 }, model: "claude-test" }
    );
    assert.equal(limits.status, 200);
    assert.equal(JSON.parse(limits.text).settings.limits.turnsPerMinutePerUser, 3);
    assert.equal((await hosting.store.settings()).model, "claude-test");
});

test("the plugin bridge keys connections with the user's token, from allowed origins only", async () => {
    const authenticator = hosting.bridgeAuthenticator();
    const upgrade = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
    assert.equal(
        await authenticator.userTokenFor(upgrade({ origin: ORIGIN, cookie: "auth-token=alice-session" })),
        hosting.bridgeToken(ALICE)
    );
    assert.notEqual(hosting.bridgeToken(ALICE), hosting.bridgeToken(BOB));
    assert.equal(
        await authenticator.userTokenFor(upgrade({ origin: "https://evil.test", cookie: "auth-token=alice-session" })),
        null
    );
    assert.equal(await authenticator.userTokenFor(upgrade({ origin: ORIGIN })), null);
    assert.equal(await authenticator.userTokenFor(upgrade({ origin: ORIGIN, cookie: "auth-token=expired" })), null);
});
