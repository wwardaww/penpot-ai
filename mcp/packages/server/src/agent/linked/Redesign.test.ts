import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { WorkflowClaudeRequest } from "@penpot/mcp-common";
import { workflow as codeRedesign } from "../workflows/code-redesign";
import { workflow as gameUiExport } from "../workflows/game-ui-export";
import { LinkedGit } from "./LinkedGit";
import type { ProjectLink } from "./ProjectLink";
import { RedesignBranch } from "./RedesignBranch";
import { fakeRun, git, gitInit, okJson, PNG_1PX, reactApp, unityGame } from "./testing/fixtures";

let base: string;
let projectsDir: string;

before(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "penforge-redesign-")));
    projectsDir = join(base, "Penforge", "projects");
    mkdirSync(projectsDir, { recursive: true });
});

after(() => {
    rmSync(base, { recursive: true, force: true });
});

const BOARDS = [
    { id: "b-home", name: "Home", pageId: "p1", pageName: "Screens", width: 1440, height: 1024 },
    { id: "b-settings", name: "Settings", pageId: "p1", pageName: "Screens", width: 1440, height: 1024 },
    { id: "b-ds", name: "Buttons", pageId: "p2", pageName: "Design System", width: 800, height: 600 },
];

function existingLink(root: string): ProjectLink {
    return { kind: "existing", root, engine: null, stack: { platform: "web", name: "react" }, linkedAt: "" };
}

function gameLink(root: string): ProjectLink {
    return { kind: "game", root, engine: "unity", stack: null, linkedAt: "" };
}

/** Claude's Re-Design turn: new colours and cards, plus a planted feature it should not build. */
function redesignTurn(root: string, plantFeature: boolean) {
    return (request: WorkflowClaudeRequest) => {
        const filter = request.toolFilter!;
        const write = (path: string, text: string) => {
            const file = join(root, ...path.split("/"));
            assert.equal(filter.check("Write", { file_path: file }), null, `write to ${path} refused`);
            writeFileSync(file, text);
        };
        write(
            "src/styles.css",
            ":root { --primary: #ff3366; }\n.card { border-radius: 16px; box-shadow: 0 2px 8px #0002; }"
        );
        write(
            "src/components/Card.tsx",
            'export const Card = ({ title }) => <div className="card card--elevated">{title}</div>;'
        );
        if (plantFeature) {
            write(
                "src/api/client.ts",
                "export async function listTasks() { return []; }\nexport async function shareTask() {}"
            );
        }
        assert.notEqual(filter.check("Write", { file_path: join(base, "elsewhere.txt") }), null);
        assert.notEqual(filter.check("Bash", { command: "git commit" }), null);
        return {
            text:
                "Done.\n```json\n" +
                JSON.stringify({
                    screens: [
                        { name: "Home", status: "done" },
                        { name: "Settings", status: "partial", note: "toggle style kept" },
                    ],
                    unmatched: ["Share button on Home needs a share feature"],
                    featureFiles: plantFeature ? ["src/api/client.ts"] : [],
                }) +
                "\n```",
        };
    };
}

const tools = (name: string) => {
    if (name === "list_boards") {
        return okJson(BOARDS);
    }
    return { isError: true, content: [], text: "unavailable" };
};

