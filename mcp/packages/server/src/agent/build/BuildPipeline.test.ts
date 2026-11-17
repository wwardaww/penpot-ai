import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type {
    Persona,
    WorkflowClaudeRequest,
    WorkflowClaudeResult,
    WorkflowContext,
    WorkflowToolResult,
} from "@penpot/mcp-common";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { AppBuilder, type PreBuildRunner } from "./AppBuilder";
import { BuildFiles, CommandSchema } from "./BuildFiles";
import { BuildPlanner, type PlanEventPayload } from "./BuildPlanner";
import type { CommandExecutor, CommandOptions, CommandOutcome } from "./CommandExecutor";
import { ProcessCommandExecutor } from "./CommandExecutor";
import { JsonReply } from "./JsonReply";
import { Routes } from "./Routes";
import { BuildLock } from "./BuildLock";
import { ChildEnvironment } from "./ChildEnvironment";
import { StackCommand } from "./StackCommand";

const LOGIN = "board-login";
const DASHBOARD = "board-dashboard";

/** Mutable two-board design: Login → Dashboard on click. */
class FakeDesign {
    public texts: Record<string, string> = { [LOGIN]: "Sign in", [DASHBOARD]: "Welcome back" };
    public boards = [
        { id: LOGIN, name: "Login" },
        { id: DASHBOARD, name: "Dashboard" },
    ];

    public call(tool: string, args: Record<string, unknown> = {}): WorkflowToolResult {
        const ok = (value: unknown) => ({ isError: false, content: [], text: JSON.stringify(value) });
        switch (tool) {
            case "list_boards":
                return ok(
                    this.boards.map((b) => ({ ...b, pageId: "page-1", pageName: "Page 1", width: 390, height: 844 }))
                );
            case "get_prototype_graph":
                return ok({
                    pages: [{ id: "page-1", name: "Page 1", boardCount: this.boards.length }],
                    flows: [{ name: "Main", pageId: "page-1", startingBoardId: LOGIN, startingBoardName: "Login" }],
                    boards: this.boards,
                    edges: [
                        {
                            from: LOGIN,
                            to: DASHBOARD,
                            type: "navigate",
                            trigger: "click",
                            sourceId: "btn",
                            sourceName: "Sign in button",
                            pageId: "page-1",
                        },
                    ],
                });
            case "generate_code_hints":
                return ok({ nodeId: args.nodeId, html: `<div>${this.texts[String(args.nodeId)]}</div>`, css: "" });
            default:
                return { isError: true, content: [], text: `unknown tool ${tool}` };
        }
    }
}

/** Scripted Claude: answers each build step by writing files into app-src. */
class FakeClaude {
    public readonly prompts: string[] = [];
    /** file written by the next screen turn of Dashboard on top of its own (to test reverts) */
    public dashboardAlsoWrites: string | null = null;
    private turn = 0;

    constructor(private readonly appSrc: string) {}

    public async run(request: WorkflowClaudeRequest): Promise<WorkflowClaudeResult> {
        this.prompts.push(request.prompt);
        const sessionId = request.resumeSessionId ?? `session-${++this.turn}`;
        const prompt = request.prompt;
        if (prompt.startsWith("Plan the app")) {
            return {
                sessionId,
                text: `Here is the plan.\n\`\`\`json\n${JSON.stringify(FakeClaude.planReply())}\n\`\`\``,
            };
        }
        if (prompt.startsWith("## Step: scaffold")) {
            this.write("package.json", '{ "name": "app" }\n');
            this.write("src/App.tsx", "routes\n");
            this.write("src/screens/Login.tsx", "placeholder\n");
            this.write("src/screens/Dashboard.tsx", "placeholder\n");
            return { sessionId, text: `\`\`\`json\n${JSON.stringify({ stack: FakeClaude.stack() })}\n\`\`\`` };
        }
        const screen = /## Step: (?:build|update) the screen "([^"]+)"/.exec(prompt)?.[1];
        if (screen) {
            const file = `src/screens/${screen}.tsx`;
            const old = this.read(file);
            this.write(file, `${screen} v${Number(old.match(/ v(\d+)/)?.[1] ?? 0) + 1}\n`);
            this.write(`src/screens/${screen}.module.css`, `.${screen} {}\n`);
            if (screen === "Dashboard" && this.dashboardAlsoWrites) {
                this.write(this.dashboardAlsoWrites, "touched by Dashboard\n");
            }
            return {
                sessionId,
                text: `\`\`\`json\n{ "files": ["${file}", "./src/screens/${screen}.module.css"] }\n\`\`\``,
            };
        }
        if (prompt.startsWith("## Step: fix")) {
            this.write("src/fixed.ts", "export const fixed = true;\n");
            return { sessionId, text: "Fixed the import." };
        }
        return { sessionId, text: "ok" };
    }

