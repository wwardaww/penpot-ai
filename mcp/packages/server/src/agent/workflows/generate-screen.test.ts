import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
    AgentContext,
    Workflow,
    WorkflowClaudeRequest,
    WorkflowContext,
    WorkflowToolResult,
} from "@penpot/mcp-common";
import { PromptRegistry } from "../prompts/promptRegistry";
import { WorkflowRegistry } from "./WorkflowRegistry";
import {
    type GenerateScreenDeps,
    type GenerateScreenResult,
    BOARD_GAP,
    MAX_REFERENCES,
    SCREEN_FRAMES,
    createGenerateScreenWorkflow,
    describeDesignSystem,
    executeCode,
    parseAnswer,
    parseParams,
    placeBoard,
    provisionalName,
    reviewIssues,
} from "./generate-screen";
import type { BoardInspection, DesignSystemSnapshot } from "./generate-screen.snippets";

const HERE = dirname(fileURLToPath(import.meta.url));

const CONTEXT: AgentContext = {
    fileId: "file-1",
    fileName: "Shop",
    projectId: "project-1",
    teamId: "team-1",
    pageId: "page-1",
    persona: "designer",
    platform: "mobile",
    mcpSessionId: "tab-1",
};

/** File with a few tokens and a Button component (the acceptance scenario). */
const SNAPSHOT: DesignSystemSnapshot = {
    fileId: "file-1",
    page: { id: "page-1", name: "Screens" },
    freeX: 800,
    topY: 100,
    tokens: [
        { name: "color.primary", type: "color", value: "#3D5AFE", set: "base" },
        { name: "spacing.m", type: "spacing", value: "16", set: "base" },
        { name: "radius.m", type: "borderRadius", value: "8", set: "base" },
    ],
    colors: [],
    typographies: [],
    components: [{ id: "comp-button", name: "Button", path: "Actions", library: "local" }],
    references: [],
    truncated: false,
};

function inspection(overrides: Partial<BoardInspection> = {}): BoardInspection {
    return {
        found: true,
        boardId: "board-1",
        name: "Login",
        width: 390,
        height: 844,
        layerCount: 9,
        instanceCount: 1,
        componentNames: ["Button"],
        tokenizedLayerCount: 5,
        tokenNames: ["color.primary", "spacing.m", "radius.m"],
        layoutContainerCount: 4,
        containersWithoutLayout: [],
        genericNames: [],
        rawColorFillCount: 0,
        absoluteLayerCount: 0,
        ...overrides,
    };
}

function toolResult(value: unknown, isError = false): WorkflowToolResult {
    const text = isError ? String(value) : JSON.stringify({ result: value, log: "" }, null, 2);
    return { isError, content: [{ type: "text", text }], text };
}

interface Harness {
    ctx: WorkflowContext;
    events: { kind: string; payload: any }[];
    requests: WorkflowClaudeRequest[];
    toolCalls: { name: string; args: Record<string, unknown> }[];
}

/**
 * Fake workflow context: tools answer by recognizing the snippet, the runner replays answers.
 */
