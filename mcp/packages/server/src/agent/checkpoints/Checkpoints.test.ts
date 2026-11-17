import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type {
    AgentContext,
    WorkflowContext,
    WorkflowQuestion,
    WorkflowToolResult,
    WorkflowToolsApi,
    WorkflowWorkspaceApi,
} from "@penpot/mcp-common";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { WorkflowRegistry } from "../workflows/WorkflowRegistry";
import { workflow as restoreWorkflow } from "../workflows/checkpoint-restore";
import { Checkpoints, ensureCheckpoint } from "./Checkpoints";
import { CheckpointStore } from "./CheckpointStore";
import type { Checkpoint } from "./types";

const PROJECT_ID = "3b0c6f8e-5a8c-4c0e-9a51-0f6b8e2d9c11";
const FILE_ID = "a1e7f4b2-0c1d-4e5f-8a9b-1c2d3e4f5a6b";

/**
 * Fake Penpot plugin: the "design" is one string, versions keep a copy of it. Understands the
 * code `PenpotVersions` sends through `execute_code`.
 */
class FakePenpot implements WorkflowToolsApi {
    public design = "design v1";
    public fileId = FILE_ID;
    public connected = true;
    public readonly versions: { label: string; createdAt: string; design: string }[] = [];
    public restores = 0;

    public async call(toolName: string, args: Record<string, unknown> = {}): Promise<WorkflowToolResult> {
        if (!this.connected) {
            throw new Error("No Penpot plugin is connected");
        }
        assert.equal(toolName, "execute_code");
        const code = String(args.code);
        const save = /saveVersion\(("(?:[^"\\]|\\.)*")\)/.exec(code);
        if (save) {
            const label = JSON.parse(save[1]) as string;
            const createdAt = new Date(Date.UTC(2026, 10, 17, 12, 0, this.versions.length)).toISOString();
            this.versions.push({ label, createdAt, design: this.design });
            return FakePenpot.reply({ fileId: this.fileId, fileName: "Shop", label, createdAt });
        }
        const restore = /const label = ("(?:[^"\\]|\\.)*");/.exec(code);
        if (restore) {
            const wanted = /file\.id !== ("[^"]*")/.exec(code);
            if (!wanted || JSON.parse(wanted[1]) !== this.fileId) {
                return FakePenpot.reply({ status: "wrong-file", fileId: this.fileId });
            }
            const version = this.versions.find((candidate) => candidate.label === JSON.parse(restore[1]));
            if (!version) {
                return FakePenpot.reply({ status: "missing" });
            }
            this.design = version.design;
            this.restores++;
            return FakePenpot.reply({ status: "restoring" });
        }
        throw new Error(`Unexpected code: ${code}`);
    }

    public async list(): Promise<string[]> {
        return ["execute_code"];
    }

    private static reply(data: unknown): WorkflowToolResult {
        const text = JSON.stringify(data);
        return { isError: false, content: [{ type: "text", text }], text };
    }
}

interface TestContext {
    ctx: WorkflowContext;
    events: { kind: string; payload: any }[];
    questions: WorkflowQuestion[];
}

let projectsDir: string;
let workspace: ProjectWorkspace;
let penpot: FakePenpot;

function makeContext(
    options: { answer?: string; workspace?: WorkflowWorkspaceApi; fileId?: string } = {}
): TestContext {
    const events: { kind: string; payload: any }[] = [];
    const questions: WorkflowQuestion[] = [];
    const context: AgentContext = {
        fileId: options.fileId ?? FILE_ID,
        fileName: "Shop",
        projectId: PROJECT_ID,
        teamId: "team",
        pageId: "page",
        persona: "designer",
        platform: "web",
    };
    const ctx: WorkflowContext = {
        runId: "run",
        context,
        runner: { run: () => Promise.reject(new Error("no Claude in tests")) },
        tools: penpot,
        workspace: options.workspace ?? workspace,
        signal: new AbortController().signal,
        emit: (kind, payload) => events.push({ kind, payload }),
        ask: async (question) => {
            questions.push(question);
            return options.answer ?? Checkpoints.CANCEL_OPTION;
        },
    };
    return { ctx, events, questions };
}

function git(dir: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: dir }).toString().trim();
}

beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-checkpoints-"));
    workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    await workspace.ensure();
    penpot = new FakePenpot();
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

test("create saves a Penpot version, commits and tags both repos, and records the checkpoint", async () => {
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v1</h1>");
    const { ctx, events } = makeContext();

    const checkpoint = await new Checkpoints(ctx).create({
        label: "Before fixing 3 comments",
        workflow: "fix-comments",
    });

    assert.equal(checkpoint.id, "cp-1");
    assert.equal(checkpoint.workflow, "fix-comments");
    assert.equal(checkpoint.fileVersion?.label, "AI checkpoint #1 · Before fixing 3 comments");
    assert.equal(checkpoint.fileVersion?.fileId, FILE_ID);
    assert.equal(checkpoint.warnings, undefined);
    assert.equal(git(workspace.appSrcDir, "rev-parse", "HEAD"), checkpoint.appSha);
    assert.equal(git(workspace.appSrcDir, "status", "--porcelain"), "");
    assert.equal(git(workspace.appSrcDir, "rev-parse", "penforge-cp-1"), checkpoint.appSha);
    assert.equal(git(workspace.designDir, "rev-parse", "penforge-cp-1"), checkpoint.designSha);
    assert.deepEqual(await new CheckpointStore(workspace).list(), [checkpoint]);
    assert.ok(events.some((event) => event.kind === "checkpoint" && event.payload.action === "created"));
});

