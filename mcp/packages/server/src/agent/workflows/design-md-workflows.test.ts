import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
    Workflow,
    WorkflowClaudeRequest,
    WorkflowClaudeResult,
    WorkflowContext,
    WorkflowQuestion,
} from "@penpot/mcp-common";
import { FakePenpot } from "../designmd/testing/FakePenpot";
import { ACME_DESIGN_MD, buildButton } from "../designmd/testing/fixtures";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { workflow as draftWorkflow } from "./design-md-draft";
import { workflow as exportWorkflow } from "./design-md-export";
import { workflow as importWorkflow } from "./design-md-import";
import { workflow as readWorkflow } from "./design-md-read";
import { workflow as saveWorkflow } from "./design-md-save";
import { WorkflowRegistry } from "./WorkflowRegistry";

const PROJECT_ID = "5b0d7a2e-3c4f-4e8a-9a51-2f1e0c9d8b70";

/** Claude stand-in: answers each turn with the next scripted function. */
type Turn = (request: WorkflowClaudeRequest) => string | Promise<string>;

interface Harness {
    ctx: WorkflowContext;
    events: { kind: string; payload: any }[];
    requests: WorkflowClaudeRequest[];
    questions: WorkflowQuestion[];
    toolCalls: string[];
}

let projectsDir: string;
let workspace: ProjectWorkspace;
let penpot: FakePenpot;

beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-designmd-"));
    workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    await workspace.ensure();
    penpot = new FakePenpot("Acme");
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

function harness(turns: Turn[] = [], answers: string[] = []): Harness {
    const events: Harness["events"] = [];
    const requests: WorkflowClaudeRequest[] = [];
    const questions: WorkflowQuestion[] = [];
    const toolCalls: string[] = [];
    const ctx: WorkflowContext = {
        runId: "run-1",
        context: {
            fileId: "file-1",
            fileName: "Acme",
            projectId: PROJECT_ID,
            teamId: "team-1",
            pageId: "page-1",
            persona: "designer",
            platform: "web",
        },
        runner: {
            run: async (request: WorkflowClaudeRequest): Promise<WorkflowClaudeResult> => {
                requests.push(request);
                const turn = turns.shift();
                if (!turn) {
                    throw new Error("unexpected Claude turn");
                }
                return { text: await turn(request), sessionId: "session-1" };
            },
        },
        tools: penpot.tools(toolCalls),
        workspace,
        signal: new AbortController().signal,
        emit: (kind, payload) => events.push({ kind, payload }),
        ask: async (question) => {
            questions.push(question);
            const answer = answers.shift();
            if (answer === undefined) {
                throw new Error("unexpected question");
            }
            return answer;
        },
    };
    return { ctx, events, requests, questions, toolCalls };
}

async function run<P>(workflow: Workflow<P>, params: P, h: Harness): Promise<{ summary: string; result: any }> {
    const output = await workflow.run(h.ctx, params);
    const result = h.events.filter((event) => event.kind === "result").at(-1)?.payload;
    return { summary: output?.summary ?? "", result };
}

function designFile(name: string): string {
    return readFileSync(join(workspace.designDir, name), "utf8");
}

