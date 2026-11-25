import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Workflow, WorkflowClaudeRequest } from "@penpot/mcp-common";
import { LayoutCheckHeader } from "../../LayoutCheckHeader";
import { AgentConfig } from "../AgentConfig";
import { NoCommandsFilter } from "../build/NoCommandsFilter";
import { ClaudeCommands } from "../claude/ClaudeCommands";
import { PenforgeDaemon } from "../PenforgeDaemon";
import { FakeRunner } from "../runner/FakeRunner";
import { SkillLibrary } from "../skills/SkillLibrary";
import { AgentTestClient } from "../testing/AgentTestClient";
import { DesignToolFilter } from "../tools/DesignToolFilter";
import { CommentToolFilter } from "../workflows/fix-comment-fixer";
import { WorkflowRegistry } from "../workflows/WorkflowRegistry";
import { ModelGuide } from "./ModelGuide";
import { PromptRegistry } from "./promptRegistry";

const POSIX = process.platform !== "win32";
const ORIGIN = "https://localhost:3449";
const GUIDE = PromptRegistry.locate().modelGuide().trim();
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

let home: string;
let runner: FakeRunner;
let daemon: PenforgeDaemon;
let client: AgentTestClient;
let request: Partial<WorkflowClaudeRequest>;
const realEnv = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL };

/** Runs one Claude turn with the {@link request} of the test. */
const turning: Workflow<Record<string, never>> = {
    name: "turning",
    description: "Test workflow",
    run: async (ctx) => {
        await ctx.runner.run({ prompt: "go", ...request });
        return { summary: "done" };
    },
};

async function startDaemon(runnerKind: "fake" | "api-key" = "fake"): Promise<void> {
    runner = new FakeRunner();
    const registry = WorkflowRegistry.withShippedWorkflows();
    registry.register(turning);
    const config = new AgentConfig({
        home,
        host: "127.0.0.1",
        port: 0,
        allowedOrigins: [ORIGIN],
        publicUri: ORIGIN,
        runner: runnerKind,
        mcpUrl: "http://127.0.0.1:1/mcp",
        requirePairing: true,
    });
    daemon = new PenforgeDaemon(config, {
        runner,
        registry,
        tools: null,
        claudeCommands: new ClaudeCommands({ env: { HOME: home, PATH: home }, home, shell: null }),
    });
    await daemon.start();
    client = await AgentTestClient.connect(`ws://127.0.0.1:${daemon.port}/agent`, ORIGIN);
    client.send({ type: "auth", token: daemon.token.value });
    await client.next("auth.ok");
    client.send(CONTEXT);
}

async function useCommand(claudeCommand: string): Promise<void> {
    client.send({ type: "settings.set", rid: "s", claudeCommand });
    await client.next("settings");
}

/** System prompt of a chat message. */
async function chatPrompt(): Promise<string> {
    client.send({ type: "chat.send", rid: "c", conversationId: "c", text: "Design a home page" });
    await client.next("chat.done");
    return runner.received.at(-1)!.opts.systemPromptAppend;
}

/** System prompt of a workflow's turn. */
async function turnPrompt(promptName: string, rest: Partial<WorkflowClaudeRequest> = {}): Promise<string> {
    request = { promptName, ...rest };
    client.send({ type: "workflow.run", rid: "w", name: "turning", params: {} });
    await client.next("workflow.done");
    return runner.received.at(-1)!.opts.systemPromptAppend;
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-guide-"));
    Object.assign(process.env, {
        HOME: home,
        // projects need `git`
        PATH: [home, join(process.execPath, ".."), ...(POSIX ? ["/usr/bin", "/bin"] : [realEnv.PATH])].join(delimiter),
        SHELL: "/bin/bash",
    });
    await startDaemon();
});

afterEach(async () => {
    client.close();
    await daemon.stop();
    Object.assign(process.env, realEnv);
    rmSync(home, { recursive: true, force: true });
});

describe("the drawing guide in the system prompt", () => {
    test("follows the Claude command from the next message on and leaves Claude's prompt as it is", async () => {
        const claude = await chatPrompt();
        assert.ok(!claude.includes("Penforge drawing guide"));

        await useCommand("claude-local");
        const other = await chatPrompt();
        assert.equal(other, `${claude}\n${GUIDE}\n`, "the guide comes last and changes nothing before it");
        assert.deepEqual(runner.received.at(-1)!.opts.mcpHeaders, LayoutCheckHeader.HEADERS);

        await useCommand("/opt/tools/claude");
        assert.equal(await chatPrompt(), claude);
        assert.equal(runner.received.at(-1)!.opts.mcpHeaders, undefined);
        await useCommand("/opt/tools/claude-local");
        assert.equal(await chatPrompt(), other);
        await useCommand("claude");
        assert.equal(await chatPrompt(), claude);
    });

    test("comes with the workflow turns that draw, after their own system prompt text", async () => {
        const drawing = Object.keys(SkillLibrary.DESIGNING).filter(
            (name) => SkillLibrary.DESIGNING[name] === "canvas" && !ModelGuide.TEXT_ONLY.has(name)
        );
        for (const name of drawing) {
            const claude = await turnPrompt(name, { systemPromptAppend: "## Extra" });
            assert.ok(claude.includes("## Extra") && !claude.includes(GUIDE), name);
            await useCommand("claude-local");
            assert.equal(await turnPrompt(name, { systemPromptAppend: "## Extra" }), `${claude}\n${GUIDE}\n`, name);
            await useCommand("claude");
        }
    });

    test("stays out of the turns that write code or text, read or check", async () => {
        await useCommand("claude-local");
        const quiet = [
            ...Object.keys(SkillLibrary.DESIGNING).filter((name) => SkillLibrary.DESIGNING[name] === "code"),
            ...SkillLibrary.NOT_DESIGNING,
            ...ModelGuide.TEXT_ONLY,
        ];
        assert.ok(quiet.includes("build-run") && quiet.includes("build-plan"));
        for (const name of quiet) {
            assert.ok(!(await turnPrompt(name)).includes("Penforge drawing guide"), name);
        }
        // the build's own turn
        const build = await turnPrompt("build-run", { toolFilter: new NoCommandsFilter() });
        assert.ok(!build.includes("Penforge drawing guide"));
    });

    test("stays out of the turns whose tools refuse its scripts", async () => {
        await useCommand("claude-local");
        const refusing = [new DesignToolFilter(home, null), new CommentToolFilter(false), new CommentToolFilter(true)];
        for (const toolFilter of refusing) {
            assert.ok(!(await turnPrompt("fix-comment", { toolFilter })).includes("Penforge drawing guide"));
        }
        const allowing = new NoCommandsFilter();
        assert.ok((await turnPrompt("generate-screen", { toolFilter: allowing })).includes(GUIDE));
    });

    test("is not sent when the Claude command is not used", async () => {
        client.close();
        await daemon.stop();
        await startDaemon("api-key");
        await useCommand("claude-local");
        assert.ok(!(await chatPrompt()).includes("Penforge drawing guide"));
    });

    test("every text-only prompt is a designing one", () => {
        for (const name of ModelGuide.TEXT_ONLY) {
            assert.equal(SkillLibrary.targetOf(name), "canvas", name);
        }
    });
});
