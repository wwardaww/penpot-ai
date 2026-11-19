import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type {
    AgentContext,
    ChatChangedMessage,
    ChatHistoryEntry,
    DaemonMessage,
    RunnerEvent,
} from "@penpot/mcp-common";
import { AgentError, type AgentClient } from "../AgentClient";
import { ClientMessageSchema } from "../ClientMessageSchema";
import { PromptRegistry } from "../prompts/promptRegistry";
import type { RunnerConversation, RunnerInput, RunnerOptions, ToolUseDecision } from "../runner/ClaudeRunner";
import { FakeRunner, type FakeRunnerScript } from "../runner/FakeRunner";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { ChatService } from "./ChatService";
import { ConversationRecap } from "./ConversationRecap";
import { ConversationStore } from "./ConversationStore";
import { type ChatCheckpointStore, TurnCheckpointGuard } from "./TurnCheckpoints";
import { TurnRunner, type TurnSetup } from "./TurnRunner";

const PROJECT_ID = "2d6b3c4e-5f70-4b8c-9d0e-2f3a4b5c6d7e";
const CONVERSATION = "conv";
const CONTEXT: AgentContext = {
    fileId: "f",
    fileName: "File",
    projectId: PROJECT_ID,
    teamId: "t",
    pageId: "p1",
    persona: "designer",
    platform: "mobile",
};

/**
 * Script of a chat turn: a text with `/change` uses a design tool (asking the permission policy
 * first, like the SDK runner), every turn ends with an echo. Records the order of things.
 */
class DesignScript implements FakeRunnerScript {
    public readonly log: string[] = [];
    public hold?: Promise<void>;

    public async *play(
        conversation: RunnerConversation,
        input: RunnerInput,
        opts: RunnerOptions,
        messageId: string
    ): AsyncIterable<RunnerEvent> {
        yield { kind: "session", sessionId: conversation.resumeSessionId ?? `s-${messageId}` };
        if (this.hold) {
            await this.hold;
        }
        if (input.text.includes("/change")) {
            const decision: ToolUseDecision = await opts.permissions.decide({
                toolName: "mcp__penpot__execute_code",
                input: { code: "change()" },
                signal: new AbortController().signal,
            });
            this.log.push(decision.allow ? "tool runs" : "tool denied");
            yield { kind: "tool", toolUseId: "t1", toolName: "mcp__penpot__execute_code", status: "running" };
            yield { kind: "tool", toolUseId: "t1", toolName: "mcp__penpot__execute_code", status: "done" };
        }
        const reply = `answer to ${input.text}`;
        yield { kind: "text", messageId, text: reply };
        yield { kind: "done", messageId, text: reply };
    }
}

/** Checkpoints without git or Penpot: numbered ids, restores recorded. */
class FakeCheckpoints implements ChatCheckpointStore {
    public readonly saved: string[] = [];
    public readonly restored: string[] = [];
    public failRestore = false;

    constructor(private readonly log: string[]) {}

    public async save(_setup: TurnSetup, label: string): Promise<string | null> {
        const id = `cp-${this.saved.length + 1}`;
        this.saved.push(label);
        this.log.push(`checkpoint ${id}`);
        return id;
    }

    public async restore(_setup: TurnSetup, checkpointId: string): Promise<void> {
        if (this.failRestore) {
            throw new Error("Penpot refused");
        }
        this.restored.push(checkpointId);
    }
}

let projectsDir: string;
let workspace: ProjectWorkspace;
let script: DesignScript;
let runner: FakeRunner;
let checkpoints: FakeCheckpoints;
let chat: ChatService;
let sent: DaemonMessage[];
let client: AgentClient;

beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-actions-"));
    workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    mkdirSync(join(workspace.metaDir, "chat"), { recursive: true });
    script = new DesignScript();
    runner = new FakeRunner(script);
    checkpoints = new FakeCheckpoints(script.log);
    chat = new ChatService(new TurnRunner(runner, PromptRegistry.locate()), checkpoints);
    sent = [];
    client = {
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
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

function store(): ConversationStore {
    return new ConversationStore(workspace);
}

async function say(text: string, messageId: string): Promise<void> {
    await chat.send(client, {
        type: "chat.send",
        rid: `r-${messageId}`,
        conversationId: CONVERSATION,
        text,
        messageId,
    });
}

/** Three turns: u1 reads, u2 and u3 change the design. */
async function threeTurns(): Promise<void> {
    await say("hello", "u1");
    await say("/change paint it teal", "u2");
    await say("/change add a zebra", "u3");
}

async function history(): Promise<ChatHistoryEntry[]> {
    return store().history(CONVERSATION);
}

function changed(): ChatChangedMessage {
    const message = sent.find((candidate) => candidate.type === "chat.changed");
    assert.ok(message, "a chat.changed reply was sent");
    return message as ChatChangedMessage;
}

/** The last turn's runner call. */
function lastTurn() {
    return runner.received[runner.received.length - 1];
}

// --- message ids and checkpoints of turns

test("a user message keeps the id the client chose", async () => {
    await say("hello", "u1");
    const [user, answer] = await history();
    assert.equal(user.messageId, "u1");
    assert.equal(answer.role, "assistant");
});

test("a taken or invalid message id is replaced", async () => {
    await say("hello", "u1");
    await say("again", "u1");
    await say("odd", "../x");
    const ids = (await history()).filter((entry) => entry.role === "user").map((entry) => entry.messageId);
    assert.equal(ids[0], "u1");
    assert.notEqual(ids[1], "u1");
    assert.notEqual(ids[2], "../x");
});

test("a turn that changes the design saves a checkpoint before the tool runs", async () => {
    await say("/change paint it teal", "u1");
    assert.deepEqual(script.log, ["checkpoint cp-1", "tool runs"]);
    assert.deepEqual(checkpoints.saved, ["Before chat: “/change paint it teal”"]);
    const file = readFileSync(workspace.metaPath(`chat/${CONVERSATION}.jsonl`), "utf8");
    assert.match(file, /"type":"checkpoint","messageId":"u1","checkpointId":"cp-1"/);
});

test("a turn that only reads saves no checkpoint", async () => {
    await say("what is on the canvas?", "u1");
    assert.deepEqual(checkpoints.saved, []);
});

test("one checkpoint per turn, also with several changes", async () => {
    const guard = new TurnCheckpointGuard({ decide: async () => ({ allow: true }) }, () =>
        checkpoints.save({} as TurnSetup, "x")
    );
    const use = { toolName: "Write", input: {}, signal: new AbortController().signal };
    await guard.decide(use);
    await guard.decide({ ...use, toolName: "mcp__penpot__update_design_node" });
    await guard.decide({ ...use, toolName: "Read" });
    assert.equal(checkpoints.saved.length, 1);
});

test("a denied tool use saves no checkpoint", async () => {
    const guard = new TurnCheckpointGuard({ decide: async () => ({ allow: false, message: "no" }) }, () =>
        checkpoints.save({} as TurnSetup, "x")
    );
    await guard.decide({ toolName: "mcp__penpot__execute_code", input: {}, signal: new AbortController().signal });
    assert.equal(checkpoints.saved.length, 0);
});

test("runners without a permission channel save the checkpoint up front", () => {
    assert.equal(TurnCheckpointGuard.savesUpFront("local-cli-spawn"), true);
    assert.equal(TurnCheckpointGuard.savesUpFront("local-cli"), false);
});

// --- delete

test("delete drops a message and its answer only", async () => {
    await threeTurns();
    const before = await history();
    await chat.delete(client, { type: "chat.delete", rid: "d1", conversationId: CONVERSATION, messageId: "u2" });

    const after = await history();
    assert.deepEqual(
        after.map((entry) => entry.text),
        ["hello", "answer to hello", "/change add a zebra", "answer to /change add a zebra"]
    );
    const reply = changed();
    assert.equal(reply.action, "delete");
    assert.equal(reply.rid, "d1");
    assert.deepEqual(reply.removed, [before[2].messageId, before[3].messageId]);
    assert.equal(checkpoints.restored.length, 0, "delete never touches the design");
});

test("after a delete Claude starts over and gets only the kept messages", async () => {
    await threeTurns();
    assert.equal(lastTurn().conversation.resumeSessionId !== undefined, true, "turns resume the session");
    await chat.delete(client, { type: "chat.delete", rid: "d1", conversationId: CONVERSATION, messageId: "u2" });
    await say("next", "u4");

    const turn = lastTurn();
    assert.equal(turn.conversation.resumeSessionId, undefined, "a new Claude session");
    assert.match(turn.opts.systemPromptAppend, /## Earlier in this conversation/);
    assert.match(turn.opts.systemPromptAppend, /User: hello/);
    assert.match(turn.opts.systemPromptAppend, /User: \/change add a zebra/);
    assert.doesNotMatch(turn.opts.systemPromptAppend, /paint it teal/);

    await say("and then", "u5");
    assert.notEqual(lastTurn().conversation.resumeSessionId, undefined, "the new session is resumed after");
    assert.doesNotMatch(lastTurn().opts.systemPromptAppend, /Earlier in this conversation/);
});

test("delete of an unknown message is a bad request and changes nothing", async () => {
    await threeTurns();
    await assert.rejects(
        chat.delete(client, { type: "chat.delete", rid: "d1", conversationId: CONVERSATION, messageId: "nope" }),
        (error: unknown) => error instanceof AgentError && error.code === "bad-request"
    );
    assert.equal((await history()).length, 6);
});

test("an assistant message id is not a user message to act on", async () => {
    await threeTurns();
    const answerId = (await history())[1].messageId;
    await assert.rejects(
        chat.delete(client, { type: "chat.delete", rid: "d1", conversationId: CONVERSATION, messageId: answerId }),
        (error: unknown) => error instanceof AgentError && error.code === "bad-request"
    );
});

// --- edit

test("edit replaces the message and every later one, then answers the new text", async () => {
    await threeTurns();
    sent.length = 0;
    await chat.edit(client, {
        type: "chat.edit",
        rid: "e1",
        conversationId: CONVERSATION,
        messageId: "u2",
        text: "make it red",
        newMessageId: "u2b",
    });

    const reply = changed();
    assert.equal(reply.action, "edit");
    assert.equal(reply.removed.length, 4);
    const firstDelta = sent.findIndex((message) => message.type === "chat.delta");
    assert.ok(sent.indexOf(reply) < firstDelta, "chat.changed comes before the new answer");
    assert.equal(sent[sent.length - 1].type, "chat.done");

    const after = await history();
    assert.deepEqual(
        after.map((entry) => entry.text),
        ["hello", "answer to hello", "make it red", "answer to make it red"]
    );
    assert.equal(after[2].messageId, "u2b");

    const turn = lastTurn();
    assert.equal(turn.conversation.resumeSessionId, undefined);
    assert.match(turn.opts.systemPromptAppend, /User: hello/);
    assert.doesNotMatch(turn.opts.systemPromptAppend, /paint it teal|add a zebra/);
});

test("an edited message sends its stored attachments again, not pasted images", async () => {
    await chat.send(client, {
        type: "chat.send",
        rid: "r1",
        conversationId: CONVERSATION,
        messageId: "u1",
        text: "look at this",
        attachments: [
            { kind: "node", fileId: "f", pageId: "p1", nodeId: "n1", name: "Button", type: "rect" },
            { kind: "image", mime: "image/png", base64: "iVBORw0KGgo=" },
        ],
    });
    await chat.edit(client, {
        type: "chat.edit",
        rid: "e1",
        conversationId: CONVERSATION,
        messageId: "u1",
        text: "look again",
    });
    const [user] = await history();
    assert.deepEqual(
        user.attachments?.map((attachment) => attachment.kind),
        ["node"]
    );
});

// --- revert

test("revert restores the checkpoint of the message's turn and drops it and later ones", async () => {
    await threeTurns();
    await chat.revert(client, {
        type: "chat.revert",
        rid: "v1",
        conversationId: CONVERSATION,
        messageId: "u2",
        confirmed: true,
    });

    assert.deepEqual(checkpoints.restored, ["cp-1"], "the checkpoint from before u2 (not u3's)");
    const reply = changed();
    assert.equal(reply.action, "revert");
    assert.equal(reply.design, "restored");
    assert.equal(reply.checkpointId, "cp-1");
    assert.deepEqual(
        (await history()).map((entry) => entry.text),
        ["hello", "answer to hello"]
    );

    await say("next", "u4");
    assert.equal(lastTurn().conversation.resumeSessionId, undefined, "Claude forgets the reverted turns");
    assert.doesNotMatch(lastTurn().opts.systemPromptAppend, /paint it teal|add a zebra/);
});

test("revert of a message whose turn only read restores the next turn's checkpoint", async () => {
    await threeTurns();
    await chat.revert(client, {
        type: "chat.revert",
        rid: "v1",
        conversationId: CONVERSATION,
        messageId: "u1",
        confirmed: true,
    });
    assert.deepEqual(checkpoints.restored, ["cp-1"]);
    assert.deepEqual(await history(), []);
});

test("revert with no change after the message leaves the design alone", async () => {
    await say("hello", "u1");
    await say("and?", "u2");
    await chat.revert(client, {
        type: "chat.revert",
        rid: "v1",
        conversationId: CONVERSATION,
        messageId: "u2",
        confirmed: true,
    });
    assert.deepEqual(checkpoints.restored, []);
    assert.equal(changed().design, "unchanged");
    assert.equal((await history()).length, 2);
});

test("a failed restore keeps the messages", async () => {
    await threeTurns();
    checkpoints.failRestore = true;
    await assert.rejects(
        chat.revert(client, {
            type: "chat.revert",
            rid: "v1",
            conversationId: CONVERSATION,
            messageId: "u2",
            confirmed: true,
        }),
        /The design could not be put back: Penpot refused/
    );
    assert.equal((await history()).length, 6);
    assert.equal(
        sent.some((message) => message.type === "chat.changed"),
        false
    );
});

test("actions wait for the running turn: busy", async () => {
    let release!: () => void;
    script.hold = new Promise((resolve) => (release = resolve));
    const turn = say("hello", "u1");
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
        chat.delete(client, { type: "chat.delete", rid: "d1", conversationId: CONVERSATION, messageId: "u1" }),
        (error: unknown) => error instanceof AgentError && error.code === "busy"
    );
    release();
    await turn;
});

// --- store, recap, schema

test("a cut drops every Claude session of the conversation", async () => {
    await threeTurns();
    const conversations = store();
    assert.notEqual(await conversations.lastSession(CONVERSATION), undefined);
    const cut = await conversations.planCut(CONVERSATION, "u3", "turn");
    assert.ok(cut);
    assert.deepEqual(cut.checkpoints, ["cp-2"]);
    await conversations.applyCut(CONVERSATION, cut);
    assert.equal(await conversations.lastSession(CONVERSATION), undefined);
    assert.equal((await conversations.history(CONVERSATION)).length, 4);
});

test("the recap keeps the newest messages within its limits", () => {
    const long = "x".repeat(ConversationRecap.MAX_MESSAGE_CHARS + 50);
    const entries: ChatHistoryEntry[] = Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        messageId: `m${index}`,
        text: index === 39 ? long : `message ${index}`,
        ts: "2026-11-19T00:00:00Z",
    }));
    const recap = ConversationRecap.text(entries)!;
    assert.doesNotMatch(recap, /message 0\b/);
    assert.match(recap, /message 38/);
    assert.match(recap, /older messages left out/);
    assert.ok(recap.length < ConversationRecap.MAX_TOTAL_CHARS + 1000);
    assert.match(recap, /x…/);
    assert.equal(ConversationRecap.text([]), undefined);
});

test("message action messages are validated", () => {
    assert.ok(
        "message" in
            ClientMessageSchema.parse({
                type: "chat.edit",
                rid: "r",
                conversationId: "c",
                messageId: "m",
                text: "t",
                newMessageId: "n",
            })
    );
    assert.ok(
        "message" in ClientMessageSchema.parse({ type: "chat.delete", rid: "r", conversationId: "c", messageId: "m" })
    );
    assert.ok(
        "message" in
            ClientMessageSchema.parse({
                type: "chat.revert",
                rid: "r",
                conversationId: "c",
                messageId: "m",
                confirmed: true,
            })
    );
    assert.ok(
        "error" in ClientMessageSchema.parse({ type: "chat.revert", rid: "r", conversationId: "c", messageId: "m" }),
        "revert needs the client's confirmation"
    );
    const send = ClientMessageSchema.parse({
        type: "chat.send",
        rid: "r",
        conversationId: "c",
        text: "t",
        messageId: "m1",
    });
    assert.ok("message" in send && send.message.type === "chat.send" && send.message.messageId === "m1");
});
