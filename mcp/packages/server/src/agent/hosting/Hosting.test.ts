import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AgentError } from "../AgentClient";
import { AgentConfig } from "../AgentConfig";
import type { ToolPermissionHandler, ToolUseRequest } from "../runner/ClaudeRunner";
import { RunnerNotConfiguredError } from "../runner/ClaudeRunner";
import { PathGuard } from "../workspace/pathGuard";
import { ApiKeyProxy } from "./ApiKeyProxy";
import { HostingConfig } from "./HostingConfig";
import { PenpotCredentials, PenpotIdentity } from "./PenpotIdentity";
import { SecretBox } from "./SecretBox";
import { ServerStore } from "./ServerStore";
import { ServerToolPolicy } from "./ServerToolPolicy";
import { ServerTurns } from "./ServerTurns";
import { FakePenpotBackend } from "./testing/FakePenpotBackend";
import { RateLimitedError, TurnLimiter } from "./TurnLimiter";
import { type ApiUsage, UsageLedger } from "./UsageLedger";
import { PenpotUser, UserScope } from "./UserScope";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_A = "a0000000-0000-4000-8000-00000000000a";
const PROJECT_B = "b0000000-0000-4000-8000-00000000000b";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "penforge-hosting-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("SecretBox", () => {
    const box = new SecretBox(randomBytes(32));

    test("opens what it sealed for the same purpose", () => {
        const sealed = box.seal("sk-ant-secret", "slot-1");
        assert.ok(!sealed.includes("sk-ant-secret"));
        assert.equal(box.open(sealed, "slot-1"), "sk-ant-secret");
    });

    test("refuses another purpose, another key and tampering", () => {
        const sealed = box.seal("value", "slot-1");
        assert.throws(() => box.open(sealed, "slot-2"));
        assert.throws(() => new SecretBox(randomBytes(32)).open(sealed, "slot-1"));
        const parts = sealed.split(".");
        parts[3] = Buffer.from("other").toString("base64url");
        assert.throws(() => box.open(parts.join("."), "slot-1"));
    });

    test("digests are stable per purpose", () => {
        assert.equal(box.digest("a", "x"), box.digest("a", "x"));
        assert.notEqual(box.digest("a", "x"), box.digest("b", "x"));
    });
});

describe("HostingConfig", () => {
    const key = randomBytes(32).toString("base64");

    test("needs the backend URI and a 32-byte key", () => {
        assert.throws(() => HostingConfig.load({ PENFORGE_SECRET_KEY: key }, dir), /BACKEND_URI/);
        assert.throws(
            () => HostingConfig.load({ PENFORGE_PENPOT_BACKEND_URI: "http://backend:6060" }, dir),
            /SECRET_KEY/
        );
        assert.throws(
            () =>
                HostingConfig.load(
                    { PENFORGE_PENPOT_BACKEND_URI: "http://backend:6060", PENFORGE_SECRET_KEY: "c2hvcnQ=" },
                    dir
                ),
            /32 bytes/
        );
    });

    test("reads admins, cookie name and defaults", () => {
        const config = HostingConfig.load(
            {
                PENFORGE_PENPOT_BACKEND_URI: "http://backend:6060/",
                PENFORGE_SECRET_KEY: key,
                PENFORGE_ADMIN_EMAILS: " Admin@Example.com , ops@example.com",
            },
            dir
        );
        assert.equal(config.backendUri, "http://backend:6060");
        assert.ok(config.isAdmin("admin@example.com"));
        assert.ok(!config.isAdmin("user@example.com"));
        assert.equal(config.values.cookieName, "auth-token");
        assert.equal(config.values.anthropicUrl, HostingConfig.DEFAULT_ANTHROPIC_URL);
        assert.equal(config.teamsDir, join(dir, "teams"));
    });
});