describe("RedesignBranch", () => {
    test("plans a new branch, then creates it without touching the user's branch", async () => {
        const app = join(base, "plan-app");
        reactApp(app, 2);
        gitInit(app);
        const mainHead = git(app, "rev-parse", "main");
        const run = await fakeRun(projectsDir, existingLink(app), { projectType: "existing", projectId: "plan" });
        const fixed = () => new Date(2026, 10, 21, 9, 5);
        const plan = await new RedesignBranch(run.ctx, app, "existing", fixed).plan();
        assert.deepEqual(plan, {
            git: true,
            dirty: false,
            currentBranch: "main",
            branch: "penforge/redesign-20261121-0905",
            continuing: false,
        });
        const outcome = await new RedesignBranch(run.ctx, app, "existing", fixed).prepare();
        assert.equal(outcome.state, "ready");
        assert.equal(git(app, "branch", "--show-current"), "penforge/redesign-20261121-0905");
        assert.equal(git(app, "rev-parse", "main"), mainHead);
        const again = await new RedesignBranch(run.ctx, app, "existing", fixed).plan();
        assert.equal(again.continuing, true);
    });

    test("asks about uncommitted changes and stashes them", async () => {
        const app = join(base, "dirty-app");
        reactApp(app, 2);
        gitInit(app);
        writeFileSync(join(app, "src", "pages", "Home.tsx"), "export const Home = () => <main>WIP</main>;");
        const run = await fakeRun(projectsDir, existingLink(app), {
            projectType: "existing",
            projectId: "dirty",
            answers: ["stash"],
        });
        const outcome = await new RedesignBranch(run.ctx, app, "existing").prepare();
        assert.equal(outcome.state, "ready");
        assert.equal(run.questions.length, 1);
        assert.deepEqual(
            run.questions[0].options.map((option) => option.id),
            ["stash", "commit", "cancel"]
        );
        assert.match(git(app, "stash", "list"), /penforge: before Re-Design/);
        assert.equal(git(app, "status", "--porcelain"), "");
    });

    test("cancel leaves everything as it was", async () => {
        const app = join(base, "cancel-app");
        reactApp(app, 2);
        gitInit(app);
        writeFileSync(join(app, "README.md"), "changed");
        const run = await fakeRun(projectsDir, existingLink(app), {
            projectType: "existing",
            projectId: "cancel",
            answers: ["cancel"],
        });
        const outcome = await new RedesignBranch(run.ctx, app, "existing").prepare();
        assert.equal(outcome.state, "cancelled");
        assert.equal(git(app, "branch", "--show-current"), "main");
        assert.match(git(app, "status", "--porcelain"), /README\.md/);
    });

    test("asks before git init; Existing project needs git, Game UI may go on without", async () => {
        const app = join(base, "nogit-app");
        reactApp(app, 2);
        const refused = await fakeRun(projectsDir, existingLink(app), {
            projectType: "existing",
            projectId: "nogit",
            answers: ["cancel"],
        });
        assert.equal((await new RedesignBranch(refused.ctx, app, "existing").prepare()).state, "cancelled");
        assert.equal(existsSync(join(app, ".git")), false);
        assert.deepEqual(
            refused.questions[0].options.map((option) => option.id),
            ["init", "cancel"]
        );

        const game = join(base, "nogit-game");
        unityGame(game, 2);
        const skipped = await fakeRun(projectsDir, gameLink(game), {
            projectType: "game",
            projectId: "nogit-game",
            answers: ["skip"],
        });
        assert.equal((await new RedesignBranch(skipped.ctx, game, "game").prepare()).state, "no-git");

        const init = await fakeRun(projectsDir, existingLink(app), {
            projectType: "existing",
            projectId: "init",
            answers: ["init"],
        });
        const outcome = await new RedesignBranch(init.ctx, app, "existing").prepare();
        assert.equal(outcome.state, "ready");
        assert.ok(git(app, "branch", "--show-current").startsWith(LinkedGit.BRANCH_PREFIX));
        // the snapshot commit keeps node_modules out
        assert.doesNotMatch(git(app, "ls-tree", "-r", "--name-only", "HEAD"), /node_modules/);
        assert.match(git(app, "ls-tree", "-r", "--name-only", "HEAD"), /src\/App\.tsx/);
    });

    test("refuses to commit on a branch it did not create", async () => {
        const app = join(base, "guard-app");
        reactApp(app, 2);
        gitInit(app);
        writeFileSync(join(app, "README.md"), "x");
        await assert.rejects(new LinkedGit(app).commit("x"), /not a Penforge branch/);
    });
});

