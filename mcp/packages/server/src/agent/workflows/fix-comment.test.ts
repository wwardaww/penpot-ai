import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
    AgentContext,
    Workflow,
    WorkflowClaudeRequest,
    WorkflowClaudeResult,
    WorkflowContext,
    WorkflowEventKind,
    WorkflowQuestion,
    WorkflowToolResult,
} from "@penpot/mcp-common";
import { PromptRegistry } from "../prompts/promptRegistry";
import { FixVerdict, type CanvasThread } from "./fix-comment-fixer";
import { workflow as fixComment } from "./fix-comment";
import {
    CommentClassifier,
    createFixCommentsWorkflow,
    type FixCommentsResult,
    type WorkflowLookup,
} from "./fix-comments";
import { WorkflowRegistry } from "./WorkflowRegistry";

const PAGE_ID = "page-1";
const PNG_BASE64 = "iVBORw0KGgo=";

/** Tool handler of the fake tools. */
type ToolHandler = (args: Record<string, unknown>) => WorkflowToolResult;

/** Fake Claude turn: gets the request, returns the answer text. */
type TurnHandler = (request: WorkflowClaudeRequest) => string;

/**
 * Fake workflow context recording tool calls, Claude turns, events and questions.
 */
class FakeContext implements WorkflowContext {
    public readonly runId = "run-1";
    public readonly context: AgentContext;
    public readonly calls: { name: string; args: Record<string, unknown> }[] = [];
    public readonly turns: WorkflowClaudeRequest[] = [];
    public readonly events: { kind: WorkflowEventKind; payload: any }[] = [];
    public readonly questions: WorkflowQuestion[] = [];
    public readonly abort = new AbortController();
    public readonly signal = this.abort.signal;
    public readonly workspace = {} as WorkflowContext["workspace"];
    public readonly tools: WorkflowContext["tools"];
    public readonly runner: WorkflowContext["runner"];

    constructor(
        private readonly toolHandlers: Record<string, ToolHandler>,
        private readonly turn: TurnHandler,
        private readonly answers: ((question: WorkflowQuestion) => string)[] = [],
        persona: "designer" | "developer" = "designer"
    ) {
        this.context = {
            fileId: "file-1",
            fileName: "Shop",
            projectId: "project-1",
            teamId: "team-1",
            pageId: PAGE_ID,
            persona,
            platform: "web",
        };
        this.tools = {
            call: async (name, args = {}) => {
                this.calls.push({ name, args });
                const handler = this.toolHandlers[name];
                if (!handler) {
                    return { isError: true, content: [], text: `Unknown tool ${name}` };
                }
                return handler(args);
            },
            list: async () => Object.keys(this.toolHandlers),
        };
        this.runner = {
            run: async (request): Promise<WorkflowClaudeResult> => {
                this.turns.push(request);
                return { text: this.turn(request) };
            },
        };
    }

    public emit(kind: WorkflowEventKind, payload: unknown): void {
        this.events.push({ kind, payload });
    }

    public async ask(question: WorkflowQuestion): Promise<string> {
        this.questions.push(question);
        const answer = this.answers.shift();
        if (!answer) {
            throw new Error("unexpected question");
        }
        return answer(question);
    }

    public callsOf(name: string): Record<string, unknown>[] {
        return this.calls.filter((call) => call.name === name).map((call) => call.args);
    }

    public result<T>(): T {
        return this.events.find((event) => event.kind === "result")?.payload as T;
    }
}

function text(value: unknown): WorkflowToolResult {
    return { isError: false, content: [{ type: "text", text: JSON.stringify(value) }], text: JSON.stringify(value) };
}

function thread(seqNumber: number, comment: string, extra: Partial<CanvasThread> = {}): CanvasThread {
    return {
        threadId: `thread-${seqNumber}`,
        seqNumber,
        pageId: PAGE_ID,
        boardId: "board-1",
        nodeId: `node-${seqNumber}`,
        position: { x: 10 * seqNumber, y: 20 },
        resolved: false,
        comments: [{ author: "Ana", date: "2026-11-17T10:00:00Z", content: comment }],
        ...extra,
    };
}

