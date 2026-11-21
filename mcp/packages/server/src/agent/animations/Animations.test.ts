import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { AgentContext, DaemonMessage, RunnerEvent, WorkflowContext } from "@penpot/mcp-common";
import type { AgentClient } from "../AgentClient";
import { ChatService } from "../chat/ChatService";
import { TurnRunner } from "../chat/TurnRunner";
import { PromptRegistry } from "../prompts/promptRegistry";
import { FakeRunner, type FakeRunnerScript } from "../runner/FakeRunner";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { WorkspaceManager } from "../workspace/WorkspaceManager";
import { workflow as animationSettings } from "../workflows/animation-settings";
import { AnimationSettings } from "./AnimationSettings";
import { AnimationSteps } from "./AnimationSteps";

const PROJECT_ID = "5d0c1b8e-2f3a-4c55-8e61-0a9b7c6d5e4f";
const CONTEXT: AgentContext = {
    fileId: "file-1",
    fileName: "Onboarding",
    projectId: PROJECT_ID,
    projectName: "Todo",
    teamId: "team-1",
    pageId: "p1",
    persona: "designer",
    platform: "mobile",
};
let projectsDir: string;

beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-w32-"));
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

/** In-memory `.penforge` store. */
class MemoryStore {
    public readonly files = new Map<string, unknown>();

    public async readJson<T>(name: string, fallback: T): Promise<T> {
        return this.files.has(name) ? (this.files.get(name) as T) : fallback;
    }

    public async writeJson(name: string, value: unknown): Promise<void> {
        this.files.set(name, JSON.parse(JSON.stringify(value)));
    }
}

function tool(
    status: "running" | "done" | "error",
    input?: unknown,
    id = "t1",
    name = "mcp__penpot__update_animations"
): RunnerEvent {
    return { kind: "tool", toolUseId: id, toolName: name, status, input };
}

const animateCards = {
    operations: [
        { op: "set", nodeId: "list", entrance: { effects: [{ type: "fade" }], duration: 300, stagger: { each: 60 } } },
        { op: "update", nodeId: "button", states: { press: { scale: 0.97 } } },
        { op: "update", nodeId: "list", entrance: { duration: 250 } },
        { op: "remove", nodeId: "old" },
    ],
};

test("a finished update_animations call becomes a Play step with the animated layers", () => {
    const steps = new AnimationSteps(() => new Date("2026-11-21T10:00:00Z"));
    assert.equal(steps.observe(tool("running", animateCards)), null);
    assert.deepEqual(steps.observe(tool("done")), {
        toolName: "penforge_animations",
        summary: "Animated 2 layers",
        status: "done",
        code: "animations-set",
        params: { nodeIds: ["list", "button"], count: 2, at: "2026-11-21T10:00:00.000Z" },
    });
});

test("failed calls, removals and other tools give no step", () => {
    const steps = new AnimationSteps();
    steps.observe(tool("running", animateCards, "a"));
    assert.equal(steps.observe(tool("error", undefined, "a")), null);
    steps.observe(tool("running", { operations: [{ op: "remove", nodeId: "x" }] }, "b"));
    assert.equal(steps.observe(tool("done", undefined, "b")), null);
    steps.observe(tool("running", animateCards, "c", "mcp__penpot__update_prototype"));
    assert.equal(steps.observe(tool("done", undefined, "c", "mcp__penpot__update_prototype")), null);
    assert.equal(steps.observe({ kind: "text", messageId: "m", text: "hi" }), null);
    assert.deepEqual(AnimationSteps.animatedIds(null), []);
});

test("the setting is on by default and keeps the other project.json keys", async () => {
    const store = new MemoryStore();
    assert.equal(await AnimationSettings.isOn(store), true);
    store.files.set("project.json", { projectId: "p", designSystem: { fileId: "ds" } });
    assert.equal(await AnimationSettings.isOn(store), true);
    assert.equal(await AnimationSettings.set(store, false), false);
    assert.deepEqual(store.files.get("project.json"), {
        projectId: "p",
        designSystem: { fileId: "ds" },
        aiAnimations: false,
    });
    assert.equal(await AnimationSettings.isOn(store), false);
});