describe("ServerStore", () => {
    function store(box = new SecretBox(randomBytes(32))): ServerStore {
        return new ServerStore(box, join(dir, "settings.json"), join(dir, "secrets.enc.json"));
    }

    test("keeps API keys encrypted on disk and tells only their last characters", async () => {
        const s = store();
        assert.deepEqual(await s.apiKeyStatus(), { configured: false });
        await s.setApiKey("sk-ant-api03-installkey1234");
        assert.equal(await s.apiKey(), "sk-ant-api03-installkey1234");
        assert.deepEqual(await s.apiKeyStatus(), { configured: true, hint: "1234" });
        assert.ok(!readFileSync(join(dir, "secrets.enc.json"), "utf8").includes("installkey"));
    });

    test("a team key wins over the install key for that team only", async () => {
        const s = store();
        await s.setApiKey("sk-install-0000");
        await s.setApiKey("sk-team-a-1111", TEAM_A);
        assert.equal(await s.apiKey(TEAM_A), "sk-team-a-1111");
        assert.equal(await s.apiKey(TEAM_B), "sk-install-0000");
        await s.setApiKey("", TEAM_A);
        assert.equal(await s.apiKey(TEAM_A), "sk-install-0000");
    });

    test("refuses keys with odd characters", async () => {
        await assert.rejects(store().setApiKey("sk ant\nkey"));
    });

    test("settings start from defaults and clamp edits", async () => {
        const s = store();
        assert.deepEqual((await s.settings()).limits, ServerStore.DEFAULT_LIMITS);
        const next = await s.updateSettings({
            limits: { turnsPerMinutePerUser: -3, concurrentTurnsPerUser: 5 },
            model: " m ",
        });
        assert.equal(next.limits.turnsPerMinutePerUser, 0);
        assert.equal(next.limits.concurrentTurnsPerUser, 5);
        assert.equal(next.model, "m");
        // a new store reads the file
        assert.equal((await store().settings()).limits.concurrentTurnsPerUser, 5);
    });
});

describe("PenpotCredentials and PenpotIdentity", () => {
    test("takes only the session cookie, else a Token header, else the auth token", () => {
        const fromCookie = PenpotCredentials.from({ cookie: "a=1; auth-token=abc.def.ghi; b=2" }, "auth-token");
        assert.deepEqual(fromCookie?.headers(), { Cookie: "auth-token=abc.def.ghi" });
        const fromHeader = PenpotCredentials.from({ authorization: "Token tok-12345678" }, "auth-token");
        assert.deepEqual(fromHeader?.headers(), { Authorization: "Token tok-12345678" });
        const fromAuth = PenpotCredentials.from({}, "auth-token", "tok-abcdefgh");
        assert.deepEqual(fromAuth?.headers(), { Authorization: "Token tok-abcdefgh" });
        assert.equal(PenpotCredentials.from({ cookie: "other=1" }, "auth-token", ""), null);
        assert.equal(PenpotCredentials.from({}, "auth-token", "bad token\n"), null);
    });

    test("resolves users and the backend's team of readable projects", async () => {
        const backend = new FakePenpotBackend()
            .addUser("alice-session", { id: ALICE, email: "Alice@Example.com" }, [TEAM_A])
            .addProject(PROJECT_A, TEAM_A)
            .addProject(PROJECT_B, TEAM_B);
        const identity = new PenpotIdentity("http://backend", backend.fetch);
        const alice = PenpotCredentials.from({ cookie: "auth-token=alice-session" }, "auth-token")!;
        const user = await identity.user(alice);
        assert.equal(user?.profileId, ALICE);
        assert.equal(user?.email, "alice@example.com");
        assert.equal(await identity.projectTeam(alice, user!, PROJECT_A), TEAM_A);
        assert.equal(await identity.projectTeam(alice, user!, PROJECT_B), null);
        assert.equal(await identity.projectTeam(alice, user!, "../etc"), null);
        const anonymous = PenpotCredentials.from({ cookie: "auth-token=expired" }, "auth-token")!;
        assert.equal(await identity.user(anonymous), null);
    });

    test("caches answers briefly", async () => {
        let now = 0;
        const backend = new FakePenpotBackend().addUser("s", { id: ALICE, email: "a@x" }, []);
        const identity = new PenpotIdentity("http://backend", backend.fetch, 1000, () => now);
        const credentials = PenpotCredentials.from({ cookie: "auth-token=s" }, "auth-token")!;
        await identity.user(credentials);
        await identity.user(credentials);
        assert.equal(backend.calls.length, 1);
        now = 2000;
        await identity.user(credentials);
        assert.equal(backend.calls.length, 2);
    });

    test("a backend failure is an error, not an anonymous user", async () => {
        const identity = new PenpotIdentity("http://backend", async () => new Response("down", { status: 503 }));
        const credentials = PenpotCredentials.from({ cookie: "auth-token=s" }, "auth-token")!;
        await assert.rejects(identity.user(credentials), /not available/);
    });
});