/** Fake Penpot tools over a list of threads. */
function penpotTools(threads: CanvasThread[]): Record<string, ToolHandler> {
    return {
        list_canvas_comments: (args) =>
            text(
                threads.filter(
                    (t) => (!args.pageId || t.pageId === args.pageId) && (args.status === "all" || !t.resolved)
                )
            ),
        get_node_properties: (args) => text({ id: args.nodeId, name: "Button", fills: [{ color: "#888888" }] }),
        capture_node_screenshot: (args) => ({
            isError: false,
            content: [
                { type: "image", data: PNG_BASE64, mimeType: "image/png" },
                { type: "text", text: JSON.stringify({ node: { id: args.nodeId } }) },
            ],
            text: JSON.stringify({ node: { id: args.nodeId } }),
        }),
        resolve_canvas_comment: (args) => {
            const target = threads.find((t) => t.threadId === args.threadId);
            if (target) {
                target.resolved = true;
            }
            return text({ ok: true, threadId: args.threadId, replied: !!args.resolutionNote, resolved: true });
        },
        execute_code: () => text({ replied: true }),
    };
}

function verdict(outcome: string, note: string): string {
    return `I looked at the layer.\n{"outcome": "${outcome}", "note": "${note}"}`;
}

const noCheckpoint: WorkflowLookup = { find: async () => undefined };

describe("FixVerdict", () => {
    test("reads the last verdict of the answer", () => {
        const parsed = FixVerdict.parse(
            'Plan: {"outcome": "failed", "note": "first"}\nDone.\n{"outcome": "fixed", "note": "Made it blue."}'
        );
        assert.equal(parsed?.outcome, "fixed");
        assert.equal(parsed?.note, "Made it blue.");
    });

    test("returns null without a verdict", () => {
        assert.equal(FixVerdict.parse("I changed the color."), null);
        assert.equal(FixVerdict.parse('{"outcome": "maybe"}'), null);
    });
});

describe("fix-comment workflow", () => {
    test("fixes a change request and resolves the thread with the note", async () => {
        const threads = [thread(1, "make this button blue")];
        const ctx = new FakeContext(penpotTools(threads), () => verdict("fixed", "The button is blue now."));

        const result = await fixComment.run(ctx, { threadId: "thread-1", pageId: PAGE_ID });

        assert.equal(result?.summary, "Fixed comment #1: The button is blue now.");
        assert.deepEqual(ctx.callsOf("get_node_properties")[0], { nodeId: "node-1", depth: 2 });
        assert.equal(ctx.callsOf("capture_node_screenshot")[0].nodeId, "node-1");
        assert.deepEqual(ctx.callsOf("resolve_canvas_comment"), [
            { threadId: "thread-1", resolutionNote: "The button is blue now." },
        ]);
        assert.equal(ctx.turns.length, 1);
        const [turn] = ctx.turns;
        assert.equal(turn.promptName, "fix-comment");
        assert.match(turn.prompt, /Ana: make this button blue/);
        assert.match(turn.prompt, /"#888888"/);
        assert.match(turn.prompt, /Read the layer again with get_node_properties/);
        assert.deepEqual(turn.attachments, [{ kind: "image", mime: "image/png", base64: PNG_BASE64 }]);
        assert.deepEqual(ctx.result(), {
            threadId: "thread-1",
            seqNumber: 1,
            outcome: "fixed",
            note: "The button is blue now.",
            resolved: true,
            replied: true,
        });
        assert.equal(threads[0].resolved, true);
    });

    test("replies without resolving when the comment asks for no change", async () => {
        const threads = [thread(2, "Looks good!")];
        const ctx = new FakeContext(penpotTools(threads), () => verdict("no-change", "Nothing to change here."));

        const result = await fixComment.run(ctx, { threadId: "thread-2" });

        assert.equal(result?.summary, "Comment #2 asks for no change: Nothing to change here.");
        assert.equal(ctx.callsOf("resolve_canvas_comment").length, 0);
        const [reply] = ctx.callsOf("execute_code");
        assert.match(String(reply.code), /const threadId = "thread-2";/);
        assert.match(String(reply.code), /const note = "Nothing to change here.";/);
        assert.match(String(reply.code), /await thread\.reply\(note\);/);
        assert.equal(ctx.result<{ resolved: boolean }>().resolved, false);
        assert.equal(threads[0].resolved, false);
    });

    test("leaves the thread alone when Claude gives no verdict", async () => {
        const threads = [thread(3, "make the title bigger")];
        const ctx = new FakeContext(penpotTools(threads), () => "Sorry, the tools failed.");

        const result = await fixComment.run(ctx, { threadId: "thread-3" });

        assert.equal(result?.summary, "Could not fix comment #3: Sorry, the tools failed.");
        assert.equal(ctx.callsOf("resolve_canvas_comment").length, 0);
        assert.equal(ctx.callsOf("execute_code").length, 0);
        assert.equal(ctx.result<{ outcome: string }>().outcome, "failed");
    });

    test("falls back to the board and to the whole file", async () => {
        const threads = [thread(4, "more padding", { nodeId: null, pageId: "page-2" })];
        const ctx = new FakeContext(penpotTools(threads), () => verdict("fixed", "Added padding."));

        await fixComment.run(ctx, { threadId: "thread-4", pageId: PAGE_ID });

        assert.deepEqual(ctx.callsOf("list_canvas_comments"), [{ status: "all", pageId: PAGE_ID }, { status: "all" }]);
        assert.equal(ctx.callsOf("get_node_properties")[0].nodeId, "board-1");
        assert.equal(ctx.callsOf("capture_node_screenshot")[0].scale, 1);
    });

    test("still asks Claude when the layer cannot be read", async () => {
        const threads = [thread(5, "make it red")];
        const tools = penpotTools(threads);
        tools.get_node_properties = () => ({ isError: true, content: [], text: "not found" });
        tools.capture_node_screenshot = () => ({ isError: true, content: [], text: "no plugin" });
        const ctx = new FakeContext(tools, () => verdict("fixed", "Red now."));

        await fixComment.run(ctx, { threadId: "thread-5" });

        assert.equal(ctx.turns[0].attachments, undefined);
        assert.doesNotMatch(ctx.turns[0].prompt, /read from the canvas just now/);
        assert.equal(ctx.callsOf("resolve_canvas_comment").length, 1);
    });

    test("does nothing for a resolved thread", async () => {
        const threads = [thread(6, "make it red", { resolved: true })];
        const ctx = new FakeContext(penpotTools(threads), () => assert.fail("no turn expected"));

        const result = await fixComment.run(ctx, { threadId: "thread-6" });

        assert.equal(result?.summary, "Comment #6 is already resolved");
        assert.equal(ctx.turns.length, 0);
    });

    test("fails for unknown threads and missing params", async () => {
        const ctx = new FakeContext(penpotTools([]), () => "");
        await assert.rejects(fixComment.run(ctx, { threadId: "nope" }), /not found/);
        await assert.rejects(fixComment.run(ctx, {} as any), /needs a threadId/);
    });

    test("stops when the run is cancelled", async () => {
        const threads = [thread(7, "make it red")];
        const ctx = new FakeContext(penpotTools(threads), () => verdict("fixed", "Red."));
        ctx.abort.abort();

        await assert.rejects(fixComment.run(ctx, { threadId: "thread-7" }), /cancelled/);
        assert.equal(ctx.turns.length, 0);
    });
});

