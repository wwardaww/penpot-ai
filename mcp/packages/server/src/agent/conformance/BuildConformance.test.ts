import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
    WorkflowClaudeRequest,
    WorkflowClaudeResult,
    WorkflowContext,
    WorkflowToolResult,
} from "@penpot/mcp-common";
import { AppBuilder } from "../build/AppBuilder";
import { BuildFiles } from "../build/BuildFiles";
import { BuildPlanner } from "../build/BuildPlanner";
import type { CommandExecutor, CommandOptions } from "../build/CommandExecutor";
import { DesignTokens } from "../tokens/DesignTokens";
import { TokenManifest, type TokenManifestData } from "../tokens/TokenManifest";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { AppSources } from "./AppSources";
import { CodeNames } from "./CodeNames";
import { type CheckInput, ConformanceChecker } from "./ConformanceChecker";
import { ConformanceReports } from "./ConformanceReport";
import { ContractPrompt } from "./ContractPrompt";
import { type DesignContract, DesignContractReader } from "./DesignContract";
import { DesignValueLint } from "./DesignValueLint";
import { MotionCode, type NamedMotion } from "./MotionCode";
import { MotionEasing } from "./MotionEasing";
import { MotionFile } from "./MotionFile";
import { MotionModel } from "./MotionModel";
import { PrototypeLinks } from "./PrototypeLinks";

// the to-do sample: Tasks → "+" → Add task → back; a menu overlay; two animations -------------

const TASKS = "board-tasks";
const ADD = "board-add";
const MENU = "board-menu";

const FADE_STAGGER = {
    v: 1,
    entrance: {
        effects: [{ type: "fade" }, { type: "slide", direction: "up", distance: 24 }],
        duration: 300,
        delay: 100,
        easing: "ease-out",
        stagger: { each: 80 },
    },
};
const SPRING_PRESS = {
    v: 1,
    states: { press: { scale: 0.95, duration: 120, easing: { type: "spring", stiffness: 300, damping: 20 } } },
};

/** Design of the to-do sample, answering the build's tool calls. */
class TodoDesign {
    public hashes: Record<string, string> = { [TASKS]: "1", [ADD]: "1", [MENU]: "1" };
    public cardAnimation: Record<string, unknown> = FADE_STAGGER;

    public call(tool: string, args: Record<string, unknown> = {}): WorkflowToolResult {
        const ok = (value: unknown) => ({ isError: false, content: [], text: JSON.stringify(value) });
        switch (tool) {
            case "list_boards":
                return ok(this.boards());
            case "get_prototype_graph":
                return ok({
                    flows: [{ name: "Main", startingBoardId: TASKS }],
                    edges: [
                        { from: TASKS, to: ADD, type: "navigate-to", trigger: "click", sourceName: "Plus" },
                        { from: TASKS, to: MENU, type: "open-overlay", trigger: "click", sourceName: "Burger" },
                    ],
                });
            case "generate_code_hints":
                return ok({ html: this.hashes[String(args.nodeId)] });
            case "get_animation_spec":
                return ok({
                    version: 1,
                    fileId: "file-1",
                    pages: [{ pageId: "p", pageName: "P", boards: this.animatedBoards(), otherLayers: [] }],
                });
            case "execute_code":
                if (String(args.code).includes("isComponentCopyInstance")) {
                    return ok({
                        result: {
                            components: [
                                {
                                    id: "c1",
                                    name: "Task card",
                                    path: "Cards",
                                    libraryId: "lib",
                                    boards: { [TASKS]: 3 },
                                },
                                { id: "c2", name: "Plus", path: "Icons", libraryId: "lib", boards: { [TASKS]: 4 } },
                            ],
                        },
                        log: [],
                    });
                }
                return { isError: true, content: [], text: "unavailable" };
            default:
                return { isError: true, content: [], text: `unknown tool ${tool}` };
        }
    }

    private boards(): unknown[] {
        const board = (id: string, name: string, interactions: unknown[]) => ({
            id,
            name,
            pageId: "p",
            pageName: "P",
            width: 390,
            height: 844,
            interactions,
        });
        const on = (sourceName: string, action: unknown) => ({
            sourceId: sourceName,
            sourceName,
            trigger: "click",
            delay: null,
            action,
        });
        return [
            board(TASKS, "Tasks", [
                on("Plus", { type: "navigate-to", destinationId: ADD }),
                on("Burger", {
                    type: "open-overlay",
                    destinationId: MENU,
                    position: "center",
                    closeWhenClickOutside: true,
                }),
            ]),
            board(ADD, "Add task", [on("Back", { type: "previous-screen", destinationId: null })]),
            board(MENU, "Menu", [on("Close", { type: "close-overlay", destinationId: null })]),
        ];
    }