    private write(file: string, content: string): void {
        const path = join(this.appSrc, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }

    private read(file: string): string {
        try {
            return readFileSync(join(this.appSrc, file), "utf8");
        } catch {
            return "";
        }
    }

    public static stack() {
        return {
            name: "React + Vite + TypeScript",
            version: "react 19",
            packageManager: "npm",
            commands: {
                install: ["npm", "install"],
                build: ["npm", "run", "build"],
                dev: ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"],
            },
            portEnv: "PORT",
        };
    }

    public static planReply() {
        return {
            summary: "Login leads to the Dashboard when you press Sign in.",
            stack: FakeClaude.stack(),
            screens: [
                { boardId: LOGIN, name: "Login", route: "/" },
                { boardId: DASHBOARD, name: "Dashboard", route: "/dashboard" },
                { boardId: "unknown-board", name: "Ghost", route: "/ghost" },
            ],
            components: [{ name: "PrimaryButton", purpose: "Sign in button" }],
            tree: "app-src/\n  src/",
            notes: "",
        };
    }
}

/** Command executor recording calls; fails the build command a given number of times. */
class FakeExecutor implements CommandExecutor {
    public readonly calls: string[] = [];
    public buildFailures = 0;

    public async execute(argv: string[], options: CommandOptions): Promise<CommandOutcome> {
        this.calls.push(argv.join(" "));
        if (argv.includes("install")) {
            mkdirSync(join(options.cwd, "node_modules"), { recursive: true });
        }
        if (argv.includes("build") && this.buildFailures > 0) {
            this.buildFailures--;
            return { code: 2, output: "src/App.tsx(3,1): error TS2307: Cannot find module './fixed'", timedOut: false };
        }
        return { code: 0, output: "ok", timedOut: false };
    }
}

interface Emitted {
    kind: string;
    payload: any;
}

let home: string;
let workspace: ProjectWorkspace;
let design: FakeDesign;
let claude: FakeClaude;
let executor: FakeExecutor;
let events: Emitted[];

function context(persona: Persona = "designer", answers: string[] = []): WorkflowContext {
    return {
        runId: "run-1",
        context: {
            fileId: "file-1",
            fileName: "Shop",
            projectId: "project-1",
            teamId: "team-1",
            pageId: "page-1",
            persona,
            platform: "web",
        },
        runner: { run: (request) => claude.run(request) },
        tools: {
            call: async (tool, args) => design.call(tool, args),
            list: async () => ["list_boards", "get_prototype_graph", "generate_code_hints"],
        },
        workspace,
        signal: new AbortController().signal,
        emit: (kind, payload) => {
            events.push({ kind, payload });
        },
        ask: async (question) => {
            events.push({ kind: "question", payload: question });
            const answer = answers.shift();
            if (answer === undefined) {
                throw new Error("no questions expected");
            }
            return answer;
        },
    };
}

async function plan(persona: Persona = "designer", mode?: "full"): Promise<PlanEventPayload> {
    events = [];
    await new BuildPlanner(context(persona)).plan({ mode, ask: false });
    const event = events.find((e) => e.kind === "plan");
    assert.ok(event, "plan event emitted");
    return event.payload as PlanEventPayload;
}

async function build(persona: Persona = "designer", params: Record<string, unknown> = {}, preBuild?: PreBuildRunner) {
    events = [];
    return new AppBuilder(context(persona), { executor, preBuild, maxFixAttempts: 2 }).build(params);
}

function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: workspace.appSrcDir, encoding: "utf8" });
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-build-"));
    workspace = new ProjectWorkspace(join(home, "projects"), "project-1");
    await workspace.ensure();
    design = new FakeDesign();
    claude = new FakeClaude(workspace.appSrcDir);
    executor = new FakeExecutor();
    events = [];
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

