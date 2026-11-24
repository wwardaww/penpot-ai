import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { WorkflowClaudeRequest, WorkflowClaudeResult } from "@penpot/mcp-common";
import { PromptRegistry } from "../prompts/promptRegistry";
import { workflow as codeRedesign } from "../workflows/code-redesign";
import { DesignGaps, type DesignGap, type RedesignDecision } from "./DesignGaps";
import { LinkedProjectPrompt } from "./LinkedProjectPrompt";
import { LookGuard } from "./LookGuard";
import type { ProjectLink } from "./ProjectLink";
import { RedesignBranch } from "./RedesignBranch";
import { fakeRun, git, gitInit, okJson, reactApp } from "./testing/fixtures";

let base: string;
let projectsDir: string;

before(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "penforge-gaps-")));
    projectsDir = join(base, "Penforge", "projects");
    mkdirSync(projectsDir, { recursive: true });
});

after(() => {
    rmSync(base, { recursive: true, force: true });
});

const MENU: DesignGap = {
    key: "mobile-menu",
    name: "Mobile menu",
    kind: "component",
    screens: ["Home"],
    what: "A button that opens the navigation on phones",
    why: "The app has no menu on phones",
};
const FORM: DesignGap = {
    key: "newsletter-form",
    name: "Newsletter form",
    kind: "feature",
    screens: ["Home"],
    what: "Visitors leave their e-mail",
    why: "Needs a backend that stores the addresses",
};

const tool = (name: string) =>
    name === "list_boards"
        ? okJson([
              { id: "b-home", name: "Home", pageId: "p1", pageName: "Screens", width: 390, height: 844 },
              { id: "b-settings", name: "Settings", pageId: "p1", pageName: "Screens", width: 390, height: 844 },
          ])
        : { isError: true, content: [], text: "unavailable" };

function link(root: string): ProjectLink {
    return { kind: "existing", root, engine: null, stack: { platform: "web", name: "react" }, linkedAt: "" };
}

function app(name: string): string {
    const root = join(base, name);
    reactApp(root, 2);
    gitInit(root);
    return root;
}

function json(value: unknown): WorkflowClaudeResult {
    return { text: `Done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` };
}

/** Scripted Claude: lists the gaps, then builds what the prompt says to build. */
class FakeClaude {
    public compares = 0;
    public gaps: unknown[] = [MENU, FORM];
    /** Claude also writes a form although it must be left out */
    public plantForm = false;

    constructor(private readonly root: string) {}

    public turn = (request: WorkflowClaudeRequest): WorkflowClaudeResult => {
        if (request.promptName === "code-redesign-gaps") {
            this.compares++;
            assert.notEqual(request.toolFilter!.check("Write", { file_path: join(this.root, "x.ts") }), null);
            return json({ items: this.gaps });
        }
        const build = request.prompt.split("Leave these out")[0];
        this.write("src/styles.css", ":root { --primary: #ff3366; }");
        const items: unknown[] = [];
        if (build.includes("`mobile-menu`")) {
            this.write(
                "src/hooks/useMenu.ts",
                "import { useReducer } from 'react';\nexport const useMenu = () => useReducer((open) => !open, false);"
            );
            this.write("src/components/Menu.tsx", "export const Menu = () => <nav />;");
            items.push({
                key: "mobile-menu",
                status: "done",
                files: ["src/hooks/useMenu.ts", "./src/components/Menu.tsx"],
            });
        }
        if (build.includes("`newsletter-form`") || this.plantForm) {
            this.write("src/api/newsletter.ts", "export const send = (mail) => fetch('/api/newsletter');");
            items.push({ key: "newsletter-form", status: "done", files: ["src/api/newsletter.ts"] });
        }
        return json({ screens: [{ name: "Home", status: "done" }], items, unmatched: [], featureFiles: [] });
    };

    private write(path: string, text: string): void {
        const file = join(this.root, ...path.split("/"));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
    }
}

async function run(root: string, projectId: string, claude: FakeClaude, params: object) {
    const fake = await fakeRun(projectsDir, link(root), {
        projectType: "existing",
        projectId,
        tool,
        turn: claude.turn,
    });
    await codeRedesign.run(fake.ctx, params);
    return { ...fake, result: fake.events.at(-1)!.payload };
}

function record(projectId: string): { decisions?: RedesignDecision[]; [key: string]: unknown } {
    return JSON.parse(readFileSync(join(projectsDir, projectId, ".penforge", "redesign.json"), "utf8"));
}