describe("CommentClassifier.parse", () => {
    const threads = [thread(1, "a"), thread(2, "b"), thread(3, "c")];

    test("reads kinds and keeps only valid conflicts", () => {
        const answer =
            "```json\n" +
            JSON.stringify({
                threads: [
                    { threadId: "thread-1", kind: "change-request", request: "blue" },
                    { threadId: "thread-2", kind: "informational" },
                    { threadId: "unknown", kind: "question" },
                ],
                conflicts: [
                    { threadIds: ["thread-1", "thread-2"], question: "Which?" },
                    { threadIds: ["thread-1", "thread-3"], question: "Blue or red?", labels: { "thread-3": "Red" } },
                ],
            }) +
            "\n```";

        const { kinds, conflicts } = CommentClassifier.parse(answer, threads);

        assert.deepEqual(kinds.get("thread-1"), { kind: "change-request", request: "blue" });
        assert.equal(kinds.get("thread-2")?.kind, "informational");
        assert.equal(kinds.get("thread-3")?.kind, "change-request");
        assert.equal(kinds.has("unknown"), false);
        assert.deepEqual(conflicts, [
            { threadIds: ["thread-1", "thread-3"], question: "Blue or red?", labels: { "thread-3": "Red" } },
        ]);
    });

    test("treats every thread as a change request when the answer is unreadable", () => {
        const { kinds, conflicts } = CommentClassifier.parse("I could not decide.", threads);
        assert.deepEqual(
            [...kinds.values()].map((entry) => entry.kind),
            ["change-request", "change-request", "change-request"]
        );
        assert.deepEqual(conflicts, []);
    });
});

