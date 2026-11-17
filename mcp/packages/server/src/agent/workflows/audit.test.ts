import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { WorkflowClaudeRequest, WorkflowContext, WorkflowEventKind, WorkflowToolResult } from "@penpot/mcp-common";
import type { CanvasThread } from "../audit/AuditComments";
import type { NodeSnapshot } from "../audit/DesignTree";
import { fill, loginBoard, node } from "../audit/testing/fixtures";
import { workflow } from "./audit";

/**
 * In-memory Penpot behind the MCP tools the audit uses.
 */
class FakePenpot {
    public readonly threads: CanvasThread[] = [];
    public readonly calls: string[] = [];
    private nextThread = 1;

    constructor(private readonly boards: NodeSnapshot[]) {}

    public call(name: string, args: Record<string, unknown> = {}): WorkflowToolResult {
        this.calls.push(name);
        switch (name) {
            case "list_boards":
                return FakePenpot.json(
                    this.boards.map((b) => ({ id: b.id, name: b.name, pageId: "page-1", pageName: "Home" }))
                );
            case "get_node_properties": {
                const found = this.find(String(args.nodeId), this.boards);
                return found ? FakePenpot.json(found) : { isError: true, content: [], text: "Node not found" };
            }
            case "list_canvas_comments":
                return FakePenpot.json(this.threads.filter((t) => !t.resolved));
            case "execute_code":
                return FakePenpot.json(this.addThreads(String(args.code)));
            case "resolve_canvas_comment": {
                const thread = this.threads.find((t) => t.threadId === args.threadId);
                thread!.resolved = true;
                return FakePenpot.json({ ok: true, threadId: args.threadId, replied: true, resolved: true });
            }
            default:
                return { isError: true, content: [], text: `Unknown tool ${name}` };
        }
    }

    private addThreads(code: string) {
        const items = JSON.parse(/const items = (.*);/.exec(code)![1]) as {
            key: string;
            content: string;
            x: number;
            y: number;
        }[];
        return items.map((item) => {
            const threadId = `thread-${this.nextThread++}`;
            const nodeId = item.key.split(":")[1];
            this.threads.push({
                threadId,
                nodeId,
                position: { x: item.x, y: item.y },
                resolved: false,
                comments: [{ content: item.content }],
            });
            return { key: item.key, threadId };
        });
    }

    private find(id: string, nodes: NodeSnapshot[]): NodeSnapshot | null {
        for (const n of nodes) {
            if (n.id === id) {
                return n;
            }
            const found = this.find(id, n.children ?? []);
            if (found) {
                return found;
            }
        }
        return null;
    }

    private static json(value: unknown): WorkflowToolResult {
        return { isError: false, content: [], text: JSON.stringify(value) };
    }
}

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "penforge-audit-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** Runs git in the test project's design folder. */
function designGit(...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], {
        cwd: join(root, "design"),
        encoding: "utf8",
    });
}

/** Creates the design repository the way the daemon does (W01). */
function initDesignRepo(): void {
    mkdirSync(join(root, "design"), { recursive: true });
    designGit("init", "-q", "-b", "main");
    designGit("commit", "-q", "--allow-empty", "-m", "init");
}

function context(penpot: FakePenpot, onTurn: (request: WorkflowClaudeRequest) => string = () => "[]") {
    const events: { kind: WorkflowEventKind; payload: any }[] = [];
    const turns: WorkflowClaudeRequest[] = [];
    const ctx: WorkflowContext = {
        runId: "run-1",
        context: {
            fileId: "file-1",
            fileName: "Shop",
            projectId: "project-1",
            teamId: "team-1",
            pageId: "page-1",
            persona: "designer",
            platform: "web",
        },
        runner: {
            run: async (request) => {
                turns.push(request);
                return { text: onTurn(request) };
            },
        },
        tools: {
            call: async (name, args) => penpot.call(name, args),
            list: async () => [],
        },
        workspace: {
            projectId: "project-1",
            root,
            designDir: join(root, "design"),
            appSrcDir: join(root, "app-src"),
            metaDir: join(root, ".penforge"),
            resolve: (path) => join(root, path),
            commitAll: async () => {
                throw new Error("the audit must commit its report only");
            },
            readJson: async (_name, fallback) => fallback,
            writeJson: async () => {},
        },
        signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} },
        emit: (kind, payload) => events.push({ kind, payload }),
        ask: async () => {
            throw new Error("no questions expected");
        },
    };
    const result = () => events.find((e) => e.kind === "result")!.payload;
    return { ctx, events, turns, result };
}