test("create on clean repos reuses HEAD and numbers checkpoints in order", async () => {
    const { ctx } = makeContext();
    const checkpoints = new Checkpoints(ctx);
    const head = git(workspace.designDir, "rev-parse", "HEAD");

    const first = await checkpoints.create({});
    const second = await checkpoints.create({ workflow: "Not A Name!" });

    assert.equal(first.designSha, head);
    assert.equal(first.label, "Saved by hand");
    assert.equal(second.id, "cp-2");
    assert.equal(second.workflow, "manual");
});

test("concurrent creates get distinct ids", async () => {
    const { ctx } = makeContext();

    const created = await Promise.all([1, 2, 3].map((i) => new Checkpoints(ctx).create({ label: `run ${i}` })));

    assert.deepEqual(created.map((checkpoint) => checkpoint.id).sort(), ["cp-1", "cp-2", "cp-3"]);
    assert.equal((await new CheckpointStore(workspace).list()).length, 3);
});

test("create keeps the code when the Penpot version cannot be saved", async () => {
    penpot.connected = false;
    const { ctx } = makeContext();

    const checkpoint = await new Checkpoints(ctx).create({ label: "Before build" });

    assert.equal(checkpoint.fileVersion, null);
    assert.match(checkpoint.warnings?.[0] ?? "", /design version could not be saved/);
});

test("restore brings back the design and the code, after saving a safety checkpoint", async () => {
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v1</h1>");
    const { ctx } = makeContext();
    const checkpoints = new Checkpoints(ctx);
    const before = await checkpoints.create({ label: "Before fixing comments", workflow: "fix-comments" });
    // the AI change: new design, edited and added files (committed and not)
    penpot.design = "design v2";
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v2</h1>");
    writeFileSync(join(workspace.appSrcDir, "extra.js"), "added");
    await workspace.commitAll("app-src", "penforge(fix-comments): change");
    writeFileSync(join(workspace.appSrcDir, "late.js"), "not committed");
    writeFileSync(join(workspace.designDir, "DESIGN.md"), "# changed");

    const result = await checkpoints.restore({ id: before.id, confirmed: true });

    assert.ok(result);
    assert.equal(result.design, "restoring");
    assert.equal(penpot.design, "design v1");
    assert.equal(readFileSync(join(workspace.appSrcDir, "index.html"), "utf8"), "<h1>v1</h1>");
    assert.equal(existsSync(join(workspace.appSrcDir, "extra.js")), false);
    assert.equal(existsSync(join(workspace.appSrcDir, "late.js")), false);
    assert.equal(existsSync(join(workspace.designDir, "DESIGN.md")), false);
    assert.equal(result.safety.workflow, CheckpointStore.RESTORE_WORKFLOW);
    assert.ok(result.checkpoint.restoredAt);

    // the restore itself can be undone with the safety checkpoint
    const back = await checkpoints.restore({ id: result.safety.id, confirmed: true });
    assert.equal(back?.design, "restoring");
    assert.equal(penpot.design, "design v2");
    assert.equal(readFileSync(join(workspace.appSrcDir, "late.js"), "utf8"), "not committed");
    assert.equal(readFileSync(join(workspace.designDir, "DESIGN.md"), "utf8"), "# changed");
});

test("restore asks first and changes nothing when the user says no", async () => {
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v1</h1>");
    const setup = makeContext();
    const checkpoint = await new Checkpoints(setup.ctx).create({ label: "Before generate" });
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v2</h1>");
    const { ctx, questions, events } = makeContext({ answer: Checkpoints.CANCEL_OPTION });

    await restoreWorkflow.run(ctx, { id: checkpoint.id });

    assert.equal(questions.length, 1);
    assert.match(questions[0].text, /undone/);
    assert.deepEqual(
        questions[0].options.map((option) => option.id),
        [Checkpoints.CONFIRM_OPTION, Checkpoints.CANCEL_OPTION]
    );
    assert.equal(readFileSync(join(workspace.appSrcDir, "index.html"), "utf8"), "<h1>v2</h1>");
    assert.equal((await new CheckpointStore(workspace).list()).length, 1);
    assert.deepEqual(events.at(-1), { kind: "result", payload: { cancelled: true } });
});

test("restore goes ahead when the user agrees to the question", async () => {
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v1</h1>");
    const checkpoint = await new Checkpoints(makeContext().ctx).create({ label: "Before adapt" });
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v2</h1>");
    const { ctx } = makeContext({ answer: Checkpoints.CONFIRM_OPTION });

    const result = await restoreWorkflow.run(ctx, { id: checkpoint.id });

    assert.match(result?.summary ?? "", /design and code restored/);
    assert.equal(readFileSync(join(workspace.appSrcDir, "index.html"), "utf8"), "<h1>v1</h1>");
});

