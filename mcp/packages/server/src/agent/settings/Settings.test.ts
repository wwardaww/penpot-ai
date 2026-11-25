import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SettingsMessage, SettingsTestedMessage, Workflow } from "@penpot/mcp-common";
import { AgentConfig } from "../AgentConfig";
import { ClaudeCommands } from "../claude/ClaudeCommands";
import { PenforgeDaemon } from "../PenforgeDaemon";
import { PermissionModeState } from "../permissions/PermissionModeState";
import { FakeRunner } from "../runner/FakeRunner";
import { AgentTestClient } from "../testing/AgentTestClient";
import { WorkflowRegistry } from "../workflows/WorkflowRegistry";
import { SettingsService } from "./SettingsService";
import { UserSettings } from "./UserSettings";

const ORIGIN = "https://localhost:3449";
const CONTEXT = {
    type: "context.set",
    fileId: "file-1",
    fileName: "Landing page",
    projectId: "0d6c3c1e-4c39-4a0e-9a35-3c4b8f7f1a02",
    teamId: "team-1",
    pageId: "page-1",
    persona: "designer",
    platform: "web",
} as const;

const OPTIONS = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
];

/** Asks one question with a recommended option, then one without. */
const asking: Workflow<{ open?: boolean }> = {
    name: "asking",
    description: "Test workflow",
    run: async (ctx, params) => {
        const choice = await ctx.ask({ text: "Pick one", options: OPTIONS, recommended: "b" });
        return { summary: params.open ? await ctx.ask({ text: "Publish?", options: OPTIONS }) : choice };
    },
};

let home: string;
let runner: FakeRunner;
let daemon: PenforgeDaemon;
let clients: AgentTestClient[];

async function startDaemon(): Promise<void> {
    runner = new FakeRunner();
    const registry = WorkflowRegistry.withShippedWorkflows();
    registry.register(asking);
    const config = new AgentConfig({
        home,
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: [ORIGIN],
        publicUri: ORIGIN,
        runner: "fake",
        mcpUrl: "http://127.0.0.1:1/mcp",
        requirePairing: true,
    });
    const env = { HOME: home, PATH: [home, join(process.execPath, "..")].join(delimiter) };
    daemon = new PenforgeDaemon(config, {
        runner,
        registry,
        tools: null,
        claudeCommands: new ClaudeCommands({ env, home, shell: null }),
    });
    await daemon.start();
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-settings-"));
    clients = [];
    await startDaemon();
});

afterEach(async () => {
    for (const client of clients) {
        client.close();
    }
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
});

async function connected(withContext = false): Promise<AgentTestClient> {
    const client = await AgentTestClient.connect(`ws://127.0.0.1:${daemon.port}/agent`, ORIGIN);
    clients.push(client);
    client.send({ type: "auth", token: daemon.token.value });
    await client.next("auth.ok");
    if (withContext) {
        client.send(CONTEXT);
    }
    return client;
}