    private animatedBoards(): unknown[] {
        return [
            {
                boardId: TASKS,
                boardName: "Tasks",
                layers: [
                    {
                        nodeId: "l-list",
                        name: "Task list",
                        path: "Task list",
                        codeName: "taskList",
                        childCount: 3,
                        animations: this.cardAnimation,
                    },
                ],
            },
            {
                boardId: ADD,
                boardName: "Add task",
                layers: [
                    {
                        nodeId: "l-save",
                        name: "Save",
                        path: "Form/Save",
                        codeName: "save",
                        childCount: 1,
                        animations: SPRING_PRESS,
                    },
                ],
            },
        ];
    }
}

const APP = `import { BrowserRouter, Route, Routes } from "react-router-dom";
export const App = () => (<BrowserRouter><Routes><Route path="/" element={<Tasks />} /><Route path="/add-task" element={<AddTask />} /></Routes></BrowserRouter>);`;
const TASKS_TSX = `import { TaskCard } from "../components/TaskCard";
import { Menu } from "../components/Menu";
import { tasksTaskList } from "../penforge/motion";
export const Tasks = () => { const navigate = useNavigate(); return (<main><motion.div {...tasksTaskList.enter(0, 3)}><TaskCard /></motion.div><button onClick={() => navigate("/add-task")}>+</button><Menu /></main>); };`;
const ADD_TSX = `import { addTaskSave } from "../penforge/motion";
export const AddTask = () => <form><button onClick={() => navigate(-1)}>Back</button><motion.button {...addTaskSave.press}>Save</motion.button></form>;`;
const CARD_TSX = `export function TaskCard() { return <div className="card" />; }`;
const MENU_TSX = `export const Menu = () => <dialog />;`;

function sources(files: Record<string, string>): AppSources {
    return new AppSources(Object.entries(files).map(([file, text]) => ({ file, text })));
}

function goodApp(): Record<string, string> {
    return {
        "src/App.tsx": APP,
        "src/screens/Tasks.tsx": TASKS_TSX,
        "src/screens/AddTask.tsx": ADD_TSX,
        "src/components/TaskCard.tsx": CARD_TSX,
        "src/components/Menu.tsx": MENU_TSX,
        "src/card.css": ".card { color: var(--color-primary); padding: var(--spacing-md); }",
    };
}

function theme(): TokenManifestData {
    const token = (category: any, key: string, cssName: string, value: any) => ({
        type: "color",
        category,
        key,
        cssName,
        value: DesignTokens.checkValue(value) ?? value,
    });
    return {
        schemaVersion: 1,
        file: "src/theme.css",
        format: "css",
        objectName: "tokens",
        sets: [],
        themes: [],
        blockHash: "",
        tokens: new Map([
            ["color.primary", token("color", "primary", "color-primary", { kind: "color", value: "#6c5ce7" })],
            ["spacing.md", token("spacing", "md", "spacing-md", { kind: "dimension", value: 16 })],
            ["radius.card", token("radius", "card", "radius-card", { kind: "dimension", value: 12 })],
            ["font.body", token("fontFamily", "body", "font-body", { kind: "fontFamily", value: ["Inter"] })],
        ]),
    };
}

let home: string;
let workspace: ProjectWorkspace;
let design: TodoDesign;

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-conformance-"));
    workspace = new ProjectWorkspace(join(home, "projects"), "project-1");
    await workspace.ensure();
    design = new TodoDesign();
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

function contextOf(
    events: { kind: string; payload: any }[],
    run: (request: WorkflowClaudeRequest) => Promise<WorkflowClaudeResult>
): WorkflowContext {
    return {
        runId: "run-1",
        context: {
            fileId: "file-1",
            fileName: "To-do",
            projectId: "project-1",
            teamId: "team-1",
            pageId: "p",
            persona: "developer",
            platform: "web",
        },
        runner: { run },
        tools: { call: async (tool, args) => design.call(tool, args), list: async () => [] },
        workspace,
        signal: new AbortController().signal,
        emit: (kind, payload) => {
            events.push({ kind, payload });
        },
        ask: async () => {
            throw new Error("no questions expected");
        },
    };
}

async function contract(): Promise<DesignContract> {
    return new DesignContractReader(contextOf([], async () => ({ text: "" }))).read();
}

async function input(overrides: Partial<CheckInput> = {}): Promise<CheckInput> {
    const read = await contract();
    return {
        contract: read,
        screens: [
            { boardId: TASKS, name: "Tasks", route: "/", files: ["src/screens/Tasks.tsx"] },
            { boardId: ADD, name: "Add task", route: "/add-task", files: ["src/screens/AddTask.tsx"] },
        ],
        components: {},
        motion: await MotionFile.plan(workspace, "framer-motion", read.animations),
        theme: theme(),
        dependencies: new Set(["react", "framer-motion"]),
        ...overrides,
    };
}

