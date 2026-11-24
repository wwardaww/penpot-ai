import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { WorkflowClaudeRequest } from "@penpot/mcp-common";
import { type FakeRun, fakeRun, git, gitInit, okJson, PNG_1PX } from "../linked/testing/fixtures";
import { PromptRegistry } from "../prompts/promptRegistry";
import { workflow as instruct } from "../workflows/instruct";
import { WorkflowRegistry } from "../workflows/WorkflowRegistry";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { SpecFolder } from "./SpecFolder";

const isWindows = process.platform === "win32";
let base: string;
let projectsDir: string;
let output: string;

beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "penforge-instruct-")));
    projectsDir = join(base, "Penforge", "projects");
    output = join(base, "spec");
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(output);
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

const BOARDS = [
    { id: "b-home", name: "Home / Desktop", pageId: "p1", pageName: "Screens", width: 1440, height: 1024 },
    { id: "b-cart", name: "Cart", pageId: "p1", pageName: "Screens", width: 390, height: 844 },
    { id: "b-ds", name: "Buttons", pageId: "p2", pageName: "Design System", width: 800, height: 600 },
];

const FACTS = {
    colors: [{ name: "Primary", path: "Brand", color: "#3355ff", opacity: 1 }],
    typographies: [{ name: "Title", fontFamily: "Inter", fontSize: "32", fontWeight: "700" }],
    fonts: [{ family: "Inter", sizes: [32, 14], weights: ["700"] }],
    assets: [{ id: "a-logo", name: "Logo", kind: "icon", width: 32, height: 32 }],
};

/** Penpot tools of the test file; `failing` captures fail on every try. */
function tools(failing: string[] = []) {
    return (name: string, args: any) => {
        switch (name) {
            case "list_boards":
                return okJson(BOARDS);
            case "capture_node_screenshot":
                return failing.includes(args.nodeId)
                    ? { isError: true, content: [], text: "no" }
                    : {
                          isError: false,
                          content: [{ type: "image", data: PNG_1PX.toString("base64"), mimeType: "image/png" }],
                          text: "",
                      };
            case "export_shape":
                return { isError: false, content: [], text: "<svg/>" };
            case "execute_code":
                return String(args.code).includes("b-home")
                    ? okJson({ result: FACTS, log: "" })
                    : { isError: true, content: [], text: "no tokens" };
            case "get_prototype_graph":
                return okJson({
                    edges: [{ from: "b-home", to: "b-cart", trigger: "click", sourceName: "Cart button" }],
                });
            case "get_animation_spec":
                return okJson({ fileId: args.fileId, pages: [{ boards: [{ boardId: "b-home", layers: [] }] }] });
            default:
                return { isError: true, content: [], text: "unavailable" };
        }
    };
}

/** Claude writes the guide of the screens it is asked for (through the tool filter). */
function guideTurn(only?: string) {
    return (request: WorkflowClaudeRequest) => {
        for (const match of request.prompt.matchAll(/→ (.+\.md)$/gm)) {
            assert.equal(request.toolFilter!.check("Write", { file_path: match[1] }), null);
            if (!only || match[1].includes(only)) {
                writeFileSync(match[1], "# Guide by Claude\n");
            }
        }
        return { text: "done" };
    };
}

async function run(options: Parameters<typeof fakeRun>[2]): Promise<FakeRun> {
    const started = await fakeRun(projectsDir, null, options);
    (started.ctx.workspace as ProjectWorkspace).setOutput({ outputRoot: output, appRoot: null, outputAt: "" });
    return started;
}

function result(started: FakeRun): any {
    return started.events.filter((event) => event.kind === "result").at(-1)?.payload;
}