describe("design-md workflows", () => {
    test("are registered", () => {
        const names = WorkflowRegistry.withShippedWorkflows().names();

        for (const name of [
            "design-md-read",
            "design-md-save",
            "design-md-draft",
            "design-md-import",
            "design-md-export",
        ]) {
            assert.ok(names.includes(name), name);
        }
    });

    test("read without a DESIGN.md reports that it does not exist", async () => {
        const { result } = await run(readWorkflow, {}, harness());

        assert.equal(result.exists, false);
        assert.equal(result.content, "");
        assert.deepEqual(result.history, []);
    });

    test("save commits DESIGN.md and tokens.json; read lists history and old versions", async () => {
        const saved = await run(saveWorkflow, { content: ACME_DESIGN_MD.replace(/\n/g, "\r\n") }, harness());
        assert.equal(designFile("DESIGN.md"), ACME_DESIGN_MD);
        const second = await run(
            saveWorkflow,
            { content: ACME_DESIGN_MD.replace("Acme Design", "Acme 2"), message: "rename" },
            harness()
        );

        assert.match(saved.result.commit, /^[0-9a-f]{40}$/);
        assert.deepEqual(saved.result.issues, []);
        assert.equal(JSON.parse(designFile("tokens.json")).color.primary.$value, "#2B59C3");

        const { result } = await run(readWorkflow, {}, harness());
        assert.equal(result.exists, true);
        assert.match(result.content, /name: Acme 2/);
        assert.deepEqual(
            result.history.map((entry: any) => entry.subject),
            ["penforge(design-md): rename", "penforge(design-md): edit DESIGN.md"]
        );

        const old = await run(readWorkflow, { ref: saved.result.commit }, harness());
        assert.equal(old.result.content, ACME_DESIGN_MD);
        assert.equal(second.summary, "DESIGN.md saved");

        const unchanged = await run(
            saveWorkflow,
            { content: ACME_DESIGN_MD.replace("Acme Design", "Acme 2") },
            harness()
        );
        assert.equal(unchanged.result.commit, null);
    });

    test("read refuses a ref that is not a commit hash", async () => {
        await assert.rejects(run(readWorkflow, { ref: "HEAD~1; rm -rf" }, harness()), /Invalid commit/);
    });

    test("import applies the acceptance DESIGN.md, then export regenerates the same file", async () => {
        const h = harness([
            (request) => {
                assert.match(request.prompt, /"key": "button-primary"/);
                assert.match(request.prompt, /token radius\.md/);
                buildButton(penpot);
                return "Built the primary button.";
            },
        ]);

        const imported = await run(importWorkflow, { content: ACME_DESIGN_MD }, h);

        assert.deepEqual(penpot.currentFile.versions, ["Before applying DESIGN.md"]);
        assert.equal(imported.result.checkpoint, "Before applying DESIGN.md");
        assert.equal(imported.result.colors.created.length, 8);
        assert.equal(imported.result.typographies.created.length, 4);
        assert.equal(imported.result.tokens.created.length, 17);
        assert.deepEqual(imported.result.components, {
            tagged: [
                { key: "button-primary", componentId: penpot.library.local.components[0].id, name: "button-primary" },
            ],
            missing: [],
        });
        assert.equal(
            imported.summary,
            "Applied DESIGN.md: 8 colors, 4 text styles, 17 tokens, 1 components added or updated"
        );
        assert.equal(designFile("DESIGN.md"), ACME_DESIGN_MD);
        assert.deepEqual(
            h.events.filter((event) => event.kind === "progress").map((event) => event.payload.summary),
            ["Saving a version of the file", "Creating tokens, colors and text styles", "Building components"]
        );

        // every component has notes and the overview has text: no Claude turn
        const exported = await run(exportWorkflow, {}, harness());

        assert.equal(exported.result.content, ACME_DESIGN_MD);
        assert.equal(exported.result.commit, null);
        assert.equal(exported.summary, "DESIGN.md already matches the file");

        penpot.library.local.tokens.sets[0].tokens.find((token) => token.name === "spacing.md")!.value = "20";
        const changed = await run(exportWorkflow, {}, harness());
        assert.match(changed.result.content, /^ {2}md: 20px$/m);
        assert.match(changed.result.commit, /^[0-9a-f]{40}$/);
    });

    test("import without content uses the saved file and can skip components", async () => {
        await run(saveWorkflow, { content: ACME_DESIGN_MD }, harness());
        const h = harness();

        const imported = await run(importWorkflow, { components: false }, h);

        assert.equal(imported.result.components, null);
        assert.equal(h.requests.length, 0);
        assert.equal(penpot.library.local.colors.length, 8);
    });

    test("import refuses a DESIGN.md with errors and a missing one", async () => {
        await assert.rejects(
            run(importWorkflow, { content: ACME_DESIGN_MD.replace('"#BA1A1A"', '"#BA1Z"') }, harness()),
            /DESIGN.md has errors: colors.error/
        );
        await assert.rejects(run(importWorkflow, {}, harness()), /There is no DESIGN.md yet/);
        assert.equal(penpot.library.local.colors.length, 0);
        assert.equal(existsSync(join(workspace.designDir, "DESIGN.md")), false);
    });

    test("import asks before going on without a checkpoint", async () => {
        penpot.failSaveVersion = true;
        const stopped = harness([], ["stop"]);

        await assert.rejects(
            run(importWorkflow, { content: ACME_DESIGN_MD, components: false }, stopped),
            /Stopped before changing the file/
        );
        assert.equal(stopped.questions.length, 1);
        assert.equal(penpot.library.local.colors.length, 0);

        const continued = harness([], ["continue"]);
        const imported = await run(importWorkflow, { content: ACME_DESIGN_MD, components: false }, continued);
        assert.equal(imported.result.checkpoint, null);
        assert.equal(penpot.library.local.colors.length, 8);
    });

    test("draft retries once with the errors, then saves and commits", async () => {
        const broken = ACME_DESIGN_MD.replace('"#2B59C3"', '"blue-ish"');
        const h = harness([
            () => "Here is your file:\n\n```markdown\n" + broken + "```",
            (request) => {
                assert.match(request.prompt, /colors.primary: blue-ish is not a CSS color/);
                assert.equal(request.resumeSessionId, "session-1");
                return ACME_DESIGN_MD;
            },
        ]);

        const drafted = await run(draftWorkflow, { prompt: "A calm banking app" }, h);

        assert.match(h.requests[0].prompt, /Request: A calm banking app/);
        assert.equal(drafted.result.content, ACME_DESIGN_MD);
        assert.deepEqual(drafted.result.issues, []);
        assert.match(drafted.result.commit, /^[0-9a-f]{40}$/);
        assert.equal(designFile("DESIGN.md"), ACME_DESIGN_MD);
        assert.equal(drafted.summary, "DESIGN.md drafted");
    });

    test("export from a file without DESIGN.md asks Claude for the overview and component notes", async () => {
        await penpot.execute(
            (await import("../designmd/PenpotScripts")).PenpotScripts.importScript(
                (await import("../designmd/PenpotImportPlan")).PenpotImportPlanner.plan(
                    (await import("../designmd")).parseDesignMd(ACME_DESIGN_MD).document
                )
            )
        );
        buildButton(penpot);
        const h = harness([
            (request) => {
                assert.match(request.prompt, /Components that need usage notes: button-primary\./);
                assert.match(request.prompt, /Overview needed: yes\./);
                return '```json\n{"overview": "Calm.", "components": {"button-primary": "Main action.", "other": "x"}}\n```';
            },
        ]);

        const exported = await run(exportWorkflow, {}, h);

        assert.match(exported.result.content, /## Overview\n\nCalm\.\n/);
        assert.match(exported.result.content, /## Components\n\n### button-primary\n\nMain action\.\n/);
        assert.doesNotMatch(exported.result.content, /### other/);
        assert.match(exported.result.content, /^name: Acme$/m);
        assert.deepEqual(
            exported.result.issues.filter((issue: any) => issue.severity === "error"),
            []
        );
        assert.match(exported.summary, /DESIGN.md updated from the file/);
    });
});