function harness(opts: {
    inspections?: BoardInspection[];
    answers?: string[];
    screenshotFails?: boolean;
    snapshot?: DesignSystemSnapshot;
}): Harness {
    const events: Harness["events"] = [];
    const requests: WorkflowClaudeRequest[] = [];
    const toolCalls: Harness["toolCalls"] = [];
    const inspections = [
        ...(opts.inspections ?? [inspection({ name: "Draft Login Screen With Email" }), inspection()]),
    ];
    const answers = [...(opts.answers ?? ['Built it.\n{"boardId": "board-1", "name": "Login"}', "Polished."])];
    const abort = new AbortController();
    const ctx: WorkflowContext = {
        runId: "run-1",
        context: CONTEXT,
        signal: abort.signal,
        emit: (kind, payload) => events.push({ kind, payload }),
        ask: () => Promise.reject(new Error("no questions expected")),
        workspace: {
            projectId: "project-1",
            root: "/projects/p",
            designDir: "/projects/p/design",
            appSrcDir: "/projects/p/app-src",
            metaDir: "/projects/p/.penforge",
            resolve: (path) => path,
            commitAll: async () => null,
            readJson: async (_name, fallback) => fallback,
            writeJson: async () => {},
        },
        runner: {
            run: async (request) => {
                requests.push(request);
                return { text: answers.shift() ?? "", sessionId: `session-${requests.length}` };
            },
        },
        tools: {
            list: async () => ["execute_code", "capture_node_screenshot"],
            call: async (name, args = {}) => {
                toolCalls.push({ name, args });
                if (name === "capture_node_screenshot") {
                    if (opts.screenshotFails) {
                        return toolResult("render failed", true);
                    }
                    return {
                        isError: false,
                        content: [
                            { type: "image", data: "aW1n", mimeType: "image/jpeg" },
                            { type: "text", text: "{}" },
                        ],
                        text: "{}",
                    };
                }
                const code = String(args.code);
                if (code.includes("penpot.library.local.tokens")) {
                    return toolResult(opts.snapshot ?? SNAPSHOT);
                }
                if (code.includes("createBoard")) {
                    const parsed = JSON.parse(code.match(/const args = (.*);/)![1]);
                    return toolResult({ boardId: "board-1", ...parsed });
                }
                if (code.includes("genericNames")) {
                    return toolResult(inspections.shift() ?? inspection());
                }
                return toolResult(`unexpected code: ${code.slice(0, 40)}`, true);
            },
        },
    };
    return { ctx, events, requests, toolCalls };
}

const NO_EXTRAS: GenerateScreenDeps = {
    findWorkflow: async () => undefined,
    readDesignMd: async () => null,
};

function snippetArgs(code: unknown): Record<string, any> {
    return JSON.parse(String(code).match(/const args = (.*);/)![1]);
}

// --- pure helpers

test("parseParams trims the prompt and takes the platform from the tab", () => {
    const params = parseParams({ prompt: "  login screen ", referenceNodeIds: ["a", "a", "b"] }, "mobile");
    assert.deepEqual(params, {
        prompt: "login screen",
        platform: "mobile",
        targetPageId: undefined,
        referenceNodeIds: ["a", "b"],
    });
    assert.equal(parseParams({ prompt: "x", platform: "web" }, "mobile").platform, "web");
    assert.equal(parseParams({ prompt: "x" }, undefined).platform, "web");
});

test("parseParams rejects bad input", () => {
    assert.throws(() => parseParams({}, "web"), /non-empty prompt/);
    assert.throws(() => parseParams({ prompt: "   " }, "web"), /non-empty prompt/);
    assert.throws(() => parseParams({ prompt: "x", platform: "tv" }, "web"), /Unknown platform/);
    assert.throws(() => parseParams({ prompt: "x", referenceNodeIds: "a" }, "web"), /referenceNodeIds/);
    assert.throws(() => parseParams({ prompt: "x".repeat(5000) }, "web"), /too long/);
    const many = Array.from({ length: 20 }, (_, i) => `n${i}`);
    assert.equal(parseParams({ prompt: "x", referenceNodeIds: many }, "web").referenceNodeIds.length, MAX_REFERENCES);
});

test("placeBoard puts the board right of the page content, or at the origin of an empty page", () => {
    assert.deepEqual(placeBoard({ freeX: null, topY: null }), { x: 0, y: 0 });
    assert.deepEqual(placeBoard({ freeX: 1440.4, topY: -20 }), { x: 1440 + BOARD_GAP, y: -20 });
});

test("provisionalName takes the first words of the prompt", () => {
    assert.equal(provisionalName("login screen, with email + password"), "Draft Login Screen With Email");
    assert.equal(provisionalName("!!!"), "Draft Screen");
});

test("parseAnswer reads the trailing JSON line", () => {
    assert.deepEqual(parseAnswer('A login form.\n{"boardId": "b1", "name": "Login"}\n'), {
        boardId: "b1",
        name: "Login",
        notes: "A login form.",
    });
    assert.deepEqual(parseAnswer("Just text"), { notes: "Just text" });
    assert.deepEqual(parseAnswer('Text\n{"boardId": broken'), { notes: 'Text\n{"boardId": broken' });
});

