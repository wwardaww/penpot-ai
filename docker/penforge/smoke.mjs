#!/usr/bin/env node
// Smoke test of a running Penforge server stack (two users, isolation, admin).
//
// Run from mcp/packages/server (after `pnpm install`) so that `ws` resolves:
//
//   node ../../../docker/penforge/smoke.mjs https://localhost:9443 --insecure
//
// Run it on a fresh stack: it registers the admin (default admin@example.test,
// override with --admin <email>; it must be in PENFORGE_ADMIN_EMAILS) and a
// second user. With PENFORGE_RUNNER=fake
// the chat replies "You said: ..." without calling Anthropic.

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "smoke.cjs"));
const WebSocket = require("ws");

const args = process.argv.slice(2);
const publicUri = (args.find((arg) => /^https?:\/\//.test(arg)) ?? "https://localhost:9443").replace(/\/+$/, "");
const insecure = args.includes("--insecure");
const adminEmail = args.includes("--admin") ? args[args.indexOf("--admin") + 1] : "admin@example.test";
if (insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}
const wsBase = publicUri.replace(/^http/, "ws");
const run = randomBytes(3).toString("hex");
const results = [];

function check(name, ok, detail = "") {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function rpc(method, params, cookie, verb = "POST") {
    const url = new URL(`${publicUri}/api/main/methods/${method}`);
    const init = {
        method: verb,
        headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        redirect: "manual",
    };
    if (verb === "GET") {
        for (const [key, value] of Object.entries(params ?? {})) {
            url.searchParams.set(key, value);
        }
    } else {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(params ?? {});
    }
    const response = await fetch(url, init);
    const text = await response.text();
    const setCookie = response.headers.getSetCookie?.() ?? [];
    const session = setCookie.map((value) => /^(auth-token=[^;]+)/.exec(value)?.[1]).find(Boolean);
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }
    return { status: response.status, body, session };
}

async function register(email) {
    const password = `Pw-${randomBytes(9).toString("hex")}-9!`;
    const prepared = await rpc("prepare-register-profile", { fullname: email.split("@")[0], email, password });
    if (prepared.status !== 200) {
        throw new Error(`prepare-register-profile ${prepared.status}: ${JSON.stringify(prepared.body)}`);
    }
    const registered = await rpc("register-profile", { token: prepared.body.token });
    let session = registered.session;
    if (!session) {
        session = (await rpc("login-with-password", { email, password })).session;
    }
    if (!session) {
        throw new Error(`no session for ${email} (register ${registered.status})`);
    }
    const profile = (await rpc("get-profile", {}, session, "GET")).body;
    return { email, session, profile, projectId: profile.defaultProjectId, teamId: profile.defaultTeamId };
}

class Socket {
    constructor(url, headers) {
        this.inbox = [];
        this.waiters = [];
        this.ws = new WebSocket(url, { headers, rejectUnauthorized: !insecure });
        this.closed = new Promise((resolve) => this.ws.on("close", (code) => resolve(code)));
        this.opened = new Promise((resolve, reject) => {
            this.ws.once("open", resolve);
            this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
            this.ws.once("error", reject);
        });
        this.ws.on("message", (data) => {
            const message = JSON.parse(data.toString());
            const index = this.waiters.findIndex((waiter) => waiter.match(message));
            if (index >= 0) {
                this.waiters.splice(index, 1)[0].resolve(message);
            } else {
                this.inbox.push(message);
            }
        });
    }

    send(message) {
        this.ws.send(JSON.stringify(message));
    }

    next(match, timeoutMs = 15000) {
        const index = this.inbox.findIndex(match);
        if (index >= 0) {
            return Promise.resolve(this.inbox.splice(index, 1)[0]);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
            this.waiters.push({
                match,
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message);
                },
            });
        });
    }

    close() {
        this.ws.close();
    }
}

function agent(user) {
    return new Socket(`${wsBase}/penforge/agent`, {
        Origin: publicUri,
        ...(user ? { Cookie: user.session } : {}),
    });
}

function context(user, projectId, tab) {
    return {
        type: "context.set",
        fileId: `file-${tab}`,
        fileName: "Smoke",
        projectId,
        teamId: "claimed-by-browser",
        pageId: "page-1",
        persona: "designer",
        platform: "web",
        mcpSessionId: tab,
    };
}

