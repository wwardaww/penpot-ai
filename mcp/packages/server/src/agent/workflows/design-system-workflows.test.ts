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
import { ACME_DESIGN_MD } from "../designmd/testing/fixtures";
import { DESIGN_SYSTEM_KEY, PLUGIN_NAMESPACE } from "../designsystem";
import { FakeDesignSystemPenpot } from "../designsystem/testing/FakeDesignSystemPenpot";
import { GitHubIcons, SafeFetch, type HttpAnswer } from "../icons";
import { strokeIcon, tarGz } from "../icons/testing/archives";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { workflow as generateWorkflow, PUBLISH_OPTIONS } from "./design-system-generate";
import { workflow as iconsWorkflow, ICON_CHUNK, ICON_OPTIONS, iconSources } from "./design-system-icons";
import { WorkflowRegistry } from "./WorkflowRegistry";

const PROJECT_ID = "5b0d7a2e-3c4f-4e8a-9a51-2f1e0c9d8b70";
const FILE_ID = "8d3c1f20-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

type Turn = (request: WorkflowClaudeRequest) => string | Promise<string>;

interface Harness {
    ctx: WorkflowContext;
    events: { kind: string; payload: any }[];
    requests: WorkflowClaudeRequest[];
    questions: WorkflowQuestion[];
}

let projectsDir: string;
let workspace: ProjectWorkspace;
let penpot: FakeDesignSystemPenpot;

beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-dsflow-"));
    workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    await workspace.ensure();
    penpot = new FakeDesignSystemPenpot("Untitled");
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