async function codes(files: Record<string, string>, overrides: Partial<CheckInput> = {}): Promise<string[]> {
    const result = new ConformanceChecker(sources(files), await input(overrides)).check();
    return result.findings.map((finding) => finding.code);
}

describe("design contract", () => {
    test("reads links, overlays, components and animations; unreadable parts are named", async () => {
        const read = await contract();
        assert.deepEqual(read.unread, []);
        assert.deepEqual([...read.overlays], [MENU]);
        assert.deepEqual(
            read.links.map((link) => `${link.from}:${link.type}:${link.to}`),
            [
                `${TASKS}:navigate:${ADD}`,
                `${TASKS}:open-overlay:${MENU}`,
                `${ADD}:previous-screen:null`,
                `${MENU}:close-overlay:null`,
            ]
        );
        assert.equal(read.animations.length, 2);
        assert.deepEqual(
            ConformanceChecker.required(read).map((component) => component.design),
            ["Cards/Task card"],
            "icons need no code component"
        );
        const broken = await new DesignContractReader({
            ...contextOf([], async () => ({ text: "" })),
            tools: {
                call: async (tool) =>
                    tool === "get_animation_spec"
                        ? { isError: true, content: [], text: "another file is open" }
                        : design.call(tool),
                list: async () => [],
            },
        }).read();
        assert.deepEqual(
            broken.unread.map((entry) => entry.part),
            ["components", "animations"]
        );
    });

    test("a board that is navigated to, or starts a flow, is no overlay", () => {
        const link = (from: string, to: string, type: "navigate" | "open-overlay") => ({
            from,
            to,
            type,
            trigger: "click",
            delay: null,
            sourceId: "s",
            sourceName: "s",
            url: null,
            overlay: "",
        });
        const links = [link("a", "b", "open-overlay"), link("a", "c", "open-overlay"), link("b", "c", "navigate")];
        assert.deepEqual([...PrototypeLinks.overlayBoards(links, [])], ["b"]);
        assert.deepEqual([...PrototypeLinks.overlayBoards(links, [{ name: "f", startingBoardId: "b" }])], []);
        assert.deepEqual(PrototypeLinks.openers(links, "b"), ["a"]);
    });

    test("components script lists outermost instances per board", async () => {
        const instance = (name: string) => ({
            isComponentCopyInstance: () => true,
            isComponentMainInstance: () => false,
            component: () => ({ id: `c-${name}`, name, path: "Cards", libraryId: "lib" }),
            children: [{ isComponentCopyInstance: () => true, component: () => ({ name: "inner" }) }],
        });
        const penpot = {
            currentFile: {
                pages: [
                    {
                        root: {
                            children: [
                                { type: "board", id: "b1", children: [instance("Task"), instance("Task")] },
                                { type: "rect", id: "r1" },
                            ],
                        },
                    },
                ],
            },
        };
        const result = new Function("penpot", DesignContractReader.COMPONENTS_SCRIPT)(penpot);
        assert.deepEqual(result.components, [
            { id: "c-Task", name: "Task", path: "Cards", libraryId: "lib", boards: { b1: 2 } },
        ]);
    });
});