describe("code-redesign", () => {
    test("plan lists the branch and the screen boards (design system pages left out)", async () => {
        const app = join(base, "cr-plan");
        reactApp(app, 2);
        gitInit(app);
        const run = await fakeRun(projectsDir, existingLink(app), {
            projectType: "existing",
            projectId: "cr-plan",
            tool: tools,
        });
        await codeRedesign.run(run.ctx, { action: "plan" });
        const plan = run.events.at(-1)!.payload;
        assert.equal(plan.action, "plan");
        assert.equal(plan.currentBranch, "main");
        assert.ok(plan.branch.startsWith("penforge/redesign-"));
        assert.deepEqual(
            plan.screens.map((screen: { name: string }) => screen.name),
            ["Home", "Settings"]
        );
    });

    test("new colours and cards: only look files change, on the new branch; a planted feature is flagged", async () => {
        const app = join(base, "cr-run");
        reactApp(app, 2);
        gitInit(app);
        const mainHead = git(app, "rev-parse", "main");
        const run = await fakeRun(projectsDir, existingLink(app), {
            projectType: "existing",
            projectId: "cr-run",
            tool: tools,
            turn: redesignTurn(app, true),
        });
        await codeRedesign.run(run.ctx, { action: "run" });
        const result = run.events.at(-1)!.payload;
        assert.equal(result.action, "run");
        assert.ok(result.branch.startsWith("penforge/redesign-"));
        assert.equal(git(app, "branch", "--show-current"), result.branch);
        assert.equal(git(app, "rev-parse", "main"), mainHead, "the user's branch is untouched");
        assert.deepEqual([...result.filesChanged].sort(), [
            "src/api/client.ts",
            "src/components/Card.tsx",
            "src/styles.css",
        ]);
        // not asked for in the chat: the guard flags the feature file
        assert.deepEqual(
            result.outsideLook.map((item: { path: string }) => item.path),
            ["src/api/client.ts"]
        );
        assert.deepEqual(
            result.screens.map((screen: { status: string }) => screen.status),
            ["done", "partial"]
        );
        assert.deepEqual(result.unmatched, ["Share button on Home needs a share feature"]);
        assert.match(run.turns[0].prompt, /ONLY the look/);
        assert.match(run.turns[0].prompt, /no further instructions/);

        await codeRedesign.run(run.ctx, { action: "revert", files: ["src/api/client.ts"] });
        const reverted = run.events.at(-1)!.payload;
        assert.deepEqual(reverted.reverted, ["src/api/client.ts"]);
        assert.equal(
            readFileSync(join(app, "src", "api", "client.ts"), "utf8"),
            "export async function listTasks() { return []; }"
        );
        await assert.rejects(
            codeRedesign.run(run.ctx, { action: "revert", files: ["package.json"] }),
            /Only files the Re-Design changed/
        );
    });

    test("a feature the user asked for in the chat is not flagged", async () => {
        const app = join(base, "cr-feature");
        reactApp(app, 2);
        gitInit(app);
        const run = await fakeRun(projectsDir, existingLink(app), {
            projectType: "existing",
            projectId: "cr-feature",
            tool: tools,
            turn: redesignTurn(app, true),
        });
        await codeRedesign.run(run.ctx, { action: "run", instructions: "Also add a share action to tasks." });
        assert.deepEqual(run.events.at(-1)!.payload.outsideLook, []);
        assert.match(run.turns[0].prompt, /share action/);
    });

    test("a second run continues on the same branch", async () => {
        const app = join(base, "cr-again");
        reactApp(app, 2);
        gitInit(app);
        const first = await fakeRun(projectsDir, existingLink(app), {
            projectType: "existing",
            projectId: "cr-again",
            tool: tools,
            turn: redesignTurn(app, false),
        });
        await codeRedesign.run(first.ctx, { action: "run" });
        const branch = first.events.at(-1)!.payload.branch;
        writeFileSync(join(app, "src", "styles.css"), ":root { --primary: #00aa88; }");
        git(app, "add", "-A");
        git(app, "-c", "user.name=T", "-c", "user.email=t@l", "commit", "-q", "-m", "tweak");
        const second = await fakeRun(projectsDir, existingLink(app), {
            projectType: "existing",
            projectId: "cr-again",
            tool: tools,
            turn: redesignTurn(app, false),
        });
        await codeRedesign.run(second.ctx, { action: "run" });
        assert.equal(second.events.at(-1)!.payload.branch, branch);
    });

    test("refuses a Game UI project and a missing folder", async () => {
        const run = await fakeRun(projectsDir, existingLink(join(base, "missing")), {
            projectType: "existing",
            projectId: "cr-missing",
            tool: tools,
        });
        await assert.rejects(codeRedesign.run(run.ctx, { action: "run" }), /not linked/);
        assert.equal(run.events.at(-1)!.payload.error, "not-linked");
        const game = await fakeRun(projectsDir, null, { projectType: "game", projectId: "cr-game", tool: tools });
        await assert.rejects(codeRedesign.run(game.ctx, { action: "plan" }), /Existing projects/);
    });
});