describe("checklist before a Re-Design", () => {
    test("lists what the app lacks; components start checked, features unchecked; nothing is written", async () => {
        const root = app("plan");
        const before = git(root, "rev-parse", "HEAD");
        const claude = new FakeClaude(root);
        const { result, events, turns } = await run(root, "plan", claude, { action: "plan" });
        assert.equal(result.checklist.state, "ready");
        assert.deepEqual(
            result.checklist.items.map((item: any) => [item.key, item.kind, item.checked, item.decided]),
            [
                ["mobile-menu", "component", true, false],
                ["newsletter-form", "feature", false, false],
            ]
        );
        assert.equal(turns.length, 1);
        assert.ok(events.some((event) => event.kind === "progress" && event.payload.step === "compare"));
        assert.equal(git(root, "status", "--porcelain"), "");
        assert.equal(git(root, "rev-parse", "HEAD"), before);
        assert.equal(git(root, "branch", "--show-current"), "main");
        assert.throws(() => record("plan"), "no record before the user confirms");
    });

    test("unknown kinds and screens are cleaned, doubles dropped", async () => {
        const root = app("clean");
        const claude = new FakeClaude(root);
        claude.gaps = [
            { key: "Mobile Menu!", name: "Menu", kind: "component", screens: ["Home", "Nope"], what: "", why: "" },
            { key: "mobile-menu", name: "Menu again", kind: "component" },
            { name: "Çark", kind: "widget" },
        ];
        const { result } = await run(root, "clean", claude, { action: "plan" });
        assert.deepEqual(
            result.checklist.items.map((item: any) => [item.key, item.kind, item.screens, item.checked]),
            [
                ["mobile-menu", "component", ["Home"], true],
                ["cark", "feature", [], false],
            ]
        );
    });

    test("a failed comparison is said, not guessed; the run stays look-only", async () => {
        const root = app("failed");
        const claude = new FakeClaude(root);
        claude.gaps = ["nonsense"];
        const { result, turns } = await run(root, "failed", claude, { action: "plan" });
        assert.equal(result.checklist.state, "failed");
        assert.match(result.checklist.message, /no valid list/);
        assert.equal(turns.length, 2, "asked once more for a valid list");
        const ran = await run(root, "failed", claude, { action: "run" });
        assert.deepEqual(ran.result.items, []);
        assert.match(ran.turns[0].prompt, /Build these[^\n]*\n- nothing/);
        assert.equal(record("failed").decisions?.length, 0);
    });

    test("checked items are built and not flagged; the summary says what came of each", async () => {
        const root = app("run");
        const claude = new FakeClaude(root);
        await run(root, "run", claude, { action: "plan" });
        const decisions = [
            { key: "mobile-menu", build: true },
            { key: "newsletter-form", build: false },
            { key: "unknown", build: true },
        ];
        const { result, turns } = await run(root, "run", claude, { action: "run", decisions });
        assert.match(turns[0].prompt, /Build these[^\n]*\n- `mobile-menu` \(component\) Mobile menu on Home/);
        assert.match(turns[0].prompt, /Leave these out[^\n]*\n- `newsletter-form`/);
        assert.deepEqual(result.outsideLook, [], "the menu's hook is no finding");
        assert.deepEqual(result.items, [
            { key: "mobile-menu", name: "Mobile menu", kind: "component", outcome: "added" },
            { key: "newsletter-form", name: "Newsletter form", kind: "feature", outcome: "left-out" },
        ]);
        assert.deepEqual(
            record("run").decisions?.map((decision) => [decision.key, decision.build, decision.files]),
            [
                ["mobile-menu", true, ["src/hooks/useMenu.ts", "src/components/Menu.tsx"]],
                ["newsletter-form", false, []],
            ]
        );

        // a second run asks nothing again and shows the earlier decisions, changeable
        const again = await run(root, "run", claude, { action: "plan" });
        assert.match(again.turns[0].prompt, /already decided[\s\S]*`mobile-menu`: Mobile menu/);
        assert.deepEqual(
            again.result.checklist.items.map((item: any) => [item.key, item.checked, item.decided]),
            [
                ["mobile-menu", true, true],
                ["newsletter-form", false, true],
            ]
        );
        const second = await run(root, "run", claude, { action: "run" });
        assert.deepEqual(second.result.outsideLook, [], "files of earlier checked items stay accepted");
        assert.deepEqual(
            second.result.items.map((item: any) => item.outcome),
            ["added", "left-out"]
        );
        // changing the mind: the form is built now
        const third = await run(root, "run", claude, {
            action: "run",
            decisions: [{ key: "newsletter-form", build: true }],
        });
        assert.deepEqual(third.result.outsideLook, []);
        assert.deepEqual(
            third.result.items.map((item: any) => item.outcome),
            ["added", "added"]
        );
    });

    test("an unchecked feature that is built anyway is still flagged", async () => {
        const root = app("planted");
        const claude = new FakeClaude(root);
        claude.plantForm = true;
        await run(root, "planted", claude, { action: "plan" });
        const { result } = await run(root, "planted", claude, {
            action: "run",
            decisions: [
                { key: "mobile-menu", build: false },
                { key: "newsletter-form", build: false },
            ],
        });
        assert.deepEqual(
            result.outsideLook.map((item: { path: string }) => item.path),
            ["src/api/newsletter.ts"]
        );
        assert.deepEqual(
            result.items.map((item: any) => item.outcome),
            ["left-out", "left-out"]
        );
    });

    test("a checked item with no change in the code is reported as not done", async () => {
        const root = app("lazy");
        const claude = new FakeClaude(root);
        const search: DesignGap = { ...FORM, key: "search", name: "Search" };
        claude.gaps = [search];
        await run(root, "lazy", claude, { action: "plan" });
        const { result } = await run(root, "lazy", claude, {
            action: "run",
            decisions: [{ key: "search", build: true }],
        });
        assert.deepEqual(result.items, [
            {
                key: "search",
                name: "Search",
                kind: "feature",
                outcome: "not-done",
                note: "No change was made for it.",
            },
        ]);
    });

    test("nothing changed since the last comparison: no second Claude turn", async () => {
        const root = app("cache");
        const claude = new FakeClaude(root);
        const revn = (name: string) =>
            name === "execute_code"
                ? { isError: false, content: [], text: JSON.stringify({ result: 7, log: [] }) }
                : tool(name);
        const plan = async () => {
            const fake = await fakeRun(projectsDir, link(root), {
                projectType: "existing",
                projectId: "cache",
                tool: revn,
                turn: claude.turn,
            });
            await codeRedesign.run(fake.ctx, { action: "plan" });
            return fake.events.at(-1)!.payload;
        };
        await plan();
        assert.equal((await plan()).checklist.items.length, 2);
        assert.equal(claude.compares, 1);
        writeFileSync(join(root, "README.md"), "changed");
        await plan();
        assert.equal(claude.compares, 2, "uncommitted changes are compared again");
    });

    test("decisions outlive the branch; records of W38 and W39 read as before", async () => {
        const root = app("branch");
        const claude = new FakeClaude(root);
        await run(root, "branch", claude, { action: "plan" });
        await run(root, "branch", claude, { action: "run", decisions: [{ key: "mobile-menu", build: true }] });
        const first = record("branch").branch as string;
        git(root, "checkout", "-q", "main");
        git(root, "branch", "-D", first);
        const plan = await run(root, "branch", claude, { action: "plan" });
        assert.deepEqual(
            plan.result.checklist.items.map((item: any) => [item.key, item.decided]),
            [
                ["newsletter-form", false],
                ["mobile-menu", true],
            ]
        );
        const old = { ...record("branch") };
        delete old.decisions;
        assert.ok(RedesignBranch.readRecord(old));
        assert.ok(RedesignBranch.readRecord(record("branch")));
        const fake = await fakeRun(projectsDir, link(root), { projectType: "existing", projectId: "branch" });
        await fake.ctx.workspace.writeJson("redesign.json", old);
        const again = await run(root, "branch", claude, { action: "run" });
        assert.deepEqual(again.result.items, []);
    });
});

