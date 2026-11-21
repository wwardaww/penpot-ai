import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { AppBuilder, type PreBuildRunner } from "../build/AppBuilder";
import { BuildPlanner } from "../build/BuildPlanner";
import type { CommandExecutor, CommandOptions, CommandOutcome } from "../build/CommandExecutor";
import { workflow as buildChanges } from "../workflows/build-changes";
import { BuildInstructions } from "./BuildInstructions";
import { BuildRecords } from "./BuildRecords";
import { ChangeDetector } from "./ChangeDetector";
import { ChangeRequests } from "./ChangeRequests";
import type { ChangeSet } from "./ChangeSet";
import type { DesignState, LayerState } from "./DesignState";
import { DesignStateReader } from "./DesignStateReader";

// fixed snapshots -----------------------------------------------------------------------------

function layer(name: string, type: string, parentId: string | null, extra: Partial<LayerState> = {}): LayerState {
    return {
        name,
        type,
        parentId,
        visible: true,
        text: null,
        typography: "",
        fills: "",
        strokes: "",
        images: "",
        layout: "",
        size: "100x40",
        component: "",
        animation: "",
        ...extra,
    };
}

function baseState(): DesignState {
    return {
        schemaVersion: 1,
        fileId: "file-1",
        revn: 10,
        readAt: "2026-11-20T10:00:00.000Z",
        boards: {
            login: {
                name: "Login",
                pageName: "Page 1",
                size: "390x844",
                truncated: false,
                layers: {
                    login: layer("Login", "board", null, {
                        size: "390x844",
                        layout: "flex|column|16|0|24 24 24 24|center|start|",
                    }),
                    title: layer("Title", "text", "login", {
                        text: "Sign in",
                        typography: "Inter 24 700 normal",
                        fills: "#111111",
                    }),
                    button: layer("Button", "rect", "login", { fills: "token:color.primary" }),
                    logo: layer("Logo", "rect", "login", { images: "img-1", fills: "image" }),
                    card: layer("Card", "board", "login", { component: "Cards/Card" }),
                    fade: layer("Hero", "rect", "login", { animation: "12:abc" }),
                },
            },
            dashboard: {
                name: "Dashboard",
                pageName: "Page 1",
                size: "390x844",
                truncated: false,
                layers: {
                    dashboard: layer("Dashboard", "board", null, { size: "390x844" }),
                    welcome: layer("Welcome", "text", "dashboard", { text: "Welcome back" }),
                },
            },
            settings: {
                name: "Settings",
                pageName: "Page 1",
                size: "390x844",
                truncated: false,
                layers: { settings: layer("Settings", "board", null, { size: "390x844" }) },
            },
        },
        tokens: { "color.primary": "#6c5ce7", "spacing.md": "16" },
        edges: [{ from: "login", to: "dashboard", trigger: "click", sourceName: "Button" }],
        flows: { Main: "login" },
        libraries: [{ id: "lib-1", name: "Brand UI" }],
    };
}

test("detector: no change gives an empty set", () => {
    const changes = new ChangeDetector().compare(baseState(), baseState());
    assert.equal(changes.count, 0);
    assert.equal(changes.tokenOnly, false);
    assert.deepEqual(changes.screens, []);
});