describe("fix-comments workflow", () => {
    /** Batch of the acceptance scenario: one informational, two requests, one conflicting pair. */
    function scenario(): CanvasThread[] {
        return [
            thread(1, "Looks good!"),
            thread(2, "make the title bigger", { nodeId: "title" }),
            thread(3, "add more space under the header", { nodeId: "header" }),
            thread(4, "make this button blue", { nodeId: "button" }),
            thread(5, "make this button red", { nodeId: "button" }),
            thread(6, "on another page", { pageId: "page-2" }),
        ];
    }

    const classification = JSON.stringify({
        threads: [
            { threadId: "thread-1", kind: "informational", request: "" },
            { threadId: "thread-2", kind: "change-request", request: "bigger title" },
            { threadId: "thread-3", kind: "change-request", request: "more space under the header" },
            { threadId: "thread-4", kind: "change-request", request: "blue button" },
            { threadId: "thread-5", kind: "change-request", request: "red button" },
        ],
        conflicts: [
            {
                threadIds: ["thread-4", "thread-5"],
                question: "Blue or red button?",
                labels: { "thread-4": "Blue", "thread-5": "Red" },
            },
        ],
    });

    function turns(request: WorkflowClaudeRequest): string {
        if (request.promptName === "fix-comments") {
            return classification;
        }
        const seq = /#(\d+)/.exec(request.prompt)?.[1];
        return verdict("fixed", `Fixed ${seq}.`);
    }

    test("asks once about the conflict, applies the rest and skips the informational one", async () => {
        const threads = scenario();
        const ctx = new FakeContext(penpotTools(threads), turns, [() => "thread-4"]);
        const workflow = createFixCommentsWorkflow(noCheckpoint);

        const result = await workflow.run(ctx, {});

        assert.deepEqual(ctx.callsOf("list_canvas_comments"), [{ status: "unresolved", pageId: PAGE_ID }]);
        assert.equal(ctx.questions.length, 1);
        assert.deepEqual(ctx.questions[0], {
            text: "Blue or red button?",
            options: [
                { id: "thread-4", label: "Blue" },
                { id: "thread-5", label: "Red" },
                { id: "skip", label: "Skip these" },
            ],
        });
        assert.deepEqual(
            ctx.callsOf("resolve_canvas_comment").map((args) => args.threadId),
            ["thread-2", "thread-3", "thread-4"]
        );
        assert.equal(ctx.turns[0].promptName, "fix-comments");
        assert.match(ctx.turns[0].prompt, /Threads on the same layer: #4, #5/);
        assert.match(ctx.turns[1].prompt, /It was read as this change request: bigger title/);

        const report = ctx.result<FixCommentsResult>();
        assert.deepEqual(
            report.fixed.map((entry) => entry.seqNumber),
            [2, 3, 4]
        );
        assert.deepEqual(
            report.skipped.map((entry) => [entry.seqNumber, entry.reason]),
            [
                [1, "informational"],
                [5, "conflict"],
            ]
        );
        assert.deepEqual(report.needsYou, []);
        assert.equal(result?.summary, "Fixed 3 comments, left 2 without changes");
        assert.equal(threads[0].resolved, false);
        assert.equal(threads[4].resolved, false);

        const fixing = ctx.events.filter((event) => event.kind === "progress" && event.payload.step === "fixing");
        assert.deepEqual(
            fixing.map((event) => [event.payload.seqNumber, event.payload.index, event.payload.total]),
            [
                [2, 1, 3],
                [3, 2, 3],
                [4, 3, 3],
            ]
        );
    });

    test("leaves both conflicting comments to the designer when they skip", async () => {
        const ctx = new FakeContext(penpotTools(scenario()), turns, [() => "skip"], "developer");

        const result = await createFixCommentsWorkflow(noCheckpoint).run(ctx, {});

        const report = ctx.result<FixCommentsResult>();
        assert.deepEqual(
            report.needsYou.map((entry) => [entry.seqNumber, entry.reason]),
            [
                [4, "conflict"],
                [5, "conflict"],
            ]
        );
        assert.equal(
            result?.summary,
            "Fixed 2 comments (#2, #3), left 1 without changes (#1), 2 comments need you (#4, #5)"
        );
    });

    test("takes a checkpoint before changing the design when the checkpoint workflow exists", async () => {
        const order: string[] = [];
        const checkpoint: Workflow<any> = {
            name: "checkpoint-create",
            description: "test",
            run: async (_ctx, params) => {
                order.push(`checkpoint:${params.label}:${params.workflow}`);
            },
        };
        const tools = penpotTools(scenario());
        const resolve = tools.resolve_canvas_comment;
        tools.resolve_canvas_comment = (args) => {
            order.push(`resolve:${args.threadId}`);
            return resolve(args);
        };
        const ctx = new FakeContext(tools, turns, [() => "thread-5"]);

        await createFixCommentsWorkflow({
            find: async (name) => (name === checkpoint.name ? checkpoint : undefined),
        }).run(ctx, {});

        assert.deepEqual(order, [
            "checkpoint:Before fixing comments:fix-comments",
            "resolve:thread-2",
            "resolve:thread-3",
            "resolve:thread-5",
        ]);
    });

    test("goes on when the checkpoint fails", async () => {
        const failing: Workflow<any> = {
            name: "checkpoint-create",
            description: "test",
            run: async () => {
                throw new Error("no versions");
            },
        };
        const ctx = new FakeContext(penpotTools(scenario()), turns, [() => "thread-4"]);

        await createFixCommentsWorkflow({ find: async () => failing }).run(ctx, {});

        assert.ok(ctx.events.some((event) => event.kind === "log" && /no versions/.test(event.payload.text)));
        assert.equal(ctx.result<FixCommentsResult>().fixed.length, 3);
    });

    test("reports questions, comments without changes and failures", async () => {
        const threads = [thread(1, "Is this the final copy?"), thread(2, "align it"), thread(3, "rotate it")];
        const ctx = new FakeContext(penpotTools(threads), (request) => {
            if (request.promptName === "fix-comments") {
                return JSON.stringify({
                    threads: [
                        { threadId: "thread-1", kind: "question" },
                        { threadId: "thread-2", kind: "change-request", request: "align" },
                        { threadId: "thread-3", kind: "change-request", request: "rotate" },
                    ],
                    conflicts: [],
                });
            }
            return /#2/.test(request.prompt) ? verdict("no-change", "Already aligned.") : "The tool crashed.";
        });

        const result = await createFixCommentsWorkflow(noCheckpoint).run(ctx, {});

        const report = ctx.result<FixCommentsResult>();
        assert.deepEqual(report.fixed, []);
        assert.deepEqual(report.skipped, [
            { threadId: "thread-2", seqNumber: 2, reason: "no-change", note: "Already aligned." },
        ]);
        assert.deepEqual(
            report.needsYou.map((entry) => [entry.seqNumber, entry.reason]),
            [
                [1, "question"],
                [3, "failed"],
            ]
        );
        assert.equal(result?.summary, "Fixed 0 comments, left 1 without changes, 2 comments need you (#1, #3)");
        assert.equal(ctx.callsOf("resolve_canvas_comment").length, 0);
    });

    test("covers every page with the file scope and stops early without comments", async () => {
        const ctx = new FakeContext(penpotTools([]), () => assert.fail("no turn expected"));

        const result = await createFixCommentsWorkflow(noCheckpoint).run(ctx, { scope: "file" });

        assert.deepEqual(ctx.callsOf("list_canvas_comments"), [{ status: "unresolved" }]);
        assert.equal(result?.summary, "No open comments to fix");
        assert.deepEqual(ctx.result(), { fixed: [], skipped: [], needsYou: [] });
    });

    test("stops between comments when cancelled", async () => {
        const ctx = new FakeContext(
            penpotTools(scenario()),
            (request) => {
                const answer = turns(request);
                if (request.promptName === "fix-comment") {
                    ctx.abort.abort();
                }
                return answer;
            },
            [() => "thread-4"]
        );

        await assert.rejects(createFixCommentsWorkflow(noCheckpoint).run(ctx, {}), /cancelled/);
        assert.equal(ctx.callsOf("resolve_canvas_comment").length, 0);
    });
});

describe("registration", () => {
    test("ships both workflows and their prompts", () => {
        const registry = WorkflowRegistry.withShippedWorkflows();
        assert.ok(registry.get("fix-comment"));
        assert.ok(registry.get("fix-comments"));

        const prompts = PromptRegistry.locate();
        for (const persona of ["designer", "developer"] as const) {
            const single = prompts.build({ persona, platform: "web", projectName: "Shop", workflow: "fix-comment" });
            assert.match(single, /The canvas is the only truth/);
            assert.match(single, /"outcome": "fixed" \| "no-change" \| "failed"/);
            assert.doesNotMatch(single, /\{\{/);
            const batch = prompts.build({ persona, platform: "web", projectName: "Shop", workflow: "fix-comments" });
            assert.match(batch, /Do not call any tool/);
        }
    });
});