test("only chat and generate-screen turns get the note", async () => {
    const store = new MemoryStore();
    assert.match((await AnimationSettings.promptNote(store, "chat"))!, /^## Animation initiative\nOn:/);
    await AnimationSettings.set(store, false);
    assert.match((await AnimationSettings.promptNote(store, "generate-screen"))!, /Off: .* only when the user asks/);
    assert.equal(await AnimationSettings.promptNote(store, "audit"), undefined);
    assert.equal(await AnimationSettings.promptNote(store, undefined), undefined);
    const broken = { readJson: async () => Promise.reject(new Error("disk")), writeJson: async () => {} };
    assert.equal(await AnimationSettings.isOn(broken), true);
});

test("the animation-settings workflow reads and changes the setting", async () => {
    const store = new MemoryStore();
    const events: [string, unknown][] = [];
    const ctx = {
        workspace: store,
        emit: (kind: string, payload: unknown) => events.push([kind, payload]),
    } as unknown as WorkflowContext;

    assert.deepEqual(await animationSettings.run(ctx, {}), { summary: "AI may add animations" });
    assert.deepEqual(await animationSettings.run(ctx, { aiAnimations: false }), {
        summary: "AI adds animations only when asked",
    });
    await animationSettings.run(ctx, {});
    assert.deepEqual(events, [
        ["result", { aiAnimations: true }],
        ["result", { aiAnimations: false }],
        ["result", { aiAnimations: false }],
    ]);
    await assert.rejects(animationSettings.run(ctx, { aiAnimations: "no" as any }), /true or false/);
});

test("recording a new tab context keeps the setting", async () => {
    const manager = new WorkspaceManager(projectsDir);
    const workspace = await manager.open(CONTEXT);
    await AnimationSettings.set(workspace, false);
    await manager.open({ ...CONTEXT, fileId: "file-2" });
    const info = await workspace.readJson<Record<string, unknown> | null>("project.json", null);
    assert.equal(info?.aiAnimations, false);
    assert.deepEqual(info?.fileIds, ["file-1", "file-2"]);
});

/** Script of a chat turn that animates the cards of a list. */
class AnimatingScript implements FakeRunnerScript {
    public async *play(_c: unknown, _i: unknown, _o: unknown, messageId: string): AsyncIterable<RunnerEvent> {
        yield tool("running", animateCards);
        yield tool("done");
        yield { kind: "text", messageId, text: "The cards now fade in one by one." };
        yield { kind: "done", messageId, text: "The cards now fade in one by one." };
    }
}

async function chatTurn(aiAnimations: boolean): Promise<{ sent: DaemonMessage[]; runner: FakeRunner }> {
    const workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    mkdirSync(join(workspace.metaDir, "chat"), { recursive: true });
    await workspace.writeJson("project.json", { projectId: PROJECT_ID, aiAnimations });
    const sent: DaemonMessage[] = [];
    const client: AgentClient = {
        id: "c1",
        closed: new AbortController().signal,
        send: (message) => sent.push(message),
        setup: async () => ({
            context: CONTEXT,
            workspace,
            tools: null,
            permissions: { decide: async () => ({ allow: true }) },
        }),
    };
    const runner = new FakeRunner(new AnimatingScript());
    const chat = new ChatService(new TurnRunner(runner, PromptRegistry.locate()));
    await chat.send(client, { type: "chat.send", rid: "r1", conversationId: "conv", text: "animate the cards in" });
    return { sent, runner };
}

test("a chat turn that animates layers sends a Play step and carries the setting", async () => {
    const { sent, runner } = await chatTurn(false);
    const steps = sent.filter((m: any) => m.type === "chat.tool" && m.code === "animations-set") as any[];
    assert.equal(steps.length, 1);
    assert.equal(steps[0].toolName, "penforge_animations");
    assert.equal(steps[0].conversationId, "conv");
    assert.deepEqual(steps[0].params.nodeIds, ["list", "button"]);
    const tools = sent.filter((m: any) => m.type === "chat.tool") as any[];
    assert.equal(tools[0].summary, "Animating the design");

    const systemPrompt = String(runner.received[0].opts.systemPromptAppend);
    assert.match(systemPrompt, /## Animation initiative\nOff:/);
    assert.match(systemPrompt, /## Animation\n/);
});

test("the chat and generate-screen prompts have an Animation section", () => {
    for (const name of ["chat", "generate-screen"]) {
        const text = readFileSync(join(import.meta.dirname, "..", "workflows", `${name}.prompt.md`), "utf8");
        assert.match(text, /## Animation\n/, name);
        assert.match(text, /update_animations/, name);
        assert.match(text, /150.400 ms/, name);
        assert.match(text, /Animation initiative/, name);
    }
});