test("detector: concrete changes per screen, tokens, flows and design system", () => {
    const before = baseState();
    const after = baseState();
    const login = after.boards.login.layers;
    login.title = { ...login.title, text: "Log in", size: "120x40" };
    login.button = { ...login.button, strokes: "#000000/1/solid" };
    login.logo = { ...login.logo, images: "img-2" };
    login.card = { ...login.card, component: "Cards/Card wide", visible: false };
    login.fade = { ...login.fade, animation: "" };
    login.login = { ...login.login, layout: "flex|column|24|0|24 24 24 24|center|start|" };
    // a new group with a child: only the group is listed
    login.group = layer("Footer", "group", "login");
    login.groupChild = layer("Copyright", "text", "group", { text: "©" });
    // a removed layer and a renamed one on Dashboard
    delete after.boards.dashboard.layers.welcome;
    after.boards.dashboard.layers.dashboard = { ...after.boards.dashboard.layers.dashboard, name: "Home" };
    after.boards.dashboard.name = "Home";
    // Settings removed, Profile added
    delete after.boards.settings;
    after.boards.profile = {
        name: "Profile",
        pageName: "Page 1",
        size: "390x844",
        truncated: false,
        layers: { profile: layer("Profile", "board", null) },
    };
    after.edges = [{ from: "login", to: "profile", trigger: "click", sourceName: "Button" }];
    after.tokens = { "color.primary": "#ff0000", "radius.card": "24" };
    after.flows = { Main: "profile", Onboarding: "login" };
    after.libraries = [{ id: "lib-2", name: "Material" }];

    const changes = new ChangeDetector().compare(before, after);
    const byName = new Map(changes.screens.map((screen) => [screen.name, screen]));
    const loginCodes = byName.get("Login")!.items.map((item) => item.code);
    assert.deepEqual(loginCodes.sort(), [
        "animation-changed",
        "component-swapped",
        "image-changed",
        "layer-added",
        "layout-changed",
        "navigation-added",
        "navigation-removed",
        "stroke-changed",
        "text-changed",
        "visibility-changed",
    ]);
    const text = byName.get("Login")!.items.find((item) => item.code === "text-changed")!;
    assert.deepEqual(text.params, { layer: "Title", before: "Sign in", after: "Log in" });
    assert.equal(text.text, 'Text of "Title" changed from "Sign in" to "Log in"');
    assert.ok(!loginCodes.includes("size-changed"), "a text box resized by its new text is no extra change");
    assert.equal(byName.get("Login")!.items.find((i) => i.code === "layer-added")!.params.layer, "Footer");

    const home = byName.get("Home")!;
    assert.equal(home.status, "changed");
    assert.equal(home.previousName, "Dashboard");
    assert.deepEqual(home.items.map((item) => item.code).sort(), ["layer-removed", "layer-renamed"]);
    assert.equal(byName.get("Settings")!.status, "removed");
    assert.equal(byName.get("Profile")!.status, "added");

    assert.deepEqual(
        changes.tokens.map((item) => `${item.code}:${item.params.name}`),
        ["token-changed:color.primary", "token-added:radius.card", "token-removed:spacing.md"]
    );
    assert.deepEqual(
        changes.flows.map((item) => item.code),
        ["flow-start-changed", "flow-added"]
    );
    assert.equal(changes.designSystem?.code, "design-system-changed");
    assert.equal(changes.designSystem?.params.after, "Material");
    assert.equal(changes.count, 4 + 3 + 2 + 1);
    assert.equal(changes.tokenOnly, false);
});

test("detector: a token value change is no layer change, and token-only sets say so", () => {
    const after = baseState();
    after.tokens["color.primary"] = "#00ff00";
    const changes = new ChangeDetector().compare(baseState(), after);
    assert.deepEqual(changes.screens, [], "the button bound to the token is not listed");
    assert.equal(changes.count, 1);
    assert.equal(changes.tokenOnly, true);
});

test("detector: a rename alone, and long lists are cut", () => {
    const after = baseState();
    after.boards.settings.name = "Preferences";
    for (let i = 0; i < 40; i++) {
        after.boards.dashboard.layers[`l${i}`] = layer(`Row ${i}`, "rect", "dashboard");
    }
    const changes = new ChangeDetector().compare(baseState(), after);
    const settings = changes.screens.find((s) => s.boardId === "settings")!;
    assert.equal(settings.status, "renamed");
    assert.equal(settings.previousName, "Settings");
    const dashboard = changes.screens.find((s) => s.boardId === "dashboard")!;
    assert.equal(dashboard.items.length, ChangeDetector.MAX_ITEMS_PER_SCREEN);
    assert.equal(dashboard.more, 40 - ChangeDetector.MAX_ITEMS_PER_SCREEN);
    assert.match(ChangeRequests.screenLines(dashboard).at(-1)!, /and 10 more changes/);
});

// fake Penpot -------------------------------------------------------------------------------

const LOGIN = "board-login";
const DASHBOARD = "board-dashboard";