function harness(turns: Turn[] = [], answers: string[] = []): Harness {
    const events: Harness["events"] = [];
    const requests: WorkflowClaudeRequest[] = [];
    const questions: WorkflowQuestion[] = [];
    const ctx: WorkflowContext = {
        runId: "run-1",
        context: {
            fileId: FILE_ID,
            fileName: "Untitled",
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
        tools: penpot.tools(),
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
    return { ctx, events, requests, questions };
}

async function run<P>(workflow: Workflow<P>, params: P, h: Harness): Promise<{ summary: string; result: any }> {
    const output = await workflow.run(h.ctx, params);
    const result = h.events.filter((event) => event.kind === "result").at(-1)?.payload;
    return { summary: output?.summary ?? "", result };
}

/** Claude's components turn: builds and tags one component through plugin code. */
const buildComponents: Turn = async () => {
    await penpot.execute(`const b = penpot.history.undoBlockBegin();
try {
  let page = penpot.currentFile.pages.find((p) => p.name === "Components");
  if (!page) { page = penpot.createPage(); page.name = "Components"; }
  await penpot.openPage(page);
  const board = penpot.createBoard();
  board.name = "Button";
  const c = penpot.library.local.createComponent([board]);
  c.setSharedPluginData("penforge", "designMdComponent", "button-primary");
} finally { penpot.history.undoBlockFinish(b); }`);
    return "Built the button.";
};

function steps(h: Harness): string[] {
    return h.events
        .filter((e) => e.kind === "progress" && typeof e.payload.step === "string")
        .map((e) => e.payload.step);
}

function marker(): any {
    return JSON.parse(penpot.fileDataOf(PLUGIN_NAMESPACE, DESIGN_SYSTEM_KEY) || "null");
}

describe("design system workflows", () => {
    test("are registered", () => {
        const names = WorkflowRegistry.withShippedWorkflows().names();
        assert.ok(names.includes("design-system-generate"));
        assert.ok(names.includes("design-system-icons"));
    });

    test("generate from a DESIGN.md: saved per file, library, pages, components, publish asked once", async () => {
        const h = harness([buildComponents], [PUBLISH_OPTIONS.publish]);
        const { result, summary } = await run(
            generateWorkflow,
            { source: "design-md", text: ACME_DESIGN_MD, fileName: "DESIGN.md" },
            h
        );

        const saved = join(workspace.designDir, "systems", FILE_ID, "DESIGN.md");
        assert.ok(existsSync(saved));
        assert.equal(
            readFileSync(saved, "utf8").replace(/\r\n/g, "\n"),
            ACME_DESIGN_MD.endsWith("\n") ? ACME_DESIGN_MD : `${ACME_DESIGN_MD}\n`
        );
        assert.ok(existsSync(join(workspace.designDir, "systems", FILE_ID, "tokens.json")));
        assert.ok(!existsSync(join(workspace.designDir, "DESIGN.md")), "the project's own DESIGN.md is untouched");

        assert.equal(result.name, "Acme Design");
        assert.ok(result.library.colors.created.length > 0);
        assert.ok(result.pages.colors.items > 0);
        assert.ok(result.pages.typography.items > 0);
        assert.ok(result.pages.tokens.items > 0);
        assert.deepEqual(
            result.components.tagged.map((t: any) => t.key),
            ["button-primary"]
        );
        assert.equal(result.publish, true);
        assert.equal(result.summary.components, 1);
        assert.match(summary, /Acme Design/);

        for (const page of ["Colors", "Typography", "Components", "Tokens"]) {
            assert.ok(penpot.page(page), page);
        }
        assert.deepEqual(
            steps(h).filter((s) => s !== "checkpoint"),
            ["design-md", "library", "colors", "typography", "components", "tokens", "publish"]
        );
        assert.equal(penpot.undo.open, 0);
        assert.equal(penpot.undo.opened, 5, "library, colors, typography, one component, tokens");
        assert.equal(h.questions.length, 1);
        assert.deepEqual(
            h.questions[0].options.map((o) => o.id),
            ["publish", "later"]
        );
        assert.equal(marker().name, "Acme Design");
        assert.equal(marker().publishAsked, true);
        assert.ok(marker().generatedAt);
        assert.equal(h.requests[0].promptName, undefined, "components use this workflow's own prompt");

        // a second run does not ask again
        const again = harness([buildComponents]);
        const second = await run(generateWorkflow, { source: "design-md", text: ACME_DESIGN_MD }, again);
        assert.equal(second.result.publish, null);
        assert.equal(again.questions.length, 0);
        assert.equal(penpot.page("Colors")!.root.children.length, 1, "pages are rebuilt, not duplicated");
    });

    test("generate from a description drafts DESIGN.md with W22's prompt", async () => {
        const h = harness([
            (request) => {
                assert.equal(request.promptName, "design-md-draft");
                assert.match(request.prompt, /calm fintech brand/);
                return ACME_DESIGN_MD;
            },
            buildComponents,
        ]);
        const { result } = await run(
            generateWorkflow,
            { source: "prompt", text: "A calm fintech brand", shared: true },
            h
        );
        assert.equal(steps(h)[1], "draft");
        assert.equal(result.publish, null, "already shared: no question");
        assert.ok(existsSync(join(workspace.designDir, "systems", FILE_ID, "DESIGN.md")));
    });

    test("a DESIGN.md with errors or no text fails with a code before anything changes", async () => {
        const h = harness();
        await assert.rejects(
            run(
                generateWorkflow,
                { source: "design-md", text: '---\ncolors:\n  primary: "{colors.missing}"\n---\n' },
                h
            )
        );
        assert.equal(h.events.find((e) => e.kind === "failed")?.payload.code, "has-errors");
        assert.equal(penpot.library.local.colors.length, 0);

        const empty = harness();
        await assert.rejects(run(generateWorkflow, { source: "prompt", text: "  " }, empty));
        assert.equal(empty.events.find((e) => e.kind === "failed")?.payload.code, "missing-text");
    });

    test("a failing components turn is logged and the rest still runs", async () => {
        const h = harness(
            [
                () => {
                    throw new Error("Claude is not available");
                },
            ],
            [PUBLISH_OPTIONS.later]
        );
        const { result } = await run(generateWorkflow, { source: "design-md", text: ACME_DESIGN_MD }, h);
        assert.ok(
            h.events.some(
                (e) => e.kind === "log" && e.payload.code === "stage-failed" && e.payload.params.stage === "components"
            )
        );
        assert.ok(result.pages.tokens);
        assert.equal(result.publish, false);
    });

    test("icons from SVGs (a .fig file) become components in chunks", async () => {
        const icons = Array.from({ length: ICON_CHUNK + 2 }, (_, i) => ({
            name: `icon-${i}`,
            group: i % 2 === 0 ? "outline" : undefined,
            svg: strokeIcon(`M${i} 0`),
        }));
        icons.push({ name: "evil", group: undefined, svg: "<svg><script>alert(1)</script></svg>" });
        const h = harness();
        const { result } = await run(iconsWorkflow, { source: "svg", icons, origin: "fig:Icons.fig" }, h);
        assert.equal(result.imported, ICON_CHUNK + 2);
        assert.deepEqual(
            result.skipped.map((s: any) => [s.name, s.reason]),
            [["evil", "empty"]]
        );
        assert.equal(result.token.token, "color.icon");
        assert.equal(penpot.undo.opened, 2, "one undo step per chunk");
        assert.ok(penpot.svgs.every((svg) => !svg.includes("script")));
        assert.equal(marker().icons.count, ICON_CHUNK + 2);
        assert.equal(marker().icons.source, "fig:Icons.fig");
        assert.ok(penpot.library.local.components.some((c) => c.path === "Icons / outline"));
    });

    test("icons from GitHub show the license and ask before importing", async () => {
        const archive = tarGz([
            {
                path: "lucide-main/LICENSE",
                content:
                    "ISC License\nPermission to use, copy, modify, and/or distribute this software for any purpose",
            },
            { path: "lucide-main/icons/zap.svg", content: strokeIcon("M1 1") },
            { path: "lucide-main/icons/x.svg", content: strokeIcon("M2 2") },
        ]);
        const http = async (url: string): Promise<HttpAnswer> => ({
            status: url === "https://github.com/lucide-icons/lucide/archive/main.tar.gz" ? 200 : 404,
            headers: { get: () => null },
            body: (async function* () {
                yield archive;
            })(),
        });
        const original = iconSources.github;
        iconSources.github = () => new GitHubIcons(new SafeFetch(http));
        try {
            const declined = harness([], [ICON_OPTIONS.cancel]);
            const first = await run(
                iconsWorkflow,
                { source: "github", url: "https://github.com/lucide-icons/lucide/tree/main/icons" },
                declined
            );
            assert.equal(first.result.cancelled, true);
            assert.match(declined.questions[0].text, /Found 2 icons in lucide-icons\/lucide\. License: ISC/);
            const plan = declined.events.find((e) => e.kind === "plan")!.payload;
            assert.equal(plan.license.spdx, "ISC");
            assert.equal(penpot.library.local.components.length, 0, "nothing changes before the yes");

            const accepted = harness([], [ICON_OPTIONS.import]);
            const second = await run(
                iconsWorkflow,
                { source: "github", url: "https://github.com/lucide-icons/lucide/tree/main/icons" },
                accepted
            );
            assert.equal(second.result.imported, 2);
            assert.equal(second.result.source, "github:lucide-icons/lucide@main/icons");
            assert.deepEqual(penpot.library.local.components.map((c) => c.name).sort(), ["x", "zap"]);
        } finally {
            iconSources.github = original;
        }
    });

    test("a refused GitHub URL fails with its code", async () => {
        const h = harness();
        await assert.rejects(run(iconsWorkflow, { source: "github", url: "https://gitlab.com/a/b" }, h));
        assert.equal(h.events.find((e) => e.kind === "failed")?.payload.code, "host-not-allowed");
    });
});