test("undo last walks back through AI checkpoints and skips restore checkpoints", async () => {
    const { ctx } = makeContext();
    const checkpoints = new Checkpoints(ctx);
    const first = await checkpoints.create({ label: "Before batch 1", workflow: "fix-comments" });
    const second = await checkpoints.create({ label: "Before batch 2", workflow: "generate-screen" });

    assert.equal((await checkpoints.list()).undoTargetId, second.id);
    const undone = await checkpoints.restore({ last: true, confirmed: true });
    assert.equal(undone?.checkpoint.id, second.id);

    const listing = await checkpoints.list();
    assert.equal(listing.undoTargetId, first.id);
    assert.deepEqual(
        listing.checkpoints.map((checkpoint) => checkpoint.id),
        ["cp-3", "cp-2", "cp-1"]
    );
    await checkpoints.restore({ last: true, confirmed: true });
    assert.equal((await checkpoints.list()).undoTargetId, null);
    await assert.rejects(checkpoints.restore({ last: true, confirmed: true }), /no AI change to undo/);
});

test("restore refuses a checkpoint of another file and leaves everything as it is", async () => {
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v1</h1>");
    const checkpoint = await new Checkpoints(makeContext().ctx).create({ label: "Before tidy" });
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v2</h1>");
    const { ctx } = makeContext({ fileId: "other-file" });

    await assert.rejects(new Checkpoints(ctx).restore({ id: checkpoint.id, confirmed: true }), /open that file/);

    assert.equal(readFileSync(join(workspace.appSrcDir, "index.html"), "utf8"), "<h1>v2</h1>");
    assert.equal(penpot.restores, 0);
    assert.equal((await new CheckpointStore(workspace).list()).length, 1);
});

test("restore reports a design version deleted in Penpot and still restores the code", async () => {
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v1</h1>");
    const { ctx } = makeContext();
    const checkpoint = await new Checkpoints(ctx).create({ label: "Before build" });
    penpot.versions.length = 0;
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v2</h1>");

    const result = await new Checkpoints(ctx).restore({ id: checkpoint.id, confirmed: true });

    assert.equal(result?.design, "missing");
    assert.match(Checkpoints.restoreSummary(result!), /not found/);
    assert.equal(readFileSync(join(workspace.appSrcDir, "index.html"), "utf8"), "<h1>v1</h1>");
});

test("restore rejects unknown ids", async () => {
    const { ctx } = makeContext();

    await assert.rejects(new Checkpoints(ctx).restore({ id: "cp-9", confirmed: true }), /No checkpoint cp-9/);
    await assert.rejects(new Checkpoints(ctx).restore({ id: "../x", confirmed: true }), /checkpoint id/);
});

test("diff shows the code changed since a checkpoint", async () => {
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v1</h1>\n");
    const { ctx } = makeContext();
    const checkpoint = await new Checkpoints(ctx).create({ label: "Before build" });
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>v2</h1>\n");
    writeFileSync(join(workspace.appSrcDir, "new.js"), "x");

    const diff = await new Checkpoints(ctx).diff(checkpoint.id);

    assert.match(diff.appSrc.patch, /-<h1>v1<\/h1>/);
    assert.match(diff.appSrc.patch, /\+<h1>v2<\/h1>/);
    assert.match(diff.appSrc.stat, /index\.html/);
    assert.deepEqual(diff.appSrc.untracked, ["new.js"]);
    assert.equal(diff.design.patch, "");
});

test("ensureCheckpoint reports a failure as a log event instead of throwing", async () => {
    const broken: WorkflowWorkspaceApi = {
        projectId: workspace.projectId,
        root: workspace.root,
        designDir: workspace.designDir,
        appSrcDir: workspace.appSrcDir,
        metaDir: workspace.metaDir,
        resolve: (path) => workspace.resolve(path),
        commitAll: () => Promise.reject(new Error("disk full")),
        readJson: (name, fallback) => workspace.readJson(name, fallback),
        writeJson: (name, value) => workspace.writeJson(name, value),
    };
    const { ctx, events } = makeContext({ workspace: broken });

    const checkpoint: Checkpoint | null = await ensureCheckpoint(ctx, "Before fixing comments", "fix-comments");

    assert.equal(checkpoint, null);
    assert.ok(events.some((event) => event.kind === "log" && /disk full/.test(event.payload.text)));
});

test("ensureCheckpoint returns the saved checkpoint", async () => {
    const { ctx } = makeContext();

    const checkpoint = await ensureCheckpoint(ctx, "Before fixing comments", "fix-comments");

    assert.equal(checkpoint?.workflow, "fix-comments");
});

test("the checkpoint workflows are registered", () => {
    const names = WorkflowRegistry.withShippedWorkflows().names();

    for (const name of ["checkpoint-create", "checkpoint-restore", "checkpoint-list", "checkpoint-diff"]) {
        assert.ok(names.includes(name), name);
    }
});