describe("the settings of the local daemon", () => {
    test("start as claude and manual", async () => {
        const client = await connected();
        client.send({ type: "settings.get", rid: "r1" });
        assert.deepEqual(await client.next("settings"), {
            type: "settings",
            rid: "r1",
            scope: "machine",
            permissionMode: "manual",
            claudeCommand: "claude",
        });
    });

    test("need an authenticated client", async () => {
        const client = await AgentTestClient.connect(`ws://127.0.0.1:${daemon.port}/agent`, ORIGIN);
        clients.push(client);
        client.send({ type: "settings.set", rid: "r1", claudeCommand: "evil" });
        await client.next("auth.error");
        const other = await connected();
        other.send({ type: "settings.get", rid: "r1" });
        assert.equal((await other.next("settings")).claudeCommand, "claude");
    });

    test("are stored for the next start and sent to every client", async () => {
        const client = await connected();
        const other = await connected();
        client.send({ type: "settings.set", rid: "r1", claudeCommand: " claude-local ", permissionMode: "auto" });
        const expected = {
            type: "settings",
            scope: "machine",
            permissionMode: "auto",
            claudeCommand: "claude-local",
        };
        assert.deepEqual(await client.next("settings"), { ...expected, rid: "r1" });
        assert.deepEqual(await other.next("settings"), expected);
        const file = join(home, "settings.json");
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
            claudeCommand: "claude-local",
            permissionMode: "auto",
        });
        if (process.platform !== "win32") {
            assert.equal(statSync(file).mode & 0o777, 0o600);
        }

        await daemon.stop();
        await startDaemon();
        const later = await connected();
        later.send({ type: "settings.set", rid: "r2", claudeCommand: "" });
        assert.deepEqual(await later.next("settings"), {
            ...expected,
            rid: "r2",
            claudeCommand: "claude",
        });
    });

    test("refuse a command with arguments and change nothing else then", async () => {
        const client = await connected();
        for (const claudeCommand of ["claude --model x", "./claude", "claude;ls"]) {
            client.send({ type: "settings.set", rid: "r1", claudeCommand, permissionMode: "auto" });
            const error = await client.next("error");
            assert.deepEqual([error.rid, error.code, error.reason], ["r1", "bad-request", "claude-command"]);
        }
        client.send({ type: "settings.test", rid: "r2", claudeCommand: "claude --version" });
        assert.equal((await client.next("error")).reason, "claude-command");
        client.send({ type: "settings.set", rid: "r3", permissionMode: "yes" });
        assert.equal((await client.next("error")).code, "bad-request");
        client.send({ type: "settings.get", rid: "r4" });
        const settings = await client.next("settings");
        assert.deepEqual([settings.permissionMode, settings.claudeCommand], ["manual", "claude"]);
    });

    test("a damaged file counts as the defaults", () => {
        const file = join(home, "damaged.json");
        for (const text of ["{", "null", '{"claudeCommand": "claude; ls", "permissionMode": "always"}']) {
            writeFileSync(file, text);
            assert.deepEqual(new UserSettings(file).current, { claudeCommand: "claude", permissionMode: "manual" });
        }
    });

    test("a command can be tested before it is saved", { skip: process.platform === "win32" }, async () => {
        writeFileSync(join(home, "claude-next"), "#!/usr/bin/env node\nconsole.log('3.2.1 (Claude Code)');\n");
        chmodSync(join(home, "claude-next"), 0o755);
        const client = await connected();
        client.send({ type: "settings.test", rid: "r1", claudeCommand: "claude-next" });
        assert.deepEqual(await client.next("settings.tested"), {
            type: "settings.tested",
            rid: "r1",
            claudeCommand: "claude-next",
            found: true,
            kind: "program",
            path: join(home, "claude-next"),
            version: "3.2.1",
        });
        client.send({ type: "settings.test", rid: "r2", claudeCommand: "claude-missing" });
        const missing = await client.next("settings.tested");
        assert.deepEqual([missing.found, missing.problem], [false, "not-found"]);
        client.send({ type: "settings.get", rid: "r3" });
        assert.equal((await client.next("settings")).claudeCommand, "claude");
    });
});