describe("TurnLimiter", () => {
    const limits = {
        concurrentTurnsPerUser: 1,
        turnsPerMinutePerUser: 2,
        turnsPerDayPerUser: 3,
        monthlyTokensPerTeam: 0,
    };

    test("limits turns at the same time per user", async () => {
        const limiter = new TurnLimiter(async () => limits, new UsageLedger(dir));
        const permit = await limiter.acquire({ profileId: ALICE });
        await assert.rejects(limiter.acquire({ profileId: ALICE }), RateLimitedError);
        // another user is not affected
        (await limiter.acquire({ profileId: BOB })).release();
        permit.release();
        permit.release();
        (await limiter.acquire({ profileId: ALICE })).release();
    });

    test("limits turns per minute and per day", async () => {
        let now = Date.parse("2026-11-18T10:00:00Z");
        const limiter = new TurnLimiter(
            async () => limits,
            new UsageLedger(dir),
            () => now
        );
        (await limiter.acquire({ profileId: ALICE })).release();
        (await limiter.acquire({ profileId: ALICE })).release();
        const minute = await limiter.acquire({ profileId: ALICE }).catch((error: unknown) => error);
        assert.ok(minute instanceof RateLimitedError);
        assert.equal(minute.code, "rate-limited");
        assert.ok(minute.retryAfterS > 0 && minute.retryAfterS <= 60);
        now += 61_000;
        (await limiter.acquire({ profileId: ALICE })).release();
        now += 61_000;
        await assert.rejects(limiter.acquire({ profileId: ALICE }), /today/);
        now = Date.parse("2026-11-19T00:00:01Z");
        (await limiter.acquire({ profileId: ALICE })).release();
    });

    test("stops a team over its monthly token budget", async () => {
        const ledger = new UsageLedger(dir, () => new Date("2026-11-18T10:00:00Z"));
        const usage: ApiUsage = { inputTokens: 600, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 };
        await ledger.record({ profileId: ALICE, teamId: TEAM_A }, usage);
        const limiter = new TurnLimiter(async () => ({ ...limits, monthlyTokensPerTeam: 1000 }), ledger);
        await assert.rejects(limiter.acquire({ profileId: ALICE, teamId: TEAM_A }), /budget/);
        (await limiter.acquire({ profileId: BOB, teamId: TEAM_B })).release();
    });
});

describe("UsageLedger", () => {
    test("appends one line per request and reloads the month's totals", async () => {
        const clock = () => new Date("2026-11-18T10:00:00Z");
        const usage: ApiUsage = {
            model: "m",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheCreationTokens: 1,
        };
        await new UsageLedger(dir, clock).record({ profileId: ALICE, teamId: TEAM_A }, usage);
        await new UsageLedger(dir, clock).record({ profileId: BOB, teamId: TEAM_A }, usage);
        const lines = readFileSync(join(dir, "2026-11.jsonl"), "utf8").trim().split("\n");
        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[0]).profileId, ALICE);
        const ledger = new UsageLedger(dir, clock);
        assert.equal(await ledger.teamTokens(TEAM_A), 36);
        assert.deepEqual(await ledger.monthSummary(), { month: "2026-11", teams: { [TEAM_A]: 36 } });
    });
});