describe("audit workflow", () => {
    test("comments the low-contrast label and the small tap target, then fixes both", async () => {
        initDesignRepo();
        writeFileSync(join(root, "design", "DESIGN.md"), "user draft\n");
        const penpot = new FakePenpot([loginBoard()]);
        const run = context(penpot, (request) => {
            // Claude fixes every thread listed in the prompt
            for (const match of request.prompt.matchAll(/threadId: (\S+)/g)) {
                penpot.call("resolve_canvas_comment", { threadId: match[1], resolutionNote: "Fixed" });
            }
            return "Done";
        });

        const audit = await workflow.run(run.ctx, {});
        assert.equal(audit?.summary, "Audit of Home: 1 error, 1 warning; added 2 comments");
        const result = run.result();
        assert.deepEqual(
            result.findings.map((f: any) => [f.nodeId, f.title, f.threadId, f.duplicate]),
            [
                ["text-hint", "Low contrast", "thread-1", false],
                ["close-button", "Small tap target", "thread-2", false],
            ]
        );
        assert.deepEqual(
            penpot.threads.map((t) => t.position),
            [
                { x: 124, y: 150 },
                { x: 354, y: 24 },
            ]
        );
        assert.match(
            penpot.threads[0].comments[0].content,
            /^\[Audit\] Low contrast: "Forgot your password\?" has a contrast/
        );
        assert.match(result.report.path, /^design\/audits\/\d{4}-\d{2}-\d{2}\.md$/);
        assert.match(result.report.commit, /^[0-9a-f]{40}$/);
        assert.match(readFileSync(join(root, result.report.path), "utf8"), /Low contrast/);
        assert.equal(designGit("log", "-1", "--format=%s").trim(), "penforge(audit): 1 error, 1 warning on Home");
        // the user's own file in design/ stays out of the audit commit
        assert.equal(designGit("status", "--porcelain").trim(), "?? DESIGN.md");
        assert.equal(run.turns.length, 0, "no Claude turn without the AI review");

        const fix = await workflow.run(run.ctx, { mode: "fix" });
        assert.equal(fix?.summary, "Fixed 2 of 2 audit comments");
        assert.equal(run.turns[0].promptName, "audit");
        assert.match(run.turns[0].prompt, /threadId: thread-1[\s\S]*threadId: thread-2/);
        const fixResult = run.events.filter((e) => e.kind === "result").pop()!.payload;
        assert.deepEqual(fixResult, { mode: "fix", pageId: "page-1", fixed: ["thread-1", "thread-2"], remaining: [] });
    });

    test("does not post a second comment for a finding that is still open", async () => {
        const penpot = new FakePenpot([loginBoard()]);
        await workflow.run(context(penpot).ctx, { report: false });
        // the hit test may name another layer and comments may sit elsewhere: only the ref counts
        for (const thread of penpot.threads) {
            thread.nodeId = "some-child";
            thread.position = { x: thread.position!.x + 40, y: thread.position!.y + 40 };
        }
        const again = context(penpot);
        const summary = await workflow.run(again.ctx, { report: false });
        assert.equal(penpot.threads.length, 2);
        assert.equal(summary?.summary, "Audit of Home: 1 error, 1 warning");
        assert.deepEqual(
            again.result().findings.map((f: any) => [f.threadId, f.duplicate]),
            [
                ["thread-1", true],
                ["thread-2", true],
            ]
        );
        assert.deepEqual(again.result().comments, { posted: 0, duplicates: 2, overLimit: 0 });
    });

    test("audits only the given nodes and adds the AI review findings", async () => {
        const other = node({ id: "board-other", name: "Other", type: "board", x: 1000, fills: fill("#FFFFFF") });
        const penpot = new FakePenpot([loginBoard(), other]);
        const run = context(
            penpot,
            () =>
                '```json\n[{"nodeId":"text-title","severity":"info","title":"Weak heading",' +
                '"message":"The heading is not the first thing you see.","suggestion":"Make it larger."}]\n```'
        );
        await workflow.run(run.ctx, { nodeIds: ["board-login"], ai: true, comments: false, report: false });
        const result = run.result();
        assert.deepEqual(result.boards, [{ id: "board-login", name: "Login" }]);
        assert.equal(result.aiReview, true);
        assert.deepEqual(
            result.findings.map((f: any) => f.check),
            ["contrast", "touch-target", "ai-review"]
        );
        assert.match(run.turns[0].prompt, /"Login" id board-login/);
        assert.ok(!penpot.calls.includes("execute_code"));
        assert.equal(result.pageName, "Home");
    });

    test("does not repost AI findings whose wording changed", async () => {
        const penpot = new FakePenpot([loginBoard()]);
        const answer = (title: string) => () =>
            `[{"nodeId":"text-title","category":"hierarchy","severity":"info","title":"${title}","message":"m"}]`;
        await workflow.run(context(penpot, answer("Weak heading")).ctx, { ai: true, report: false });
        assert.equal(penpot.threads.length, 3);
        const again = context(penpot, answer("Heading lacks weight"));
        await workflow.run(again.ctx, { ai: true, report: false });
        assert.equal(penpot.threads.length, 3);
        assert.deepEqual(again.result().comments, { posted: 0, duplicates: 3, overLimit: 0 });
    });

    test("reports an empty page and an empty fix", async () => {
        const penpot = new FakePenpot([]);
        const run = context(penpot);
        assert.equal((await workflow.run(run.ctx, {}))?.summary, "Nothing to audit on this page");
        assert.equal((await workflow.run(run.ctx, { mode: "fix" }))?.summary, "No open audit comments to fix");
        assert.equal(run.turns.length, 0);
    });

    test("keeps the audit result when the report cannot be written", async () => {
        const penpot = new FakePenpot([loginBoard()]);
        const run = context(penpot);
        // no design repository
        await workflow.run(run.ctx, { comments: false });
        assert.equal(run.result().report, null);
        assert.ok(run.events.some((e) => e.kind === "log" && /Could not write the audit report/.test(e.payload.text)));
    });
});