describe("motions", () => {
    const named = (key: string, spec: Record<string, unknown>): NamedMotion => ({
        key,
        label: "Tasks / */ list",
        motion: MotionModel.compile(spec),
    });

    test("entrance, exit, states and loops compile as the player in Penpot does", () => {
        const motion = MotionModel.compile({
            v: 1,
            entrance: FADE_STAGGER.entrance,
            exit: { effects: [{ type: "slide", direction: "up" }], duration: 200 },
            loop: { type: "pulse", intensity: 2 },
        });
        assert.deepEqual(
            motion.enter?.tracks.map((t) => [t.prop, ...t.values]),
            [
                ["opacity", 0, 1],
                ["translateY", 24, 0],
            ]
        );
        assert.deepEqual(motion.enter?.stagger, { each: 80, from: "first" });
        // an exit moves on in its direction
        assert.deepEqual(motion.exit?.tracks[0].values, [0, -24]);
        assert.deepEqual(motion.exit?.tracks[0].easings[0], { kind: "bezier", points: [0.42, 0, 1, 1] });
        assert.deepEqual(motion.loop?.tracks[0].values, [1, 1.12, 1]);
        assert.equal(motion.loop?.iterations, "infinite");
        const stagger = { each: 100, from: "center" as const };
        assert.deepEqual(
            [0, 1, 2, 3, 4].map((i) => MotionModel.staggerDelay(stagger, i, 5)),
            [200, 100, 0, 100, 200]
        );
    });

    test("springs keep their physics and settle time", () => {
        const spring = MotionEasing.parse({ type: "spring", stiffness: 300, damping: 20 }, "ease");
        assert.deepEqual(spring, { kind: "spring", stiffness: 300, damping: 20, mass: 1 });
        const settle = MotionEasing.duration(spring, 120);
        assert.ok(settle > 400 && settle < 900, `settles in ${settle} ms`);
        assert.ok(MotionEasing.at(spring, 0.3) > 1, "overshoots");
        const ease = MotionEasing.parse("ease-in-out", "linear");
        assert.ok(Math.abs(MotionEasing.at(ease, 0.5) - 0.5) < 1e-6);
    });

    test("free keyframes under a curve are sampled, plain ones kept", () => {
        const tracks = [
            {
                prop: "rotate",
                keyframes: [
                    { at: 0, value: 0 },
                    { at: 0.3, value: 90 },
                    { at: 1, value: 0 },
                ],
            },
        ];
        const plain = MotionModel.compile({ entrance: { tracks, duration: 400, easing: "linear" } });
        assert.deepEqual(plain.enter?.tracks[0].times, [0, 0.3, 1]);
        const curved = MotionModel.compile({ entrance: { tracks, duration: 400, easing: "ease-in" } });
        assert.equal(curved.enter?.tracks[0].sampled, true);
        assert.equal(curved.enter?.tracks[0].values[0], 0);
    });

    test("Framer Motion file: same durations, delays, easings and stagger; safe comments", () => {
        const code = MotionCode.of("framer-motion", false);
        const text = code.file([named("tasksTaskList", FADE_STAGGER), named("addTaskSave", SPRING_PRESS)]);
        assert.doesNotMatch(text, /Tasks \/ \*\//, "a layer name cannot close the comment");
        const exported = new Function(
            `${text.replace(/export (const|function)/g, "$1")}\nreturn { tasksTaskList, addTaskSave };`
        )();
        const second = exported.tasksTaskList.enter(1, 3);
        assert.deepEqual(second.initial, { opacity: 0, y: 24 });
        assert.equal(second.animate.transition.duration, 0.3);
        assert.ok(Math.abs(second.animate.transition.delay - 0.18) < 1e-9);
        assert.deepEqual(second.animate.transition.ease, [0, 0, 0.58, 1]);
        assert.deepEqual(exported.addTaskSave.press.whileTap.transition, {
            type: "spring",
            stiffness: 300,
            damping: 20,
            mass: 1,
        });
        assert.match(MotionCode.of("framer-motion", true).file([named("a", FADE_STAGGER)]), /as \[number, number/);
    });

    test("CSS and Reanimated files carry the same values", () => {
        const css = MotionCode.of("css", false).file([
            named("tasksTaskList", FADE_STAGGER),
            named("addTaskSave", SPRING_PRESS),
            named("badge", { loop: { type: "spin", duration: 900 } }),
        ]);
        assert.match(css, /\.pf-tasks-task-list-enter > \* \{ animation: [^}]*300ms cubic-bezier\(0, 0, 0.58, 1\)/);
        assert.match(css, /calc\(100ms \+ var\(--pf-i, 0\) \* 80ms\)/);
        assert.match(css, /translate: 0 24px/);
        assert.match(css, /\.pf-add-task-save-states:active \{ scale: 0.95/);
        assert.match(css, /linear\(0, /, "a spring becomes a linear() curve");
        assert.match(css, /pf-badge-loop 900ms linear 0ms infinite/);

        const text = MotionCode.of("reanimated", false).file([
            named("save", SPRING_PRESS),
            named("list", FADE_STAGGER),
        ]);
        const exported = new Function(`${text.replace(/export (const|function)/g, "$1")}\nreturn { save, list };`)();
        assert.deepEqual(exported.save.press.spring, { stiffness: 300, damping: 20, mass: 1 });
        assert.deepEqual(exported.list.enter.tracks.translateY, { values: [24, 0], bezier: [0, 0, 0.58, 1] });
        assert.deepEqual(exported.list.enter.stagger, { each: 80, from: "first" });
    });

    test("the library follows the stack; names stay between builds", async () => {
        const app = workspace.appSrcDir;
        assert.equal(await MotionFile.library(app, { name: "React + Vite" }), "framer-motion");
        assert.equal(await MotionFile.library(app, { name: "Expo (React Native)" }), "reanimated");
        assert.equal(await MotionFile.library(app, { name: "Vue 3 + Vite" }), "css");

        const layer = (nodeId: string) => ({
            nodeId,
            name: "Card",
            path: "Card",
            codeName: "card",
            childCount: 0,
            boardId: "b",
            boardName: "Home",
            animations: FADE_STAGGER,
            smart: [],
        });
        mkdirSync(join(app, "src"), { recursive: true });
        writeFileSync(join(app, "tsconfig.json"), "{}");
        const first = await MotionFile.plan(workspace, "framer-motion", [layer("1"), layer("2")]);
        assert.deepEqual(
            first.entries.map((entry) => entry.key),
            ["homeCard", "homeCard2"]
        );
        assert.equal(first.file, "src/penforge/motion.ts");
        await first.write();
        // the first layer is gone: the second keeps its name
        const second = await MotionFile.plan(workspace, "framer-motion", [layer("2"), layer("3")]);
        assert.deepEqual(
            second.entries.map((entry) => entry.key),
            ["homeCard2", "homeCard"]
        );
        // a hand edit is undone
        writeFileSync(join(app, "src/penforge/motion.ts"), "edited");
        await second.write();
        assert.match(readFileSync(join(app, "src/penforge/motion.ts"), "utf8"), /export const homeCard2/);
    });
});

describe("checker", () => {
    test("a to-do app that follows the design is clean", async () => {
        const result = new ConformanceChecker(sources(goodApp()), await input()).check();
        assert.deepEqual(result.findings, []);
        assert.equal(result.checks.flows.state, "ok");
        assert.equal(result.checks.animations.checked, 2);
        assert.equal(result.checks.components.checked, 1);
    });

    test("flows: missing and extra routes, dead links, no back, no overlay", async () => {
        const app = goodApp();
        assert.deepEqual(await codes({ ...app, "src/App.tsx": APP.replace('path="/add-task"', 'path="/settings"') }), [
            "route-missing",
            "route-extra",
        ]);
        assert.deepEqual(
            await codes({ ...app, "src/screens/Tasks.tsx": TASKS_TSX.replace('navigate("/add-task")', "noop()") }),
            ["link-missing"]
        );
        assert.deepEqual(
            await codes({ ...app, "src/screens/AddTask.tsx": ADD_TSX.replace("navigate(-1)", "noop()") }),
            ["back-missing"]
        );
        assert.deepEqual(
            await codes({
                ...app,
                "src/screens/Tasks.tsx": TASKS_TSX.replace(/^import \{ Menu.*\n/m, "").replace("<Menu />", ""),
            }),
            ["overlay-missing"]
        );
    });

    test("flows: route constants, screen names and file-based routes count", async () => {
        const app = goodApp();
        const constants = {
            ...app,
            "src/routes.ts": 'export const routes = { tasks: "/", addTask: "/add-task" };',
            "src/App.tsx": APP.replace('path="/"', "path={routes.tasks}").replace(
                'path="/add-task"',
                "path={routes.addTask}"
            ),
            "src/screens/Tasks.tsx": TASKS_TSX.replace('"/add-task"', "routes.addTask"),
        };
        assert.deepEqual(await codes(constants), []);

        const expo = sources({ "app/(tabs)/index.tsx": "", "app/add-task.tsx": "", "app/_layout.tsx": "" });
        assert.ok(expo.hasRoute("/") && expo.hasRoute("/add-task") && !expo.hasRoute("/other"));
        const next = sources({ "src/app/page.tsx": "", "src/app/tasks/[id]/page.tsx": "", "src/app/layout.tsx": "" });
        assert.ok(next.hasRoute("/") && next.hasRoute("/tasks/:id"));
        const native = sources({
            "src/App.tsx":
                '<NavigationContainer linking={{ config: { screens: { AddTask: "add-task", Tasks: "" } } }}>',
        });
        assert.ok(native.hasRoute("/add-task"));
        const redirect = sources({ "src/App.tsx": '<Routes><Route path="/" element={<Navigate to="/tasks" />} />' });
        assert.ok(redirect.startsAt("/tasks", []) && !redirect.startsAt("/other", []));
    });

    test("design values: literal colors, sizes and fonts that a token names", async () => {
        const app = goodApp();
        const css =
            ".card { color: #6C5CE7; padding: 16px; border-radius: 12px; font-family: Inter, sans-serif; width: 16px; }";
        assert.deepEqual((await codes({ ...app, "src/card.css": css })).sort(), [
            "hardcoded-color",
            "hardcoded-font",
            "hardcoded-size",
            "hardcoded-size",
        ]);
        const tailwind = '<div className="bg-[#6c5ce7] p-[16px]" style={{ borderRadius: 12 }} />';
        assert.deepEqual((await codes({ ...app, "src/components/Menu.tsx": `${MENU_TSX}\n${tailwind}` })).sort(), [
            "hardcoded-color",
            "hardcoded-size",
            "hardcoded-size",
        ]);
        // the theme file, comments and unnamed values are free
        assert.deepEqual(
            await codes({
                ...app,
                "src/theme.css": ":root { --color-primary: #6c5ce7; }",
                "src/card.css": "/* #6c5ce7 */ .card { color: #123456; padding: 13px; }",
            }),
            []
        );
        // with a design system a color outside it is a finding, black and shadows are not
        const bound = { ...(await contract()), designSystem: "Brand" };
        assert.deepEqual(
            await codes(
                {
                    ...app,
                    "src/card.css": ".a { color: #123456; background: #000; box-shadow: 0 1px 2px rgba(0,0,0,.2); }",
                },
                { contract: bound }
            ),
            ["off-system-color"]
        );
        assert.equal(DesignValueLint.color("rgb(108, 92, 231)"), "#6c5ce7");
        assert.equal(DesignValueLint.color("#FFF"), "#ffffff");
        assert.equal(DesignValueLint.color("rgba(0 0 0 / 50%)"), "#00000080");
    });

    test("components: no code component, or one that a screen does not use", async () => {
        const app = goodApp();
        const { "src/components/TaskCard.tsx": _card, ...without } = app;
        assert.deepEqual(await codes({ ...without, "src/screens/Tasks.tsx": TASKS_TSX.replace(/TaskCard/g, "Row") }), [
            "component-missing",
        ]);
        assert.deepEqual(
            await codes({
                ...app,
                "src/screens/Tasks.tsx": TASKS_TSX.replace(/^import \{ TaskCard.*\n/m, "").replace("<TaskCard />", ""),
            }),
            ["component-unused"]
        );
        // a name the build reported counts
        assert.deepEqual(
            await codes(
                {
                    ...without,
                    "src/components/Row.tsx": "export const Row = () => null;",
                    "src/screens/Tasks.tsx": TASKS_TSX.replace("components/TaskCard", "components/Row").replace(
                        /TaskCard/g,
                        "Row"
                    ),
                },
                { components: { "Cards/Task card": { name: "Row", file: "src/components/Row.tsx" } } }
            ),
            []
        );
        assert.deepEqual(CodeNames.componentNames("Buttons", "Primary, Large").slice(0, 2), [
            "Primary",
            "ButtonsPrimary",
        ]);
    });

    test("animations: not applied, not loaded, library missing", async () => {
        const app = goodApp();
        assert.deepEqual(
            await codes({
                ...app,
                "src/screens/AddTask.tsx": ADD_TSX.replace("{...addTaskSave.press}", "").replace(/^import.*\n/, ""),
            }),
            ["animation-missing"]
        );
        assert.deepEqual(await codes(app, { dependencies: new Set(["react"]) }), ["motion-library-missing"]);
        const local = { ...app };
        for (const file of ["src/screens/Tasks.tsx", "src/screens/AddTask.tsx"]) {
            local[file] = local[file].replace("../penforge/motion", "../copied");
        }
        assert.deepEqual(await codes(local), ["motion-not-loaded"]);
    });

    test("parts that could not be read are skipped, not clean", async () => {
        const read = await contract();
        const result = new ConformanceChecker(
            sources(goodApp()),
            await input({
                contract: { ...read, unread: [{ part: "animations", reason: "another file" }] },
                theme: null,
            })
        ).check();
        assert.equal(result.checks.animations.state, "skipped");
        assert.equal(result.checks.values.state, "skipped");
        assert.equal(result.checks.flows.state, "ok");
    });

    test("prompt lines name flows, overlays, components and motions", async () => {
        const read = await contract();
        const prompt = new ContractPrompt(read, [
            { boardId: TASKS, name: "Tasks", route: "/" },
            { boardId: ADD, name: "Add task", route: "/add-task" },
        ]);
        const motion = await MotionFile.plan(workspace, "framer-motion", read.animations);
        const app = prompt.appLines("framer-motion", motion).join("\n");
        assert.match(app, /flow "Main" starts at "Tasks" \(\/\)/);
        assert.match(app, /"Menu" \(board board-menu\) as component Menu, opened from "Tasks"/);
        assert.match(app, /"Cards\/Task card" → TaskCard \(on Tasks\)/);
        const screen = prompt.screenLines(TASKS, motion).join("\n");
        assert.match(screen, /Overlay of this screen: "Menu"/);
        assert.match(screen, /closes the overlay/);
        assert.match(screen, /"Task list": tasksTaskList\.enter \(its 3 children one after the other\)/);
        assert.deepEqual(prompt.navigationLines(ADD), ['- click on "Back" → back to the previous screen']);
        assert.match(prompt.navigationLines(TASKS)!.join(), /opens the overlay "Menu" \(position center, closes on/);
    });
});

// build with a scripted Claude ------------------------------------------------------------

/** Scripted Claude: builds the sample, leaving drift that its fix turn removes. */
class FakeClaude {
    public readonly prompts: string[] = [];
    public drift = true;
    public fixes = true;

    constructor(private readonly app: string) {}

    public run = async (request: WorkflowClaudeRequest): Promise<WorkflowClaudeResult> => {
        this.prompts.push(request.prompt);
        const json = (value: unknown) => ({ sessionId: "s", text: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` });
        const prompt = request.prompt;
        const stack = {
            name: "React + Vite",
            packageManager: "npm",
            commands: { install: ["npm", "install"], build: ["npm", "run", "build"], dev: ["npm", "run", "dev"] },
        };
        if (prompt.startsWith("Plan the app")) {
            return json({
                summary: "A to-do app.",
                stack,
                screens: [
                    { boardId: ADD, route: "/" },
                    { boardId: TASKS, route: "/tasks" },
                    { boardId: MENU, route: "/menu" },
                ],
            });
        }
        if (prompt.startsWith("## Step: scaffold")) {
            this.write("package.json", '{ "dependencies": { "react": "19", "framer-motion": "12" } }');
            this.write("tsconfig.json", "{}");
            this.write("src/App.tsx", APP);
            this.write("src/components/TaskCard.tsx", CARD_TSX);
            return json({
                stack,
                components: [{ design: "Cards/Task card", name: "TaskCard", file: "src/components/TaskCard.tsx" }],
            });
        }
        const screen = /## Step: (?:build|update) the screen "([^"]+)"/.exec(prompt)?.[1];
        if (screen === "Tasks") {
            this.write("src/components/Menu.tsx", MENU_TSX);
            this.write("src/screens/Tasks.tsx", TASKS_TSX);
            return json({ files: ["src/screens/Tasks.tsx"] });
        }
        if (screen === "Add task") {
            this.write("src/screens/AddTask.tsx", this.drift ? "export const AddTask = () => <form />;" : ADD_TSX);
            return json({ files: [join(this.app, "src", "screens", "AddTask.tsx")] });
        }
        if (prompt.startsWith("## Step: make the app follow the design")) {
            if (this.fixes) {
                this.write("src/screens/AddTask.tsx", ADD_TSX);
                this.write("src/screens/Tasks.tsx", `${TASKS_TSX}\n// touched by the fix`);
            }
            return json({ files: [] });
        }
        return { sessionId: "s", text: "ok" };
    };

    private write(file: string, content: string): void {
        const path = join(this.app, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
}

class FakeExecutor implements CommandExecutor {
    public readonly calls: string[] = [];

    public async execute(argv: string[], options: CommandOptions) {
        this.calls.push(argv.join(" "));
        if (argv.includes("install")) {
            mkdirSync(join(options.cwd, "node_modules"), { recursive: true });
        }
        return { code: 0, output: "", timedOut: false };
    }
}

describe("build", () => {
    async function build(claude: FakeClaude, params: Record<string, unknown> = {}) {
        const events: { kind: string; payload: any }[] = [];
        await new AppBuilder(contextOf(events, claude.run), { executor: new FakeExecutor() }).build(params);
        return events;
    }

    async function firstBuild(claude: FakeClaude) {
        await new BuildPlanner(contextOf([], claude.run)).plan({ ask: false });
        return build(claude);
    }

    test("the plan follows the prototype: start screen at /, overlays get no route", async () => {
        const claude = new FakeClaude(workspace.appSrcDir);
        await new BuildPlanner(contextOf([], claude.run)).plan({ ask: false });
        const plan = await new BuildFiles(workspace).readPlan();
        assert.deepEqual(
            plan?.screens.map((screen) => `${screen.name}:${screen.route}`),
            ["Add task:/add-task", "Tasks:/"]
        );
        assert.equal(plan?.stack.animations, "framer-motion");
        assert.match(claude.prompts[0], /## Overlays[\s\S]*"Menu" \(board-menu\), opened from Tasks/);
    });

    test("drift is fixed in the same run; the report is clean and the motion file generated", async () => {
        const claude = new FakeClaude(workspace.appSrcDir);
        const events = await firstBuild(claude);
        const fix = claude.prompts.filter((prompt) => prompt.startsWith("## Step: make the app follow"));
        assert.equal(fix.length, 1);
        assert.match(fix[0], /\[back-missing\] "Back" on "Add task" must go back/);
        assert.match(
            fix[0],
            /\[animation-missing\] The layer "Save" on "Add task" is not animated; apply addTaskSave\.press/
        );
        assert.ok(fix[0].includes(workspace.appSrcDir), "turns name the app folder");

        const result = events.find((event) => event.kind === "result")!.payload;
        assert.deepEqual(result.conformance, {
            status: "clean",
            fixed: 2,
            left: 0,
            elsewhere: 0,
            items: [],
            skipped: [{ check: "values", reason: "The app has no theme with design tokens" }],
        });
        const report = await new ConformanceReports(workspace).read();
        assert.equal(report?.status, "clean");
        assert.equal(report?.mode, "full");
        assert.equal(report?.attempts, 1);
        const motion = readFileSync(join(workspace.appSrcDir, "src/penforge/motion.ts"), "utf8");
        assert.match(motion, /export const tasksTaskList = \{/);
        assert.equal((await new BuildFiles(workspace).readStack())?.animations, "framer-motion");
        assert.deepEqual(
            (await workspace.readJson<any>("components.json", null)).components["Cards/Task card"].name,
            "TaskCard"
        );
        const screen = claude.prompts.find((prompt) => prompt.includes('build the screen "Tasks"'))!;
        assert.match(screen, /tasksTaskList\.enter/);
        assert.match(screen, /click on "Plus" → "Add task" \(\/add-task\)/);
    });

    test("what the AI cannot fix is reported, and the build still succeeds", async () => {
        const claude = new FakeClaude(workspace.appSrcDir);
        claude.fixes = false;
        const events = await firstBuild(claude);
        const result = events.find((event) => event.kind === "result")!.payload;
        assert.equal(result.preview, true);
        assert.equal(result.conformance.status, "findings");
        assert.equal(result.conformance.left, 2);
        assert.deepEqual(result.conformance.items.map((item: { code: string }) => item.code).sort(), [
            "animation-missing",
            "back-missing",
        ]);
        assert.equal(
            claude.prompts.filter((prompt) => prompt.startsWith("## Step: make the app follow")).length,
            1,
            "a turn that changes nothing is not repeated"
        );
    });

    test("an update checks and fixes the touched screens only", async () => {
        const claude = new FakeClaude(workspace.appSrcDir);
        await firstBuild(claude);
        const tasks = join(workspace.appSrcDir, "src/screens/Tasks.tsx");
        // drift on an untouched screen stays; the update touches Add task
        const drifted = TASKS_TSX.replace('navigate("/add-task")', "noop()");
        writeFileSync(tasks, drifted);
        design.hashes[ADD] = "2";
        await new BuildPlanner(contextOf([], claude.run)).plan({ ask: false });
        const before = claude.prompts.length;
        const events = await build(claude);
        const prompts = claude.prompts.slice(before);
        assert.match(prompts[0], /update the screen "Add task"/);
        assert.match(prompts[1], /back-missing/);
        assert.doesNotMatch(prompts[1], /link-missing/);
        assert.equal(
            readFileSync(tasks, "utf8").split("\r").join(""),
            drifted,
            "a fix cannot change files of an untouched screen"
        );
        const result = events.find((event) => event.kind === "result")!.payload;
        assert.equal(result.conformance.left, 0);
        assert.equal(result.conformance.elsewhere, 1);
        const report = await new ConformanceReports(workspace).read();
        assert.deepEqual(report?.touched, [ADD]);
        assert.deepEqual(report?.diff, { added: [`link-missing:${TASKS}:${ADD}`], resolved: [] });
    });

    test("a changed overlay updates the screens that open it", async () => {
        const claude = new FakeClaude(workspace.appSrcDir);
        claude.drift = false;
        await firstBuild(claude);
        design.hashes[MENU] = "2";
        const events: { kind: string; payload: any }[] = [];
        await new BuildPlanner(contextOf(events, claude.run)).plan({ ask: false });
        const plan = events.find((event) => event.kind === "plan")!.payload;
        assert.deepEqual(
            plan.screens.map((screen: { name: string; status: string }) => `${screen.name}:${screen.status}`),
            ["Tasks:changed", "Add task:same"]
        );
    });

    test("a design that cannot be read never fails the build", async () => {
        const claude = new FakeClaude(workspace.appSrcDir);
        claude.drift = false;
        await new BuildPlanner(contextOf([], claude.run)).plan({ ask: false });
        const events: { kind: string; payload: any }[] = [];
        const ctx = contextOf(events, claude.run);
        const gone: WorkflowContext = {
            ...ctx,
            tools: { call: async () => ({ isError: true, content: [], text: "tab closed" }), list: async () => [] },
        };
        await new AppBuilder(gone, { executor: new FakeExecutor() }).build();
        const result = events.find((event) => event.kind === "result")!.payload;
        assert.equal(result.conformance.status, "unchecked");
        assert.ok(existsSync(join(workspace.metaDir, "conformance.json")));
        assert.ok(TokenManifest.FILE.length > 0);
    });
});