describe("ApiKeyProxy", () => {
    class Recorder {
        public readonly usages: Array<{ owner: unknown; usage: ApiUsage }> = [];
        public async record(owner: unknown, usage: ApiUsage): Promise<void> {
            this.usages.push({ owner, usage });
        }
    }

    function sse(events: unknown[]): string {
        return events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
    }

    test("swaps the ticket for the real key and meters streamed usage", async () => {
        const seen: Array<{ url: string; headers: Headers }> = [];
        const upstream: typeof fetch = async (input, init) => {
            seen.push({ url: String(input), headers: new Headers(init?.headers) });
            return new Response(
                sse([
                    {
                        type: "message_start",
                        message: {
                            model: "claude-x",
                            usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 1 },
                        },
                    },
                    { type: "content_block_delta", delta: { text: "hi" } },
                    { type: "message_delta", usage: { output_tokens: 7 } },
                ]),
                { status: 200, headers: { "content-type": "text/event-stream" } }
            );
        };
        const recorder = new Recorder();
        const proxy = new ApiKeyProxy("https://api.test", recorder, upstream);
        await proxy.start();
        try {
            const ticket = proxy.issue({ profileId: ALICE, teamId: TEAM_A }, "sk-real-key");
            assert.ok(ticket.baseUrl.startsWith("http://127.0.0.1:"));
            const response = await fetch(`${ticket.baseUrl}/v1/messages?beta=true`, {
                method: "POST",
                headers: { "x-api-key": ticket.value, "content-type": "application/json", cookie: "auth-token=x" },
                body: JSON.stringify({ model: "claude-x", messages: [] }),
            });
            assert.equal(response.status, 200);
            assert.ok((await response.text()).includes("message_delta"));
            assert.equal(seen[0].url, "https://api.test/v1/messages?beta=true");
            assert.equal(seen[0].headers.get("x-api-key"), "sk-real-key");
            assert.equal(seen[0].headers.get("cookie"), null);
            assert.deepEqual(recorder.usages[0], {
                owner: { profileId: ALICE, teamId: TEAM_A },
                usage: {
                    model: "claude-x",
                    inputTokens: 12,
                    outputTokens: 7,
                    cacheReadTokens: 3,
                    cacheCreationTokens: 0,
                },
            });
            ticket.revoke();
            const revoked = await fetch(`${ticket.baseUrl}/v1/messages`, {
                method: "POST",
                headers: { "x-api-key": ticket.value },
                body: "{}",
            });
            assert.equal(revoked.status, 401);
            assert.equal(seen.length, 1);
        } finally {
            await proxy.stop();
        }
    });

    test("meters JSON answers and refuses unknown tickets and paths", async () => {
        const upstream: typeof fetch = async () =>
            new Response(JSON.stringify({ model: "m", usage: { input_tokens: 4, output_tokens: 2 } }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        const recorder = new Recorder();
        const proxy = new ApiKeyProxy("https://api.test", recorder, upstream);
        await proxy.start();
        try {
            const ticket = proxy.issue({ profileId: BOB }, "sk-real");
            assert.equal((await fetch(`${ticket.baseUrl}/v1/messages`, { method: "POST", body: "{}" })).status, 401);
            assert.equal(
                (
                    await fetch(`${ticket.baseUrl}/v1/messages`, {
                        method: "POST",
                        headers: { "x-api-key": "pft-guess" },
                        body: "{}",
                    })
                ).status,
                401
            );
            assert.equal(
                (await fetch(`${ticket.baseUrl}/api/oauth/profile`, { headers: { "x-api-key": ticket.value } })).status,
                404
            );
            const ok = await fetch(`${ticket.baseUrl}/v1/messages`, {
                method: "POST",
                headers: { authorization: `Bearer ${ticket.value}` },
                body: "{}",
            });
            assert.equal(ok.status, 200);
            await ok.text();
            assert.equal(recorder.usages[0].usage.inputTokens, 4);
            assert.equal(recorder.usages[0].usage.outputTokens, 2);
        } finally {
            await proxy.stop();
        }
    });
});

describe("ServerToolPolicy", () => {
    function policy(): { policy: ServerToolPolicy; asked: string[] } {
        const asked: string[] = [];
        const inner: ToolPermissionHandler = {
            decide: async (request) => {
                asked.push(request.toolName);
                return { allow: true };
            },
        };
        return { policy: new ServerToolPolicy(inner, new PathGuard(dir)), asked };
    }

    function request(toolName: string, input: Record<string, unknown> = {}): ToolUseRequest {
        return { toolName, input, signal: new AbortController().signal };
    }

    test("refuses commands and URL fetches without asking", async () => {
        const { policy: p, asked } = policy();
        for (const tool of ["Bash", "PowerShell", "WebFetch"]) {
            const decision = await p.decide(request(tool, { command: "ls", url: "http://penpot-backend:6060" }));
            assert.equal(decision.allow, false);
        }
        assert.deepEqual(asked, []);
    });

    test("refuses files outside the project and inside .git", async () => {
        const { policy: p, asked } = policy();
        assert.equal((await p.decide(request("Read", { file_path: join(dir, "..", "other", "x") }))).allow, false);
        assert.equal(
            (await p.decide(request("Write", { file_path: join(dir, "app-src", ".git", "config") }))).allow,
            false
        );
        assert.equal(
            (await p.decide(request("Edit", { file_path: join(dir, "app-src", "src", "App.tsx") }))).allow,
            true
        );
        assert.equal((await p.decide(request("mcp__penpot__execute_code", { code: "1" }))).allow, true);
        assert.deepEqual(asked, ["Edit", "mcp__penpot__execute_code"]);
    });
});

describe("ServerTurns", () => {
    async function setup(withKey: boolean) {
        const box = new SecretBox(randomBytes(32));
        const store = new ServerStore(box, join(dir, "settings.json"), join(dir, "secrets.enc.json"));
        if (withKey) {
            await store.setApiKey("sk-real-secret-9876");
        }
        const ledger = new UsageLedger(join(dir, "usage"));
        const limiter = new TurnLimiter(async () => (await store.settings()).limits, ledger);
        const proxy = new ApiKeyProxy("https://api.test", ledger, async () => new Response("{}"));
        await proxy.start();
        const turns = new ServerTurns(store, limiter, proxy, join(dir, "claude"), (id) => `bridge-${id}`);
        return { turns, proxy };
    }

    test("needs a user scope and an API key", async () => {
        const { turns, proxy } = await setup(false);
        try {
            await assert.rejects(
                turns.begin(),
                (error: unknown) => error instanceof AgentError && error.code === "not-authenticated"
            );
            await assert.rejects(
                UserScope.run({ user: new PenpotUser(ALICE, "a@x", "A"), teamId: TEAM_A }, () => turns.begin()),
                RunnerNotConfiguredError
            );
        } finally {
            await proxy.stop();
        }
    });

    test("gives Claude a ticket, never the key or the daemon's secrets", async () => {
        const { turns, proxy } = await setup(true);
        process.env.PENFORGE_SECRET_KEY = "daemon-master-key";
        try {
            const turn = await UserScope.run({ user: new PenpotUser(ALICE, "a@x", "A"), teamId: TEAM_A }, () =>
                turns.begin()
            );
            const values = Object.values(turn.env).join("\n");
            assert.ok(!values.includes("sk-real-secret-9876"));
            assert.ok(!values.includes("daemon-master-key"));
            assert.equal(turn.env.PENFORGE_SECRET_KEY, undefined);
            assert.ok(turn.env.ANTHROPIC_API_KEY.startsWith("pft-"));
            assert.ok(turn.env.ANTHROPIC_BASE_URL.startsWith("http://127.0.0.1:"));
            assert.equal(turn.env.CLAUDE_CONFIG_DIR, join(dir, "claude", TEAM_A));
            assert.deepEqual(turn.mcpHeaders, { Authorization: `Bearer bridge-${ALICE}` });
            assert.equal(proxy.ticketCount, 1);
            turn.end();
            assert.equal(proxy.ticketCount, 0);
        } finally {
            delete process.env.PENFORGE_SECRET_KEY;
            await proxy.stop();
        }
    });
});

describe("AgentConfig in server mode", () => {
    test("uses the API key runner (or the fake one) and accepts the public host", () => {
        const env = {
            PENFORGE_HOME: dir,
            PENFORGE_MODE: "server",
            PENFORGE_RUNNER: "local-cli",
            PENFORGE_PUBLIC_URI: "https://penforge.example.test",
        };
        const config = AgentConfig.load(env, "http://127.0.0.1:4401/mcp");
        assert.equal(config.mode, "server");
        assert.equal(config.runner, "api-key");
        assert.deepEqual(config.allowedHosts, ["penforge.example.test", "penforge.example.test:443"]);
        assert.equal(AgentConfig.load({ ...env, PENFORGE_RUNNER: "fake" }, "x").runner, "fake");
        const local = AgentConfig.load({ PENFORGE_HOME: dir }, "x");
        assert.equal(local.mode, "local");
        assert.deepEqual(local.allowedHosts, []);
        assert.equal(
            AgentConfig.load({ ...env, PENFORGE_PUBLIC_URI: "https://localhost:8443" }, "x").allowedHosts[0],
            "localhost:8443"
        );
    });
});