interface FakeShape {
    id: string;
    name: string;
    type: string;
    width: number;
    height: number;
    hidden?: boolean;
    characters?: string;
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    fills?: unknown[];
    strokes?: unknown[];
    tokens?: Record<string, string>;
    children?: FakeShape[];
    plugin?: Record<string, string>;
    getSharedPluginData?: (namespace: string, key: string) => string;
}

/** Penpot file model the plugin scripts run against, plus the typed tools the build uses. */
class FakePenpot {
    public revn = 1;
    public readonly texts: Record<string, string> = { [LOGIN]: "Sign in", [DASHBOARD]: "Welcome back" };
    public tokens: Record<string, string> = { "color.primary": "#6c5ce7" };
    public versions: string[] = [];
    public calls: string[] = [];

    public call(tool: string, args: Record<string, unknown> = {}): Promise<WorkflowToolResult> | WorkflowToolResult {
        this.calls.push(tool);
        const ok = (value: unknown) => ({ isError: false, content: [], text: JSON.stringify(value) });
        switch (tool) {
            case "list_boards":
                return ok(
                    this.boards().map((b) => ({
                        id: b.id,
                        name: b.name,
                        pageId: "page-1",
                        pageName: "Page 1",
                        width: 390,
                        height: 844,
                    }))
                );
            case "get_prototype_graph":
                return ok({
                    flows: [{ name: "Main", pageId: "page-1", startingBoardId: LOGIN }],
                    edges: [{ from: LOGIN, to: DASHBOARD, trigger: "click", sourceName: "Sign in button" }],
                });
            case "generate_code_hints":
                return ok({ nodeId: args.nodeId, html: `<div>${this.texts[String(args.nodeId)]}</div>` });
            case "execute_code":
                return this.execute(String(args.code));
            default:
                return { isError: true, content: [], text: `unknown tool ${tool}` };
        }
    }

    private async execute(code: string): Promise<WorkflowToolResult> {
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
            ...names: string[]
        ) => (...values: unknown[]) => Promise<unknown>;
        try {
            const result = await new AsyncFunction("penpot", code)(this.api());
            // the plugin's envelope; the design state script is slow here, so a note follows
            const text = JSON.stringify({ result, log: [] }, null, 2);
            const slow = code.startsWith("const MAX =") ? "\n\nNOTE: this call kept the Penpot tab frozen for 6 s" : "";
            return { isError: false, content: [], text: text + slow };
        } catch (error) {
            return { isError: true, content: [], text: String(error) };
        }
    }

    private api(): unknown {
        const sets = [
            {
                name: "Theme",
                active: true,
                tokens: Object.entries(this.tokens).map(([name, value]) => ({
                    name,
                    type: "color",
                    value,
                    resolvedValue: value,
                    description: "",
                })),
            },
        ];
        const fake = this;
        return {
            currentFile: {
                id: "file-1",
                name: "Chess",
                revn: this.revn,
                pages: [{ id: "page-1", name: "Page 1", root: { children: this.boards() }, flows: [] }],
                async saveVersion(label: string) {
                    fake.versions.push(label);
                    return { label, createdAt: new Date("2026-11-21T10:00:00Z") };
                },
            },
            library: { local: { tokens: { themes: [], sets } }, connected: [] },
        };
    }

    public boards(): FakeShape[] {
        const board = (id: string, name: string, textId: string): FakeShape => ({
            id,
            name,
            type: "board",
            width: 390,
            height: 844,
            fills: [{ fillColor: "#ffffff" }],
            children: [
                {
                    id: textId,
                    name: "Title",
                    type: "text",
                    width: 200,
                    height: 30,
                    characters: this.texts[id],
                    fontFamily: "Inter",
                    fontSize: "24",
                    fontWeight: "700",
                    fills: [{ fillColor: "#111111" }],
                },
                {
                    id: `${id}-button`,
                    name: "Button",
                    type: "rect",
                    width: 120,
                    height: 40,
                    fills: [{ fillColor: this.tokens["color.primary"] }],
                    tokens: { fill: "color.primary" },
                    getSharedPluginData: (namespace, key) =>
                        namespace === "penforge" && key === "animations" ? '{"version":1}' : "",
                },
            ],
        });
        return [board(LOGIN, "Login", "login-title"), board(DASHBOARD, "Dashboard", "dashboard-title")];
    }
}