function list(root: string, prefix = ""): string[] {
    return readdirSync(join(root, prefix), { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory() ? list(root, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
        .sort();
}

describe("instruct", () => {
    test("is a shipped workflow with a prompt for web and mobile", () => {
        assert.ok(WorkflowRegistry.withShippedWorkflows().names().includes("instruct"));
        const build = (platform: "web" | "mobile") =>
            PromptRegistry.locate().build({ persona: "designer", platform, projectName: "P", workflow: "instruct" });
        assert.ok(build("web").includes("**Breakpoints**"));
        assert.ok(!build("web").includes("safe areas**"));
        assert.ok(build("mobile").includes("safe areas**"));
        assert.ok(!build("mobile").includes("**Breakpoints**"));
    });

    test("writes a PNG and a guide for every board, and only below PenforgeUI", async () => {
        const started = await run({ projectType: "web", tool: tools(), turn: guideTurn() });

        await instruct.run(started.ctx, { action: "run" });

        assert.deepEqual(readdirSync(output), ["PenforgeUI"]);
        assert.deepEqual(list(join(output, "PenforgeUI")), [
            ".penforge-ui.json",
            "README.md",
            "assets/logo.png",
            "assets/logo.svg",
            "fonts.md",
            "guides/cart.md",
            "guides/home-desktop.md",
            "screens/cart.png",
            "screens/cart@2x.png",
            "screens/home-desktop.png",
            "screens/home-desktop@2x.png",
            "tokens.json",
        ]);
        const done = result(started);
        assert.equal(done.folder, join(output, "PenforgeUI"));
        assert.deepEqual(
            done.screens.map((screen: any) => [screen.name, screen.captured]),
            [
                ["Home / Desktop", true],
                ["Cart", true],
            ]
        );
        assert.equal(done.assets, 1);
        assert.deepEqual(done.kept, []);
        const readme = readFileSync(join(output, "PenforgeUI", "README.md"), "utf8");
        assert.match(readme, /responsive web app/);
        assert.match(readme, /Cart button \(click\) → \[Cart\]\(guides\/cart\.md\)/);
        assert.equal(
            JSON.parse(readFileSync(join(output, "PenforgeUI", "tokens.json"), "utf8")).generator,
            "penforge-instruct"
        );
        // no git, no app, nothing staged left behind
        assert.equal(existsSync(join(output, ".git")), false);
        const workspace = started.ctx.workspace as ProjectWorkspace;
        assert.equal(existsSync(join(workspace.metaDir, "instruct")), false);
        assert.equal(workspace.appSrcDir, workspace.internalAppDir);
        assert.deepEqual(started.questions, []);
    });

    test("Claude reads the design and writes guides in the project folder only", async () => {
        const started = await run({ projectType: "mobile", tool: tools(), turn: guideTurn() });
        await instruct.run(started.ctx, { action: "run" });

        assert.equal(started.turns.length, 1);
        const request = started.turns[0];
        assert.equal(request.promptName, "instruct");
        assert.match(request.prompt, /flows\.json/);
        assert.match(request.prompt, /animations\.json/);
        assert.ok(!request.prompt.includes(output), "Claude never gets the user's folder");
        const filter = request.toolFilter!;
        assert.notEqual(filter.check("Write", { file_path: join(output, "PenforgeUI", "guides", "x.md") }), null);
        assert.notEqual(filter.check("Write", { file_path: join(base, "x.md") }), null);
        assert.notEqual(filter.check("Bash", { command: "npm install" }), null);
        assert.notEqual(filter.check("mcp__penpot__execute_code", {}), null);
        assert.equal(filter.check("mcp__penpot__get_node_properties", {}), null);
        assert.ok(
            !started.calls.some((call) => ["update_design_node", "update_animations"].includes(call.name)),
            "the design does not change"
        );
    });

    test("a missing guide gets a short one, a failed capture is tried again and reported", async () => {
        const started = await run({ projectType: "web", tool: tools(["b-cart"]), turn: guideTurn("cart") });
        await instruct.run(started.ctx, { action: "run" });

        const guide = readFileSync(join(output, "PenforgeUI", "guides", "home-desktop.md"), "utf8");
        assert.match(guide, /Cart button \(click\) opens "Cart"/);
        assert.deepEqual(
            result(started).screens.map((screen: any) => screen.captured),
            [true, false]
        );
        const captures = started.calls.filter(
            (call) => call.name === "capture_node_screenshot" && call.args.nodeId === "b-cart"
        );
        assert.equal(captures.length, 4);
    });

    test("many screens are written in several turns", async () => {
        const many = Array.from({ length: 14 }, (_, n) => ({ ...BOARDS[0], id: `b-${n}`, name: `Screen ${n}` }));
        const tool = (name: string, args: any) => (name === "list_boards" ? okJson(many) : tools()(name, args));
        const started = await run({ projectType: "web", tool, turn: guideTurn() });
        await instruct.run(started.ctx, { action: "run" });
        assert.equal(started.turns.length, 3);
        assert.equal(readdirSync(join(output, "PenforgeUI", "guides")).length, 14);
    });

    test("a new run keeps what the user added or changed", async () => {
        const first = await run({ projectType: "web", tool: tools(), turn: guideTurn() });
        await instruct.run(first.ctx, { action: "run" });
        const folder = join(output, "PenforgeUI");
        writeFileSync(join(output, "my-notes.txt"), "mine");
        writeFileSync(join(folder, "guides", "my-guide.md"), "mine");
        writeFileSync(join(folder, "guides", "cart.md"), "changed by the user");
        // Cart leaves the design
        const tool = (name: string, args: any) => (name === "list_boards" ? okJson([BOARDS[0]]) : tools()(name, args));

        const second = await run({ projectType: "web", tool, turn: guideTurn() });
        await instruct.run(second.ctx, { action: "run" });

        assert.equal(readFileSync(join(output, "my-notes.txt"), "utf8"), "mine");
        assert.equal(readFileSync(join(folder, "guides", "my-guide.md"), "utf8"), "mine");
        assert.equal(existsSync(join(folder, "guides", "cart.md")), false);
        assert.equal(existsSync(join(folder, "screens", "cart.png")), false);
        assert.deepEqual(result(second).kept, ["guides/cart.md"]);
        const [stamp] = readdirSync(join(folder, "kept"));
        assert.equal(readFileSync(join(folder, "kept", stamp, "guides", "cart.md"), "utf8"), "changed by the user");
        assert.equal(existsSync(join(folder, "guides", "home-desktop.md")), true);
    });

    test("a stopped run leaves the folder as it was", async () => {
        const started = await run({
            projectType: "web",
            tool: tools(),
            turn: () => {
                (started.ctx.signal as { aborted: boolean }).aborted = true;
                throw new Error("cancelled");
            },
        });
        await assert.rejects(Promise.resolve(instruct.run(started.ctx, { action: "run" })));
        assert.deepEqual(readdirSync(output), []);
    });

    test("no git command touches a repository around the folder", async () => {
        const repo = join(base, "repo");
        mkdirSync(join(repo, "spec"), { recursive: true });
        writeFileSync(join(repo, "a.txt"), "x");
        gitInit(repo);
        output = join(repo, "spec");
        const head = git(repo, "rev-parse", "HEAD");
        const started = await run({ projectType: "web", tool: tools(), turn: guideTurn() });
        await instruct.run(started.ctx, { action: "run" });
        assert.equal(git(repo, "rev-parse", "HEAD"), head);
        assert.equal(git(repo, "status", "--porcelain"), "?? spec/");
        assert.equal(git(repo, "branch", "--list"), "* main");
    });

    test("plan lists the screens and the folder and writes nothing", async () => {
        const started = await run({ projectType: "web", tool: tools() });
        await instruct.run(started.ctx, {});
        assert.equal(result(started).folder, join(output, "PenforgeUI"));
        assert.equal(result(started).screens.length, 2);
        assert.deepEqual(readdirSync(output), []);
    });

    test("refuses without a folder, with a missing or foreign one, and for other project types", async () => {
        const code = async (started: FakeRun) => {
            await assert.rejects(Promise.resolve(instruct.run(started.ctx, { action: "run" })));
            return result(started).error;
        };
        const none = await fakeRun(projectsDir, null, { projectType: "web", tool: tools() });
        assert.equal(await code(none), "no-folder");
        assert.equal(await code(await run({ projectType: "game", tool: tools() })), "wrong-type");

        mkdirSync(join(output, "PenforgeUI"));
        writeFileSync(join(output, "PenforgeUI", "mine.txt"), "mine");
        assert.equal(await code(await run({ projectType: "web", tool: tools() })), "folder-taken");
        assert.deepEqual(list(output), ["PenforgeUI/mine.txt"]);

        const root = output;
        output = join(base, "missing");
        assert.equal(await code(await run({ projectType: "web", tool: tools() })), "folder-missing");
        output = projectsDir;
        assert.equal(await code(await run({ projectType: "web", tool: tools() })), "folder-refused");
        output = root;

        const empty = await run({ projectType: "web", tool: () => okJson([]) });
        rmSync(join(output, "PenforgeUI"), { recursive: true, force: true });
        assert.equal(await code(empty), "no-screens");
    });
});

describe("SpecFolder", () => {
    let staging: string;

    beforeEach(() => {
        staging = join(base, "staging");
        mkdirSync(join(staging, "guides"), { recursive: true });
        writeFileSync(join(staging, "guides", "a.md"), "new");
    });

    test("never writes to a PenforgeUI of another project or of the user", async () => {
        const folder = join(output, "PenforgeUI");
        await new SpecFolder(folder, "project-a").publish(staging);
        await assert.rejects(new SpecFolder(folder, "project-b").publish(staging));
        assert.equal(SpecFolder.isOwn(folder, "project-a"), true);
        assert.equal(SpecFolder.isOwn(folder, "project-b"), false);
    });

    test("a tampered manifest deletes nothing outside the folder", async () => {
        const folder = join(output, "PenforgeUI");
        await new SpecFolder(folder, "project-a").publish(staging);
        writeFileSync(join(output, "mine.txt"), "mine");
        const manifest = JSON.parse(readFileSync(join(folder, ".penforge-ui.json"), "utf8"));
        const hash = "e".repeat(64);
        manifest.files = { "../mine.txt": hash, "/etc/passwd": hash, "a/../../mine.txt": hash, "c:\\x": hash };
        writeFileSync(join(folder, ".penforge-ui.json"), JSON.stringify(manifest));

        await new SpecFolder(folder, "project-a").publish(staging);

        assert.equal(readFileSync(join(output, "mine.txt"), "utf8"), "mine");
    });

    test("a link in the folder is never written through", async () => {
        const folder = join(output, "PenforgeUI");
        await new SpecFolder(folder, "project-a").publish(staging);
        const outside = join(base, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, "a.md"), "theirs");
        rmSync(join(folder, "guides"), { recursive: true });
        symlinkSync(outside, join(folder, "guides"), isWindows ? "junction" : "dir");

        await assert.rejects(new SpecFolder(folder, "project-a").publish(staging));
        assert.equal(readFileSync(join(outside, "a.md"), "utf8"), "theirs");

        rmSync(join(output, "PenforgeUI"), { recursive: true, force: true });
        symlinkSync(outside, join(output, "PenforgeUI"), isWindows ? "junction" : "dir");
        await assert.rejects(new SpecFolder(folder, "project-a").publish(staging));
        assert.deepEqual(readdirSync(outside), ["a.md"]);
    });
});