describe("guard and prompts", () => {
    test("a component may hold UI state, never data access or project files", () => {
        const check = (path: string, line: string) => LookGuard.check([{ path, added: [line] }], [], [path]).length;
        assert.equal(check("src/hooks/useMenu.ts", "const [open, toggle] = useReducer(f, false);"), 0);
        assert.equal(check("src/hooks/useMenu.ts", "const items = await fetch('/menu');"), 1);
        assert.equal(check("src/hooks/useMenu.ts", "localStorage.setItem('open', '1');"), 1);
        assert.equal(check("src/hooks/useMenu.ts", "const useStore = create(zustand);"), 1);
        assert.equal(check("package.json", '"framer-motion": "12"'), 1);
        assert.equal(check("src/api/menu.ts", "export {}"), 1);
        assert.equal(LookGuard.check([{ path: "src/hooks/useMenu.ts", added: [] }]).length, 1);
    });

    test("merge keeps earlier choices and takes the newer wording", () => {
        const decision: RedesignDecision = { ...FORM, fileId: "f", build: true, files: [], decidedAt: "" };
        const items = DesignGaps.merge([MENU, { ...FORM, name: "Newsletter" }], [decision]);
        assert.deepEqual(
            items.map((item) => [item.name, item.checked, item.decided]),
            [
                ["Mobile menu", true, false],
                ["Newsletter", true, true],
            ]
        );
    });

    test("the chat prompt names the list, the decisions and that words still count", async () => {
        const root = app("chat");
        const claude = new FakeClaude(root);
        await run(root, "chat", claude, { action: "plan" });
        const { ctx } = await run(root, "chat", claude, {
            action: "run",
            decisions: [{ key: "mobile-menu", build: true }],
        });
        const section = await LinkedProjectPrompt.section(ctx.workspace as any, ctx.context);
        assert.match(section, /ONLY the look/);
        assert.match(section, /checked it on\s+the Re-Design list/);
        assert.match(section, /you may still add what the user asks for in words/);
        assert.match(section, /- Mobile menu: build/);
    });

    test("the comparison prompt speaks the persona's language", () => {
        const prompt = (persona: "designer" | "developer") =>
            PromptRegistry.locate().build({
                persona,
                platform: "web",
                projectName: "Shop",
                workflow: "code-redesign-gaps",
            });
        assert.match(prompt("designer"), /for a designer: short, plain words/);
        assert.doesNotMatch(prompt("designer"), /short and technical/);
        assert.match(prompt("developer"), /short and technical/);
    });
});