test("state reader: the plugin script reads layers, token bindings, animations and revn", async () => {
    const penpot = new FakePenpot();
    penpot.revn = 42;
    const state = await new DesignStateReader({
        call: async (tool, args) => penpot.call(tool, args),
        list: async () => [],
    }).read("file-1");
    assert.equal(state.revn, 42);
    assert.deepEqual(Object.keys(state.boards), [LOGIN, DASHBOARD]);
    const layers = state.boards[LOGIN].layers;
    assert.equal(layers["login-title"].text, "Sign in");
    assert.equal(layers["login-title"].typography, "Inter 24 700 ");
    assert.equal(layers["login-title"].parentId, LOGIN);
    assert.equal(layers[`${LOGIN}-button`].fills, "token:color.primary");
    assert.match(layers[`${LOGIN}-button`].animation, /^13:[0-9a-f]+$/);
    assert.equal(state.tokens["color.primary"], "#6c5ce7");
    assert.deepEqual(state.flows, { Main: LOGIN });
});

// instructions and change request files ---------------------------------------------------

let home: string;
let workspace: ProjectWorkspace;

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-changes-"));
    workspace = new ProjectWorkspace(join(home, "projects"), "project-1");
    await workspace.ensure();
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

test("instructions: keep, edit and remove the kept ones", async () => {
    const store = new BuildInstructions(workspace);
    const first = await store.apply({ text: "Play a piece sound on every move", keep: true });
    assert.equal(first.kept, "- Play a piece sound on every move");
    assert.equal(await store.readKept(), "- Play a piece sound on every move");
    assert.equal(BuildInstructions.record(first), "Play a piece sound on every move");

    const second = await store.apply({ text: "Use a dark board" });
    assert.equal(second.text, "Use a dark board");
    assert.equal(second.kept, "- Play a piece sound on every move", "a one-time text is not kept");
    const section = BuildInstructions.promptSection(second);
    assert.match(section, /For this build:\nUse a dark board/);
    assert.match(section, /Kept from earlier builds:\n- Play a piece sound on every move/);
    assert.match(section, /never override the design system or the prototype flows/);

    const edited = await store.apply({ kept: "- Save games locally\u0007" });
    assert.equal(edited.kept, "- Save games locally");
    await store.apply({ kept: "" });
    assert.equal(await store.readKept(), "");
    assert.ok(!existsSync(join(workspace.metaDir, "instructions.md")));
    assert.equal(BuildInstructions.promptSection({ text: "", kept: "" }), "");
});