async function signedIn(user, tab) {
    const socket = agent(user);
    await socket.opened;
    socket.send({ type: "auth", token: "" });
    const auth = await socket.next((m) => m.type === "auth.ok" || m.type === "auth.error");
    if (auth.type !== "auth.ok") {
        throw new Error(`auth failed for ${user.email}: ${auth.reason}`);
    }
    socket.send(context(user, user.projectId, tab));
    socket.send({ type: "chat.history", rid: "barrier", conversationId: "barrier" });
    await socket.next((m) => m.type === "chat.history" || m.type === "error");
    return socket;
}

async function main() {
    const health = await fetch(`${publicUri}/penforge/health`).then((r) => r.json());
    check("agent health through the proxy", health.ok === true && health.mode === "server", `runner ${health.runner}`);

    const anonymous = agent(null);
    await anonymous.opened;
    anonymous.send({ type: "auth", token: "" });
    const refused = await anonymous.next((m) => m.type === "auth.error" || m.type === "auth.ok");
    check("agent refuses a browser without a Penpot session", refused.type === "auth.error");

    const alice = await register(adminEmail);
    const bob = await register(`bob-${run}@example.test`);
    check("two users registered", Boolean(alice.projectId && bob.projectId && alice.teamId !== bob.teamId));

    const [sa, sb] = await Promise.all([signedIn(alice, "tab-a"), signedIn(bob, "tab-b")]);
    sa.send({ type: "chat.send", rid: "a1", conversationId: "smoke", text: `hello from ${alice.email}` });
    sb.send({ type: "chat.send", rid: "b1", conversationId: "smoke", text: `hello from ${bob.email}` });
    const [doneA, doneB] = await Promise.all([
        sa.next((m) => m.type === "chat.done" || m.type === "error"),
        sb.next((m) => m.type === "chat.done" || m.type === "error"),
    ]);
    check("both users chat at the same time", doneA.type === "chat.done" && doneB.type === "chat.done",
        `${doneA.type}/${doneB.type}${doneA.message ? `: ${doneA.message}` : ""}`);
    sa.send({ type: "chat.history", rid: "ha", conversationId: "smoke" });
    const historyA = JSON.stringify((await sa.next((m) => m.type === "chat.history" && m.rid === "ha")).messages);
    check("a user's history holds only their own messages", historyA.includes(alice.email) && !historyA.includes(bob.email));

    sa.send(context(alice, bob.projectId, "tab-a"));
    const forbidden = await sa.next((m) => m.type === "error");
    check("a user cannot open another team's project", forbidden.code === "forbidden", forbidden.code);

    sb.send({ type: "preview.start", rid: "p1", projectId: bob.projectId });
    const preview = await sb.next((m) => m.type === "error" && m.rid === "p1");
    check("preview refuses without the sandbox", preview.code === "not-configured", preview.message);
    sa.close();
    sb.close();

    const bridge = new Socket(`${wsBase}/penforge/mcp/ws`, { Origin: publicUri, Cookie: alice.session });
    await bridge.opened;
    bridge.send({ type: "initialize", session: { sessionId: `smoke-${run}`, fileId: "f", fileName: "Smoke" } });
    const initialized = await bridge.next((m) => m.type === "initialized").catch(() => null);
    check("plugin bridge accepts a signed-in tab", initialized !== null);
    bridge.close();
    const stranger = new Socket(`${wsBase}/penforge/mcp/ws`, { Origin: publicUri });
    await stranger.opened;
    stranger.send({ type: "initialize", session: { sessionId: `x-${run}`, fileId: "f", fileName: "X" } });
    const code = await Promise.race([stranger.closed, new Promise((r) => setTimeout(() => r("open"), 5000))]);
    check("plugin bridge closes a tab without a session", code !== "open", String(code));

    const page = await fetch(`${publicUri}/penforge/admin/`, { headers: { Cookie: alice.session } });
    const denied = await fetch(`${publicUri}/penforge/admin/`, { headers: { Cookie: bob.session } });
    check("admin page for admins only", page.status === 200 && denied.status === 403, `${page.status}/${denied.status}`);
    const saved = await fetch(`${publicUri}/penforge/admin/api/api-key`, {
        method: "PUT",
        headers: { Cookie: alice.session, Origin: publicUri, "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: `sk-ant-smoke-${run}-abcd` }),
    });
    const state = await saved.json();
    check("admin stores the API key without showing it", saved.status === 200 && state.apiKey?.hint === "abcd"
        && !JSON.stringify(state).includes(`smoke-${run}`));

    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error("FAIL  smoke run:", error.message);
    process.exit(1);
});