test("describeDesignSystem lists components, tokens and DESIGN.md", () => {
    const text = describeDesignSystem(
        {
            ...SNAPSHOT,
            colors: [{ id: "c1", name: "Brand", path: "Core", color: "#3D5AFE", opacity: 1, library: "local" }],
            typographies: [
                {
                    id: "t1",
                    name: "Body",
                    path: "",
                    fontFamily: "Inter",
                    fontSize: "16",
                    fontWeight: "400",
                    lineHeight: "1.5",
                    library: "UI Kit",
                },
            ],
            truncated: true,
        },
        "# Rules\nUse 8 px spacing."
    );
    assert.match(text, /- Actions \/ Button \(id comp-button\)/);
    assert.match(text, /- color\.primary: color = #3D5AFE/);
    assert.match(text, /- Core \/ Brand = #3D5AFE \(id c1\)/);
    assert.match(text, /- Body: Inter 16\/1\.5 weight 400 \(id t1\) \[library UI Kit\]/);
    assert.match(text, /Some lists were cut/);
    assert.match(text, /## DESIGN\.md of the project[\s\S]*Use 8 px spacing\./);

    const empty = describeDesignSystem({ ...SNAPSHOT, components: [], tokens: [] }, null);
    assert.match(empty, /Components: none\./);
    assert.match(empty, /Tokens: none\./);
    assert.doesNotMatch(empty, /DESIGN\.md/);
});

test("reviewIssues reports what breaks the design rules", () => {
    assert.deepEqual(reviewIssues(inspection(), SNAPSHOT, "Login Screen"), []);
    const issues = reviewIssues(
        inspection({
            name: "Login Screen",
            genericNames: ["Rectangle", "Board 2"],
            containersWithoutLayout: ["Form"],
            absoluteLayerCount: 2,
            instanceCount: 0,
            tokenizedLayerCount: 0,
            rawColorFillCount: 3,
        }),
        SNAPSHOT,
        "Login Screen"
    );
    assert.equal(issues.length, 7);
    assert.match(issues[0], /Rename the screen board/);
    assert.match(issues[1], /"Rectangle", "Board 2"/);
    assert.match(issues[2], /"Form"/);
    assert.match(issues[3], /2 layer\(s\) use absolute position/);
    assert.match(issues[4], /uses none/);
    assert.match(issues[5], /none is applied/);
    assert.match(issues[6], /3 fill\(s\) use raw colors/);
    assert.deepEqual(reviewIssues(inspection({ layerCount: 0 }), SNAPSHOT, "x"), [
        "The screen board is empty: build the screen inside it.",
    ]);
    // no design system: drawn elements and raw colors are fine
    const bare = { components: [], tokens: [], colors: [] };
    assert.deepEqual(reviewIssues(inspection({ instanceCount: 0, rawColorFillCount: 4 }), bare, "x"), []);
});

test("executeCode unwraps the plugin result and reports tool errors", async () => {
    const { ctx } = harness({});
    const call = ctx.tools.call;
    (ctx.tools as any).call = async () => toolResult({ a: 1 });
    assert.deepEqual(await executeCode(ctx, "return 1"), { a: 1 });
    (ctx.tools as any).call = async () => toolResult("boom", true);
    await assert.rejects(executeCode(ctx, "return 1"), /boom/);
    (ctx.tools as any).call = async () => ({ isError: false, content: [], text: "Code executed successfully" });
    await assert.rejects(executeCode(ctx, "return 1"), /Unexpected execute_code output/);
    (ctx.tools as any).call = call;
});

// --- the workflow with a fake runner and fake tools

test("generates a screen: design system, board, build turn, review turn and result", async () => {
    const h = harness({});
    const workflow = createGenerateScreenWorkflow(NO_EXTRAS);
    const result = await workflow.run(h.ctx, {
        prompt: "login screen with email, password and sign-in button",
    });

    // design system read on the tab's page, board created right of the content, sized for mobile
    const [read, create] = h.toolCalls;
    assert.equal(read.name, "execute_code");
    assert.deepEqual(snippetArgs(read.args.code).pageId, "page-1");
    const board = snippetArgs(create.args.code);
    assert.equal(board.pageId, "page-1");
    assert.equal(board.x, 800 + BOARD_GAP);
    assert.equal(board.y, 100);
    assert.equal(board.width, SCREEN_FRAMES.mobile.width);
    assert.equal(board.height, SCREEN_FRAMES.mobile.height);
    assert.deepEqual(board.guides, [47, 810]);
    assert.equal(board.name, "Draft Login Screen With Email");

    // build turn: the request names the board and lists the Button and the tokens
    assert.equal(h.requests.length, 2);
    const build = h.requests[0];
    assert.match(build.prompt, /Design this screen: login screen with email/);
    assert.match(build.prompt, /boardId board-1 on pageId page-1, iPhone 390×844/);
    assert.match(build.prompt, /Actions \/ Button \(id comp-button\)/);
    assert.match(build.prompt, /color\.primary: color = #3D5AFE/);
    assert.match(build.prompt, /Safe-area guides at y = 47 and 810 px/);
    assert.equal(build.attachments, undefined);
    assert.equal(build.promptName, undefined);

    // review turn resumes the build session with the screenshot
    const review = h.requests[1];
    assert.equal(review.resumeSessionId, "session-1");
    assert.deepEqual(review.attachments, [{ kind: "image", mime: "image/jpeg", base64: "aW1n" }]);
    assert.match(review.prompt, /Here is a screenshot/);
    assert.match(review.prompt, /An automatic check also found:\n- Rename the screen board/);

    const shot = h.toolCalls.find((call) => call.name === "capture_node_screenshot");
    assert.deepEqual(shot?.args, { nodeId: "board-1", scale: 1, format: "jpeg" });

    // result event and summary
    const resultEvent = h.events.find((event) => event.kind === "result");
    const payload = resultEvent?.payload as GenerateScreenResult;
    assert.equal(payload.boardId, "board-1");
    assert.equal(payload.pageId, "page-1");
    assert.equal(payload.platform, "mobile");
    assert.deepEqual(payload.inspection.componentNames, ["Button"]);
    assert.deepEqual(payload.remainingIssues, []);
    assert.equal(payload.notes, "Polished.");
    assert.equal(result?.summary, 'Created "Login" (390×844) using 1 component instance and 3 tokens');

    const plan = h.events.find((event) => event.kind === "plan");
    assert.deepEqual(plan?.payload, { boardId: "board-1", pageId: "page-1", platform: "mobile" });
    assert.deepEqual(
        h.events.filter((event) => event.kind === "progress").map((event) => event.payload),
        [
            { step: "design-system", text: "Reading the design system" },
            { step: "board", text: "Creating the board" },
            { step: "build", text: "Designing the screen" },
            { step: "check", text: "Checking the result" },
            { step: "review", text: "Polishing the screen" },
        ]
    );
});

test("uses the target page, the platform param and attaches the reference layers", async () => {
    const h = harness({
        snapshot: {
            ...SNAPSHOT,
            page: { id: "page-2", name: "Flows" },
            freeX: null,
            topY: null,
            references: [{ id: "ref-1", name: "Old Login", type: "board", pageId: "page-9" }],
        },
    });
    await createGenerateScreenWorkflow(NO_EXTRAS).run(h.ctx, {
        prompt: "login",
        platform: "web",
        targetPageId: "page-2",
        referenceNodeIds: ["ref-1"],
    });
    const read = snippetArgs(h.toolCalls[0].args.code);
    assert.equal(read.pageId, "page-2");
    assert.deepEqual(read.referenceNodeIds, ["ref-1"]);
    const board = snippetArgs(h.toolCalls[1].args.code);
    assert.deepEqual([board.pageId, board.x, board.y, board.width, board.height], ["page-2", 0, 0, 1440, 1024]);
    assert.deepEqual(board.guides, []);
    assert.deepEqual(h.requests[0].attachments, [
        { kind: "node", fileId: "file-1", pageId: "page-9", nodeId: "ref-1", name: "Old Login", type: "board" },
    ]);
    assert.match(h.requests[0].prompt, /Follow the look and structure of the attached reference layers/);
});

test("saves a checkpoint first when the checkpoint workflow is registered, and reads DESIGN.md", async () => {
    const h = harness({});
    const order: string[] = [];
    const checkpointWorkflow: Workflow<any> = {
        name: "checkpoint-create",
        description: "fake",
        run: async (_ctx, params) => {
            order.push(`checkpoint:${params.label}:${params.workflow}`);
            assert.equal(h.toolCalls.filter((call) => String(call.args.code).includes("createBoard")).length, 0);
            return { summary: "saved" };
        },
    };
    await createGenerateScreenWorkflow({
        findWorkflow: async (name) => (name === "checkpoint-create" ? checkpointWorkflow : undefined),
        readDesignMd: async () => "Primary buttons are pill shaped.",
    }).run(h.ctx, { prompt: "login" });
    assert.deepEqual(order, ["checkpoint:Before generating a screen:generate-screen"]);
    assert.match(h.requests[0].prompt, /Primary buttons are pill shaped\./);
});

test("a failing checkpoint is logged and the run goes on", async () => {
    const h = harness({});
    await createGenerateScreenWorkflow({
        findWorkflow: async () => ({
            name: "checkpoint-create",
            description: "fake",
            run: async () => {
                throw new Error("disk full");
            },
        }),
        readDesignMd: async () => null,
    }).run(h.ctx, { prompt: "login" });
    assert.deepEqual(h.events.find((event) => event.kind === "log")?.payload, {
        code: "checkpoint-failed",
        params: { message: "disk full" },
        text: "Checkpoint failed: disk full",
    });
    assert.ok(h.events.some((event) => event.kind === "result"));
});

test("reviews without an image when the screenshot fails, and reports remaining issues", async () => {
    const h = harness({
        screenshotFails: true,
        inspections: [
            inspection({ genericNames: ["Rectangle"] }),
            inspection({ genericNames: ["Rectangle"], instanceCount: 0 }),
        ],
    });
    const result = await createGenerateScreenWorkflow(NO_EXTRAS).run(h.ctx, { prompt: "login" });
    assert.equal(h.requests[1].attachments, undefined);
    assert.match(h.requests[1].prompt, /no screenshot could be taken/);
    assert.match(h.requests[1].prompt, /"Rectangle"/);
    const payload = h.events.find((event) => event.kind === "result")?.payload as GenerateScreenResult;
    assert.equal(payload.remainingIssues.length, 2);
    assert.equal(result?.summary, 'Created "Login" (390×844) using 3 tokens');
});

test("fails when the board disappears or a snippet fails", async () => {
    const gone = harness({ inspections: [inspection({ found: false })] });
    await assert.rejects(createGenerateScreenWorkflow(NO_EXTRAS).run(gone.ctx, { prompt: "login" }), /removed/);

    const broken = harness({});
    const call = broken.ctx.tools.call;
    (broken.ctx.tools as any).call = async (name: string, args: Record<string, unknown>) =>
        String(args.code).includes("createBoard") ? toolResult("Page not found: p", true) : call(name, args);
    await assert.rejects(
        createGenerateScreenWorkflow(NO_EXTRAS).run(broken.ctx, { prompt: "login" }),
        /Page not found/
    );
    assert.equal(broken.requests.length, 0);
});

test("stops before the build turn when the run is cancelled", async () => {
    const h = harness({});
    const abort = new AbortController();
    (h.ctx as any).signal = abort.signal;
    const call = h.ctx.tools.call;
    (h.ctx.tools as any).call = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args);
        if (String(args.code).includes("createBoard")) {
            abort.abort();
        }
        return result;
    };
    await assert.rejects(createGenerateScreenWorkflow(NO_EXTRAS).run(h.ctx, { prompt: "login" }), /cancelled/);
    assert.equal(h.requests.length, 0);
});

// --- registration and prompt

test("the workflow is shipped and its prompt renders per platform", () => {
    assert.ok(WorkflowRegistry.withShippedWorkflows().names().includes("generate-screen"));
    const prompts = new PromptRegistry(join(HERE, "..", "prompts"), HERE);
    const template = prompts.workflowPrompt("generate-screen");
    assert.ok(template);
    const mobile = prompts.render(template!, { persona: "designer", platform: "mobile", projectName: "Shop" });
    assert.match(mobile, /home indicator area/);
    assert.doesNotMatch(mobile, /responsive web/);
    assert.doesNotMatch(mobile, /\{\{/);
    const web = prompts.render(template!, { persona: "developer", platform: "web", projectName: "Shop" });
    assert.match(web, /responsive web/);
    assert.match(web, /list the sections/);
    assert.doesNotMatch(web, /home indicator/);
});