test("change request files: numbered, grouped by screen, with instructions", async () => {
    const after = baseState();
    after.boards.login.layers.title = { ...after.boards.login.layers.title, text: "Log in" };
    after.tokens["color.primary"] = "#ff0000";
    const changes: ChangeSet = new ChangeDetector().compare(baseState(), after);
    const requests = new ChangeRequests(workspace);
    const one = await requests.create("file-1", 1, changes, { text: "Save games locally", kept: "- Play a sound" });
    const two = await requests.create("file-1", 1, changes, { text: "", kept: "" });
    assert.equal(one.id, "CR-1");
    assert.equal(two.id, "CR-2");
    const markdown = readFileSync(join(workspace.metaDir, "changes", "CR-1.md"), "utf8");
    assert.match(markdown, /^# Change request CR-1\n/);
    assert.match(
        markdown,
        /## Screens\n\n### Login \(changed\)\n\n- Text of "Title" changed from "Sign in" to "Log in"/
    );
    assert.match(markdown, /## Design tokens\n\n- Token "color.primary" changed from #6c5ce7 to #ff0000/);
    assert.match(
        markdown,
        /## Instructions for the AI\n\nNew with this update:\n\nSave games locally\n\nKept for every build:\n\n- Play a sound/
    );
    await requests.markBuilt(one, 2);
    assert.equal((await requests.read("CR-1"))?.builtAs, 2);
    assert.equal(await requests.read("../builds"), null);
});

// end to end with the fake runner ---------------------------------------------------------

/** Scripted Claude writing files into app-src. */
class FakeClaude {
    public readonly prompts: string[] = [];
    public conflictOnce = false;
    private turn = 0;

    constructor(private readonly appSrc: string) {}

    public async run(request: WorkflowClaudeRequest): Promise<WorkflowClaudeResult> {
        this.prompts.push(request.prompt);
        const sessionId = request.resumeSessionId ?? `session-${++this.turn}`;
        const prompt = request.prompt;
        const json = (value: unknown) => ({ sessionId, text: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` });
        if (prompt.startsWith("Plan the app")) {
            return json({
                summary: "Login leads to the Dashboard.",
                stack: FakeClaude.stack(),
                screens: [
                    { boardId: LOGIN, route: "/" },
                    { boardId: DASHBOARD, route: "/dashboard" },
                ],
            });
        }
        if (prompt.startsWith("## Step: scaffold")) {
            this.write("package.json", '{ "name": "chess" }\n');
            this.write("src/App.tsx", "routes\n");
            return json({ stack: FakeClaude.stack() });
        }
        if (prompt.startsWith("## Step: apply the change request")) {
            this.write("src/sound.ts", "export const playMove = () => {};\n");
            const conflicts = this.conflictOnce ? ["Use red buttons everywhere"] : [];
            this.conflictOnce = false;
            return json({
                files: ["src/sound.ts"],
                conflicts,
                assets: [{ file: "src/sound.ts", source: "generated with the Web Audio API", license: "none needed" }],
            });
        }
        if (prompt.startsWith("## Step: follow the instructions")) {
            this.write("src/buttons.css", ".button { background: red; }\n");
            return json({ files: ["src/buttons.css"] });
        }
        const screen = /## Step: (?:build|update) the screen "([^"]+)"/.exec(prompt)?.[1];
        if (screen) {
            const file = `src/screens/${screen}.tsx`;
            this.write(file, `${screen} ${this.turn}-${this.prompts.length}\n`);
            return json({ files: [file] });
        }
        return { sessionId, text: "ok" };
    }

    private write(file: string, content: string): void {
        const path = join(this.appSrc, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }

    public static stack() {
        return {
            name: "React + Vite",
            packageManager: "npm",
            commands: { install: ["npm", "install"], build: ["npm", "run", "build"], dev: ["npm", "run", "dev"] },
        };
    }
}

class FakeExecutor implements CommandExecutor {
    public readonly calls: string[] = [];

    public async execute(argv: string[], options: CommandOptions): Promise<CommandOutcome> {
        this.calls.push(argv.join(" "));
        if (argv.includes("install")) {
            mkdirSync(join(options.cwd, "node_modules"), { recursive: true });
        }
        return { code: 0, output: "ok", timedOut: false };
    }
}

class RecordingPreBuild implements PreBuildRunner {
    public readonly runs: string[] = [];

    public async run(workflowId: string): Promise<boolean> {
        this.runs.push(workflowId);
        return true;
    }
}

interface Emitted {
    kind: string;
    payload: any;
}

function context(
    penpot: FakePenpot,
    claude: FakeClaude,
    events: Emitted[],
    answers: string[] = [],
    persona: Persona = "designer"
): WorkflowContext {
    return {
        runId: "run-1",
        context: {
            fileId: "file-1",
            fileName: "Chess",
            projectId: "project-1",
            teamId: "team-1",
            pageId: "page-1",
            persona,
            platform: "web",
        },
        runner: { run: (request) => claude.run(request) },
        tools: { call: async (tool, args) => penpot.call(tool, args), list: async () => [] },
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

test("e2e: build, change two boards and a token, Update lists 3 items and builds CR-1", async () => {
    const penpot = new FakePenpot();
    const claude = new FakeClaude(workspace.appSrcDir);
    const executor = new FakeExecutor();
    const preBuild = new RecordingPreBuild();
    let events: Emitted[] = [];
    const ctx = () => context(penpot, claude, events);
    const builder = () => new AppBuilder(ctx(), { executor, preBuild });
    const changes = async () => {
        events = [];
        await buildChanges.run(ctx(), {});
        return events.find((e) => e.kind === "result")!.payload;
    };

    // before the first build: Build, no Penpot read
    penpot.calls = [];
    const none = await changes();
    assert.equal(none.hasBuild, false);
    assert.deepEqual(penpot.calls, [], "no design read without a build");

    // first build with a kept instruction → checkpoint "build 1"
    await new BuildPlanner(ctx()).plan({ ask: false });
    events = [];
    await builder().build({ instructions: { text: "Play a piece sound on every move", keep: true } });
    const records = new BuildRecords(workspace);
    const first = await records.last();
    assert.equal(first?.n, 1);
    assert.equal(first?.label, "build 1");
    assert.equal(first?.mode, "full");
    assert.equal(first?.revn, 1);
    assert.equal(first?.checkpointId, "cp-1");
    assert.equal(first?.fileVersion?.label, "AI checkpoint #1 · build 1");
    assert.equal(first?.instructions, "Play a piece sound on every move");
    assert.ok(first?.tokensHash && first.prototypeHash && first.animationsHash && first.designSystemHash);
    assert.ok(first?.appSha && first.designSha);
    assert.deepEqual(Object.keys(first!.boardHashes).sort(), [DASHBOARD, LOGIN]);
    assert.ok(existsSync(join(workspace.metaDir, "builds", "build-1.json")));
    const checkpoints = JSON.parse(readFileSync(join(workspace.metaDir, "checkpoints.json"), "utf8"));
    assert.equal(checkpoints.checkpoints[0].label, "build 1");
    const scaffold = claude.prompts.find((p) => p.startsWith("## Step: scaffold"))!;
    assert.match(
        scaffold,
        /## Instructions for the AI \(from the user\)\n\nFor this build:\nPlay a piece sound on every move/
    );

    // nothing changed: Up to date, from the revision alone
    penpot.calls = [];
    const upToDate = await changes();
    assert.deepEqual(penpot.calls, ["execute_code"], "same revn: the design is not read");
    assert.equal(upToDate.hasBuild, true);
    assert.equal(upToDate.count, 0);
    assert.equal(upToDate.lastBuild.label, "build 1");
    assert.equal(upToDate.keptInstructions, "- Play a piece sound on every move");

    // no change → no Claude turn
    let before = claude.prompts.length;
    events = [];
    const idle = await builder().build({ update: {} });
    assert.equal(claude.prompts.length, before, "no Claude turn");
    assert.equal(events.find((e) => e.kind === "result")!.payload.mode, "none");
    assert.match(idle.summary, /already matches the design/);

    // edit two boards and one token
    penpot.texts[LOGIN] = "Log in";
    penpot.texts[DASHBOARD] = "Welcome back, Ana";
    penpot.tokens["color.primary"] = "#e17055";
    penpot.revn = 2;
    const listed = await changes();
    assert.equal(listed.count, 3);
    assert.deepEqual(
        listed.changes.screens.map((s: any) => `${s.name}:${s.items.map((i: any) => i.code).join(",")}`),
        ["Login:text-changed", "Dashboard:text-changed"]
    );
    assert.deepEqual(
        listed.changes.tokens.map((t: any) => t.code),
        ["token-changed"]
    );

    before = claude.prompts.length;
    const appBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.appSrcDir, encoding: "utf8" }).trim();
    events = [];
    await builder().build({ update: {} });
    const result = events.find((e) => e.kind === "result")!.payload;
    assert.equal(result.changeRequest, "CR-1");
    assert.equal(result.build, 2);
    assert.equal(result.tokenOnly, false);
    const turns = claude.prompts.slice(before);
    assert.equal(turns.length, 2, "one turn per changed screen, no app-wide turn");
    assert.match(turns[0], /update the screen "Login"/);
    assert.match(
        turns[0],
        /What changed on this screen since the last build \(change request CR-1\)[^\n]*\n- Text of "Title" changed from "Sign in" to "Log in"/
    );
    assert.match(turns[0], /Kept from earlier builds:\n- Play a piece sound on every move/);
    assert.ok(preBuild.runs.includes("token-sync"), "the theme follows the token through token-sync");
    const markdown = readFileSync(join(workspace.metaDir, "changes", "CR-1.md"), "utf8");
    assert.match(markdown, /Changes since build 1/);
    assert.match(markdown, /### Login \(changed\)\n\n- Text of "Title" changed from "Sign in" to "Log in"/);
    assert.match(
        markdown,
        /### Dashboard \(changed\)\n\n- Text of "Title" changed from "Welcome back" to "Welcome back, Ana"/
    );
    assert.match(markdown, /## Design tokens\n\n- Token "color.primary" changed from #6c5ce7 to #e17055/);
    const touched = execFileSync("git", ["diff", "--name-only", appBefore, "HEAD"], {
        cwd: workspace.appSrcDir,
        encoding: "utf8",
    })
        .trim()
        .split("\n")
        .sort();
    assert.deepEqual(touched, ["src/screens/Dashboard.tsx", "src/screens/Login.tsx"]);
    const second = await records.last();
    assert.equal(second?.label, "build 2");
    assert.equal(second?.changeRequest, "CR-1");
    assert.equal(second?.revn, 2);
    assert.equal(JSON.parse(readFileSync(join(workspace.metaDir, "changes", "CR-1.json"), "utf8")).builtAs, 2);
    assert.equal((await changes()).count, 0, "up to date after the update");

    // token-only change: no Claude turn, token-sync only
    penpot.tokens["color.primary"] = "#00b894";
    penpot.revn = 3;
    before = claude.prompts.length;
    preBuild.runs.length = 0;
    events = [];
    await builder().build({ update: {} });
    assert.equal(claude.prompts.length, before, "token-only updates run no Claude turn");
    assert.deepEqual(preBuild.runs, ["token-sync"]);
    const tokenResult = events.find((e) => e.kind === "result")!.payload;
    assert.equal(tokenResult.tokenOnly, true);
    assert.equal((await records.last())?.mode, "tokens");

    // instructions only, with a conflict the user wants followed
    claude.conflictOnce = true;
    before = claude.prompts.length;
    events = [];
    await new AppBuilder(context(penpot, claude, events, ["instruction"]), { executor, preBuild }).build({
        update: { text: "Save games locally", keep: true },
    });
    const update = claude.prompts.slice(before);
    assert.equal(update.length, 2, "app-wide turn and the follow-up for the conflict");
    assert.match(update[0], /^## Step: apply the change request CR-3/);
    assert.match(update[0], /For this build:\nSave games locally/);
    assert.match(update[0], /Kept from earlier builds:\n- Play a piece sound on every move/);
    assert.match(update[1], /Use red buttons everywhere/);
    const question = events.find((e) => e.kind === "question")!.payload;
    assert.deepEqual(
        question.options.map((o: any) => o.id),
        ["design", "instruction"]
    );
    const instructionResult = events.find((e) => e.kind === "result")!.payload;
    assert.deepEqual(instructionResult.assets, [
        { file: "src/sound.ts", source: "generated with the Web Audio API", license: "none needed" },
    ]);
    assert.equal(
        readFileSync(join(workspace.metaDir, "instructions.md"), "utf8"),
        "- Play a piece sound on every move\n- Save games locally\n"
    );
    assert.match(
        readFileSync(join(workspace.metaDir, "changes", "CR-3.md"), "utf8"),
        /New with this update:\n\nSave games locally/
    );
});

test("e2e: a build made before change requests is compared by board hashes", async () => {
    const penpot = new FakePenpot();
    const claude = new FakeClaude(workspace.appSrcDir);
    const events: Emitted[] = [];
    await new BuildPlanner(context(penpot, claude, events)).plan({ ask: false });
    await new AppBuilder(context(penpot, claude, events), { executor: new FakeExecutor() }).build({});
    rmSync(join(workspace.metaDir, "builds.json"));
    penpot.texts[DASHBOARD] = "Hello";
    events.length = 0;
    await buildChanges.run(context(penpot, claude, events), {});
    const result = events.find((e) => e.kind === "result")!.payload;
    assert.equal(result.lastBuild, null);
    assert.equal(result.changes.baseline, "hashes");
    assert.deepEqual(
        result.changes.screens.map((s: any) => `${s.name}:${s.items[0]?.code}`),
        ["Dashboard:design-changed"]
    );
});