describe("game-ui-export", () => {
    const facts = {
        colors: [{ name: "Gold", path: "HUD", color: "#ffcc00", opacity: 1 }],
        typographies: [{ name: "Title", fontFamily: "Orbitron", fontSize: "48", fontWeight: "700" }],
        fonts: [{ family: "Orbitron", sizes: [48, 24], weights: ["700"] }],
        assets: [
            { id: "a-heart", name: "Icon / Heart", kind: "icon", width: 32, height: 32 },
            { id: "a-bg", name: "Menu Background", kind: "image", width: 1920, height: 1080 },
        ],
    };
    const gameTools = (name: string, args: any) => {
        switch (name) {
            case "list_boards":
                return okJson(
                    BOARDS.slice(0, 2).map((board) => ({
                        ...board,
                        name: board.id === "b-home" ? "Main Menu" : "HUD",
                        width: 1920,
                        height: 1080,
                    }))
                );
            case "capture_node_screenshot":
                return {
                    isError: false,
                    content: [{ type: "image", data: PNG_1PX.toString("base64"), mimeType: "image/png" }],
                    text: "",
                };
            case "export_shape":
                return { isError: false, content: [], text: `<svg id="${args.shapeId}"/>` };
            case "execute_code":
                return String(args.code).includes("BOARD") || String(args.code).includes("assets")
                    ? okJson({ result: facts, log: "" })
                    : { isError: true, content: [], text: "no tokens" };
            default:
                return { isError: true, content: [], text: "unavailable" };
        }
    };

    test("writes PenforgeUI with PNGs, guides, tokens, assets and README, on its own branch only", async () => {
        const game = join(base, "export-game");
        unityGame(game, 2);
        gitInit(game);
        const mainHead = git(game, "rev-parse", "main");
        const run = await fakeRun(projectsDir, gameLink(game), {
            projectType: "game",
            projectId: "export",
            tool: gameTools,
            // Claude writes one guide; the other gets the fallback
            turn: (request) => {
                const guide = join(game, "PenforgeUI", "guides", "main-menu.md");
                assert.equal(request.toolFilter!.check("Write", { file_path: guide }), null);
                assert.notEqual(
                    request.toolFilter!.check("Write", { file_path: join(game, "Assets", "UI", "Main.uxml") }),
                    null
                );
                writeFileSync(guide, "# Main Menu\n\n## Engine steps\n1. Create a UIDocument.");
                return { text: "Guides written." };
            },
        });
        await gameUiExport.run(run.ctx, { action: "run" });
        const result = run.events.at(-1)!.payload;
        assert.equal(result.action, "run");
        assert.equal(result.ui, "uitoolkit");
        const out = join(game, "PenforgeUI");
        assert.deepEqual(readdirSync(join(out, "screens")).sort(), [
            "hud.png",
            "hud@2x.png",
            "main-menu.png",
            "main-menu@2x.png",
        ]);
        assert.deepEqual(readdirSync(join(out, "guides")).sort(), ["hud.md", "main-menu.md"]);
        assert.match(readFileSync(join(out, "guides", "main-menu.md"), "utf8"), /UIDocument/);
        assert.match(readFileSync(join(out, "guides", "hud.md"), "utf8"), /# HUD/);
        const tokens = JSON.parse(readFileSync(join(out, "tokens.json"), "utf8"));
        assert.equal(tokens.colors[0].hex, "#ffcc00");
        assert.ok(existsSync(join(out, "assets", "icon-heart.svg")));
        assert.ok(existsSync(join(out, "assets", "menu-background.png")));
        assert.match(readFileSync(join(out, "fonts.md"), "utf8"), /Orbitron/);
        assert.match(readFileSync(join(out, "README.md"), "utf8"), /main-menu\.md/);
        // git: own branch, only PenforgeUI committed, the user's branch and game files untouched
        assert.ok(result.branch.startsWith("penforge/redesign-"));
        assert.equal(git(game, "rev-parse", "main"), mainHead);
        const changed = git(game, "diff", "--name-only", `${mainHead}..HEAD`).split("\n");
        assert.ok(changed.length > 0 && changed.every((path) => path.startsWith("PenforgeUI/")));
        assert.equal(git(game, "status", "--porcelain"), "");
    });

    test("without git (user's choice) it only adds PenforgeUI", async () => {
        const game = join(base, "export-nogit");
        unityGame(game, 2);
        const run = await fakeRun(projectsDir, gameLink(game), {
            projectType: "game",
            projectId: "export-nogit",
            tool: gameTools,
            answers: ["skip"],
            turn: () => ({ text: "" }),
        });
        await gameUiExport.run(run.ctx, { action: "run" });
        const result = run.events.at(-1)!.payload;
        assert.equal(result.branch, null);
        assert.equal(existsSync(join(game, ".git")), false);
        assert.equal(readdirSync(join(game, "PenforgeUI", "guides")).length, 2);
    });

    test("plan names the folder and the screens", async () => {
        const game = join(base, "export-plan");
        unityGame(game, 2);
        const run = await fakeRun(projectsDir, gameLink(game), {
            projectType: "game",
            projectId: "export-plan",
            tool: gameTools,
        });
        await gameUiExport.run(run.ctx, {});
        const plan = run.events.at(-1)!.payload;
        assert.equal(plan.folder, "PenforgeUI");
        assert.equal(plan.git, false);
        assert.equal(plan.screens.length, 2);
        assert.equal(plan.engine, "unity");
    });
});