test("first build: plan for a designer, then build every screen and commit", async () => {
    const payload = await plan();
    assert.equal(payload.mode, "full");
    assert.equal(payload.question, "Build it?");
    assert.equal(payload.developer, undefined, "designers get no technical part");
    assert.deepEqual(
        payload.screens.map((s) => s.name),
        ["Login", "Dashboard"],
        "unknown boards from Claude are dropped"
    );
    assert.ok(readFileSync(join(workspace.metaDir, "plan.md"), "utf8").includes("Login → `/`"));
    const files = new BuildFiles(workspace);
    assert.equal((await files.readStack())?.name, "React + Vite + TypeScript");
    const stackJson = JSON.parse(readFileSync(join(workspace.metaDir, "stack.json"), "utf8"));
    assert.equal(stackJson.dev, "npm run dev -- --host 127.0.0.1 --port {port} --strictPort", "W09 reads a dev string");
    assert.equal(stackJson.portEnv, "PORT");

    const result = await build("designer", { planId: payload.planId });
    assert.equal(result.summary, "Your app is ready.");
    assert.deepEqual(executor.calls, ["npm install", "npm run build"]);

    const log = git("log", "--format=%s");
    assert.match(log, /^penforge\(build\): build Login, Dashboard/);
    assert.equal(git("status", "--porcelain"), "", "everything committed");
    assert.match(readFileSync(join(workspace.appSrcDir, ".gitignore"), "utf8"), /node_modules\//);

    const map = await files.readMap();
    assert.deepEqual(map?.boards[DASHBOARD].files, ["src/screens/Dashboard.module.css", "src/screens/Dashboard.tsx"]);
    assert.equal(map?.boards[LOGIN].route, "/");

    const screenSteps = events.filter((e) => e.kind === "progress" && e.payload.step === "screen");
    assert.deepEqual(
        screenSteps.map((e) => `${e.payload.label}:${e.payload.status}`),
        ["Building Login:running", "Building Login:done", "Building Dashboard:running", "Building Dashboard:done"]
    );
    const navigationPrompt = claude.prompts.find((p) => p.includes('build the screen "Login"'));
    assert.match(navigationPrompt ?? "", /click on "Sign in button" → "Dashboard" \(\/dashboard\)/);
    assert.ok(events.some((e) => e.kind === "result" && e.payload.preview === true));
    assert.ok(!events.some((e) => e.kind === "log"), "designers get no logs");
});

test("incremental build touches only the changed screen's files", async () => {
    await build("designer", { planId: (await plan()).planId });
    const firstCommit = git("rev-parse", "HEAD").trim();

    design.texts[DASHBOARD] = "Welcome back, Ana";
    claude.dashboardAlsoWrites = "src/screens/Login.tsx";
    const payload = await plan();
    assert.equal(payload.mode, "incremental");
    assert.deepEqual(
        payload.screens.map((s) => `${s.name}:${s.status}`),
        ["Login:same", "Dashboard:changed"]
    );
    assert.match(payload.summary, /update Dashboard/);

    const before = claude.prompts.length;
    await build("designer", { planId: payload.planId });
    const turns = claude.prompts.slice(before);
    assert.equal(turns.length, 1, "one Claude turn: the Dashboard update");
    assert.match(turns[0], /update the screen "Dashboard"/);
    assert.match(turns[0], /Do not change these files of other screens[\s\S]*src\/screens\/Login\.tsx/);

    const touched = git("diff", "--name-only", firstCommit, "HEAD").trim().split("\n").sort();
    assert.deepEqual(touched, ["src/screens/Dashboard.tsx"]);
    assert.match(git("log", "-1", "--format=%s"), /^penforge\(build\): update Dashboard/);
    assert.deepEqual(executor.calls.slice(2), ["npm run build"], "no reinstall when dependencies are unchanged");
});

test("nothing changed: plan says so and build-run refuses the plan", async () => {
    await build("designer", { planId: (await plan()).planId });
    const payload = await plan();
    assert.equal(payload.mode, "none");
    assert.deepEqual(
        payload.options.map((o) => o.id),
        ["rebuild", "cancel"]
    );
    await assert.rejects(build("designer", { planId: payload.planId }), /press Build again/);
});

test("developer plan carries stack and routes, and route edits are applied", async () => {
    const payload = await plan("developer");
    assert.equal(payload.developer?.stack.name, "React + Vite + TypeScript");
    assert.deepEqual(
        payload.developer?.routes.map((r) => r.route),
        ["/", "/dashboard"]
    );

    await build("developer", {
        planId: payload.planId,
        overrides: { routes: { [DASHBOARD]: "/home" }, notes: "Use CSS modules." },
    });
    const scaffold = claude.prompts.find((p) => p.startsWith("## Step: scaffold")) ?? "";
    assert.match(scaffold, /"Dashboard" \(board board-dashboard\) → \/home/);
    assert.match(scaffold, /Instructions from the developer[\s\S]*Use CSS modules\./);
    assert.equal((await new BuildFiles(workspace).readMap())?.boards[DASHBOARD].route, "/home");
});

test("a failing build is fixed by Claude without telling the designer", async () => {
    executor.buildFailures = 1;
    await build("designer", { planId: (await plan()).planId });
    const fix = claude.prompts.find((p) => p.startsWith("## Step: fix"));
    assert.match(fix ?? "", /error TS2307/);
    assert.deepEqual(executor.calls, ["npm install", "npm run build", "npm run build"]);
    assert.ok(!events.some((e) => e.kind === "log"));
});

test("giving up: designers get a plain message, developers the error", async () => {
    executor.buildFailures = 10;
    await assert.rejects(build("designer", { planId: (await plan()).planId }), (error: Error) => {
        assert.doesNotMatch(error.message, /TS2307|npm/);
        return true;
    });

    executor.buildFailures = 10;
    await assert.rejects(
        build("developer", { planId: (await plan("developer")).planId }),
        /npm run build[\s\S]*TS2307/
    );
    assert.ok(events.some((e) => e.kind === "log" && /TS2307/.test(e.payload.text)));
});

test("pre-build workflows run before the screens", async () => {
    const payload = await plan();
    const files = new BuildFiles(workspace);
    const stack = (await files.readStack())!;
    const saved = (await files.readPlan())!;
    await files.writePlan({ ...saved, stack: { ...stack, preBuild: ["token-sync", "missing"] } }, "plan");
    const ran: string[] = [];
    await build(
        "developer",
        { planId: payload.planId },
        {
            run: async (id) => {
                ran.push(id);
                return id === "token-sync";
            },
        }
    );
    assert.deepEqual(ran, ["token-sync", "missing"]);
    assert.ok(events.some((e) => e.kind === "log" && /"missing" is not installed/.test(e.payload.text)));
});

test("a plan of another file or an unknown plan id is refused", async () => {
    await plan();
    await assert.rejects(build("designer", { planId: "other" }), /press Build again/);
});

test("JsonReply takes the last valid fenced block", () => {
    const schema = CommandSchema;
    const text = 'first ```json\n["npm","install"]\n``` then ```json\n["npm","run","build"]\n```';
    assert.deepEqual(JsonReply.parse(text, schema), ["npm", "run", "build"]);
    assert.equal(JsonReply.parse("no json here", schema), null);
});

test("stack commands reject shells and other programs", () => {
    assert.equal(CommandSchema.safeParse(["npm", "run", "build"]).success, true);
    assert.equal(CommandSchema.safeParse(["rm", "-rf", "/"]).success, false);
    assert.equal(CommandSchema.safeParse(["npm", "install;", "rm"]).success, false);
    assert.equal(CommandSchema.safeParse(["npm", "run", "a && b"]).success, false);
});

test("ProcessCommandExecutor refuses unsafe commands without starting them", async () => {
    await assert.rejects(
        new ProcessCommandExecutor().execute(["node", "-e", "1"], { cwd: home, timeoutMs: 1000 }),
        /Refusing to run/
    );
});

test("Routes are unique and URL-safe", () => {
    const routes = new Routes(["/login"]);
    assert.equal(routes.claim("/login", "Login"), "/login-2");
    assert.equal(routes.claim("not a route", "Order Details"), "/order-details");
    assert.equal(routes.next("Ödeme Ekranı"), "/odeme-ekrani");
    assert.equal(routes.next("***"), "/screen");
});

test("the build-run workflow reports persona-safe failures as a failed event", async () => {
    const { workflow } = await import("../workflows/build-run");
    events = [];
    await assert.rejects(workflow.run(context("designer"), { planId: "missing" }));
    const failed = events.find((e) => e.kind === "failed");
    assert.match(failed?.payload.message ?? "", /press Build again/);
    assert.equal(failed?.payload.code, "stale-plan");
});

test("asking build-plan: the answer ends the run with result {confirmed}", async () => {
    events = [];
    await new BuildPlanner(context("developer", ["cancel"])).plan({});
    const question = events.find((e) => e.kind === "question");
    assert.match(question?.payload.text ?? "", /\*\*Stack:\*\* React \+ Vite[\s\S]*Dashboard → `\/dashboard`/);
    assert.deepEqual(events.find((e) => e.kind === "result")?.payload.confirmed, false);

    events = [];
    await new BuildPlanner(context("designer", ["build"])).plan({});
    assert.equal(events.find((e) => e.kind === "result")?.payload.confirmed, true);
    await build("designer", {});
    assert.match(git("log", "-1", "--format=%s"), /^penforge\(build\): build Login, Dashboard/);

    events = [];
    await new BuildPlanner(context("designer", ["rebuild", "build"])).plan({});
    const plans = events.filter((e) => e.kind === "plan").map((e) => e.payload.mode);
    assert.deepEqual(plans, ["none", "full"], "rebuild re-plans from scratch");
    assert.equal(events.filter((e) => e.kind === "result").at(-1)?.payload.confirmed, true);
});

test("stack commands keep dev servers on loopback and refuse fetch-and-run", () => {
    const refused = [
        ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
        ["npm", "run", "dev", "--", "--host=0.0.0.0"],
        ["npm", "run", "dev", "--", "--host"],
        ["npm", "run", "dev", "--", "--host", "--port", "5200"],
        ["npm", "run", "dev", "--", "--host", "192.168.1.20"],
        ["npx", "next", "dev", "-H", "::"],
        ["npm", "run", "dev", "--", "%PATH%"],
        ["npm", "install", "react@^19"],
        ["npx", "cowsay"],
        ["npx", "--yes", "vite"],
        ["pnpm", "dlx", "create-vite"],
        ["npm", "exec", "anything"],
        ["bun", "x", "anything"],
    ];
    for (const argv of refused) {
        assert.notEqual(StackCommand.problem(argv), null, argv.join(" "));
    }
    const accepted = [
        ["npx", "vite", "--host", "127.0.0.1", "--port", "{port}"],
        ["npm", "run", "dev", "--", "--host=localhost", "--port", "{port}", "--strictPort"],
        ["npx", "expo", "start", "--web", "--port", "{port}"],
        ["pnpm", "install"],
    ];
    for (const argv of accepted) {
        assert.equal(StackCommand.problem(argv), null, argv.join(" "));
    }
});

test("child processes get a scrubbed environment", () => {
    const env = ChildEnvironment.scrub(
        {
            Path: "C:\Windows",
            SystemRoot: "C:\Windows",
            HOME: "/home/a",
            npm_config_cache: "/tmp/npm",
            npm_config__authToken: "x",
            PENFORGE_TOKEN: "x",
            ANTHROPIC_API_KEY: "x",
            CLAUDE_CODE_OAUTH_TOKEN: "x",
            GITHUB_TOKEN: "x",
            AWS_SECRET_ACCESS_KEY: "x",
            CLAUDE_CONFIG_DIR: "x",
        },
        { CI: "1" }
    );
    assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "Path", "SystemRoot", "npm_config_cache"]);
});

test("a plan while a build holds the project lock fails fast", async () => {
    const release = BuildLock.tryAcquire(workspace.root)!;
    try {
        const { workflow } = await import("../workflows/build-plan");
        events = [];
        await assert.rejects(workflow.run(context("designer"), { ask: false }), /already being built/);
        assert.equal(events.find((e) => e.kind === "failed")?.payload.code, "busy");
    } finally {
        release();
    }
    await plan();
});

test("non-ASCII screen file names are mapped", async () => {
    design.boards[0].name = "Giriş";
    await build("designer", { planId: (await plan()).planId });
    const map = await new BuildFiles(workspace).readMap();
    assert.ok(map?.boards[LOGIN].files.includes("src/screens/Giriş.tsx"), JSON.stringify(map?.boards[LOGIN]));
});