describe("switching the permission mode", () => {
    test("answers an open permission card of another tab at once", async () => {
        const client = await connected(true);
        const other = await connected();
        client.send({ type: "chat.send", rid: "c1", conversationId: "c", text: "/permission" });
        const { requestId } = await client.next("permission.request");
        other.send({ type: "settings.set", rid: "r1", permissionMode: "auto" });
        assert.deepEqual(await client.next("permission.answered"), {
            type: "permission.answered",
            requestId,
            allow: true,
            auto: true,
        });
        await client.next("chat.done");

        // an answer that arrives now finds no question
        client.send({ type: "permission.respond", requestId, allow: false });
        assert.equal((await client.next("error")).code, "bad-request");
    });

    test("tells Claude in the prompt that the user is away", async () => {
        const client = await connected(true);
        const prompts = async (): Promise<string> => {
            client.send({ type: "chat.send", rid: "c1", conversationId: "c", text: "hi" });
            await client.next("chat.done");
            return runner.received.at(-1)!.opts.systemPromptAppend;
        };
        assert.doesNotMatch(await prompts(), /The user is away/);
        client.send({ type: "settings.set", rid: "r1", permissionMode: "auto" });
        await client.next("settings");
        assert.match(await prompts(), /The user is away[\s\S]*Say in your reply what you assumed/);
        client.send({ type: "settings.set", rid: "r2", permissionMode: "manual" });
        await client.next("settings");
        assert.doesNotMatch(await prompts(), /The user is away/);
    });

    test("takes the recommended option of a workflow question and shows it", async () => {
        const client = await connected(true);
        client.send({ type: "settings.set", rid: "r1", permissionMode: "auto" });
        client.send({ type: "workflow.run", rid: "w1", name: "asking", params: {} });
        const question = await client.next("workflow.event", (event) => event.kind === "question");
        const answered = await client.next("workflow.event", (event) => event.kind === "answered");
        const { questionId, ...payload } = question.payload as { questionId: string };
        assert.deepEqual(payload, { text: "Pick one", options: OPTIONS });
        assert.deepEqual(answered.payload, { questionId, optionId: "b", auto: true });
        assert.equal((await client.next("workflow.done")).summary, "b");
    });

    test("answers open questions, but never one without a recommended option", async () => {
        const client = await connected(true);
        client.send({ type: "workflow.run", rid: "w1", name: "asking", params: { open: true } });
        const { runId } = await client.next("workflow.started");
        await client.next("workflow.event", (event) => event.kind === "question");
        client.send({ type: "settings.set", rid: "r1", permissionMode: "auto" });
        await client.next("workflow.event", (event) => event.kind === "answered");
        const publish = await client.next("workflow.event", (event) => event.kind === "question");
        // the click of the user, in auto as well
        const { questionId } = publish.payload as { questionId: string };
        client.send({
            type: "workflow.run",
            rid: "w2",
            name: "answer",
            params: { runId, questionId, optionId: "a" },
        });
        assert.equal((await client.next("workflow.done")).summary, "a");
        assert.ok(!client.drain().some((message) => message.type === "workflow.event" && message.kind === "answered"));
    });
});

describe("the settings in server mode and from other computers", () => {
    type Reply = SettingsMessage | SettingsTestedMessage;

    function client(service: SettingsService, isLocal = true) {
        const sent: Reply[] = [];
        const permissionMode = service.modeForConnection();
        return { isLocal, permissionMode, sent, send: (message: Reply) => void sent.push(message) };
    }

    test("server mode has a permission mode per connection and no Claude command", async () => {
        const service = new SettingsService(null);
        const one = client(service);
        const two = client(service);
        service.connect(one);
        service.connect(two);
        await service.set(one, { type: "settings.set", rid: "r1", permissionMode: "auto" });
        assert.deepEqual(one.sent, [{ type: "settings", rid: "r1", scope: "session", permissionMode: "auto" }]);
        service.get(two, { type: "settings.get", rid: "r2" });
        assert.deepEqual(two.sent, [{ type: "settings", rid: "r2", scope: "session", permissionMode: "manual" }]);
        await assert.rejects(
            service.set(one, { type: "settings.set", rid: "r3", claudeCommand: "claude" }),
            /belongs to the computer/
        );
        await assert.rejects(
            service.test(one, { type: "settings.test", rid: "r4", claudeCommand: "claude" }),
            /belongs to the computer/
        );
    });

    test("a client on another computer neither reads nor sets the Claude command", async () => {
        const settings = new UserSettings(join(home, "other.json"));
        const service = new SettingsService({ settings, claude: undefined as never });
        const remote = client(service, false);
        service.get(remote, { type: "settings.get", rid: "r1" });
        assert.equal("claudeCommand" in remote.sent[0], false);
        await assert.rejects(
            service.set(remote, { type: "settings.set", rid: "r2", claudeCommand: "evil" }),
            /belongs to the computer/
        );
        assert.equal(settings.current.claudeCommand, "claude");
    });

    test("a mode without listeners changes quietly", () => {
        const state = new PermissionModeState();
        let changes = 0;
        const unfollow = state.onChange(() => changes++);
        state.set("manual");
        state.set("auto");
        unfollow();
        state.set("manual");
        assert.equal(changes, 1);
    });
});
