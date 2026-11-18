import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Persona, WorkflowClaudeRequest, WorkflowContext, WorkflowEventKind } from "@penpot/mcp-common";
import { BuildLock } from "../build/BuildLock";
import { VisualQaHost, type VisualQaServices } from "../qa/QaRun";
import { VisualQaFlow } from "../qa/VisualQaFlow";
import {
    FakeBrowser,
    FakePenpot,
    FakePreviews,
    renderScreen,
    SCREENS,
    screenCss,
    type ScreenLook,
} from "../qa/testing/fakes";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { workflow } from "./visual-qa";

const HOME_DESIGN: ScreenLook = { headerColor: "#222222", buttonColor: "#3366ff", buttonTop: 200 };
const LOGIN_DESIGN: ScreenLook = { headerColor: "#222222", buttonColor: "#22aa55", buttonTop: 200 };
/** the deliberate CSS mismatch of the built app: wrong button colour and position */
const HOME_SEEDED: ScreenLook = { headerColor: "#222222", buttonColor: "#ff3333", buttonTop: 120 };

let projectsDir: string;
let workspace: ProjectWorkspace;
let penpot: FakePenpot;
let browser: FakeBrowser;
let previews: FakePreviews;
let services: VisualQaServices;

function appFile(name: string): string {
    return join(workspace.appSrcDir, "src", name);
}

function writeLook(screen: "home" | "login", look: ScreenLook): void {
    mkdirSync(join(workspace.appSrcDir, "src"), { recursive: true });
    writeFileSync(appFile(`${screen}.css`), screenCss(look));
}

function gitLog(): string[] {
    return execFileSync("git", ["log", "--format=%s"], { cwd: workspace.appSrcDir, encoding: "utf8" })
        .trim()
        .split("\n");
}

async function writeMap(fileId = "file-1"): Promise<void> {
    await workspace.writeJson("map.json", {
        schemaVersion: 1,
        builtAt: "2026-11-18T10:00:00.000Z",
        fileId,
        commit: null,
        boards: {
            [SCREENS.home.boardId]: { name: "Home", hash: "h1", route: "/", files: ["src/home.css"] },
            [SCREENS.login.boardId]: { name: "Login", hash: "h2", route: "/login", files: ["src/login.css"] },
            "board-logo": { name: "Logo", hash: "h3", route: null, files: [] },
        },
    });
}

beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-qa-"));
    workspace = new ProjectWorkspace(projectsDir, "project-1");
    await workspace.ensure();
    writeLook("home", HOME_SEEDED);
    writeLook("login", LOGIN_DESIGN);
    await workspace.commitAll("app-src", "penforge(build): build app");
    await writeMap();
    await workspace.writeJson("qa.json", { threshold: 95, reloadDelayMs: 0, settleMs: 0 });
    penpot = new FakePenpot({
        [SCREENS.home.boardId]: await renderScreen(HOME_DESIGN),
        [SCREENS.login.boardId]: await renderScreen(LOGIN_DESIGN),
    });
    browser = new FakeBrowser(workspace.appSrcDir);
    previews = new FakePreviews();
    services = {
        previews,
        browsers: browser,
        clientForMcpSession: async () => null,
    };
    VisualQaHost.install(services);
});

afterEach(async () => {
    await VisualQaHost.shutdown(services);
    rmSync(projectsDir, { recursive: true, force: true });
});

interface Harness {
    ctx: WorkflowContext;
    events: { kind: WorkflowEventKind; payload: any }[];
    turns: WorkflowClaudeRequest[];
}

interface HarnessOptions {
    /** answer to every question (default "fix") */
    answer?: string;
    /** aborts the run while Claude works on the given turn */
    abortOnTurn?: number;
}

function harness(
    onTurn: (request: WorkflowClaudeRequest, n: number) => void = () => {},
    persona: Persona = "designer",
    options: HarnessOptions = {}
): Harness & { questions: string[] } {
    const abort = new AbortController();
    const questions: string[] = [];
    const events: Harness["events"] = [];
    const turns: WorkflowClaudeRequest[] = [];
    const ctx: WorkflowContext = {
        runId: "run-1",
        context: {
            fileId: "file-1",
            fileName: "Shop",
            projectId: "project-1",
            teamId: "team-1",
            pageId: "page-1",
            persona,
            platform: "mobile",
        },
        runner: {
            run: async (request) => {
                turns.push(request);
                onTurn(request, turns.length);
                if (options.abortOnTurn === turns.length) {
                    abort.abort();
                    throw new Error("cancelled");
                }
                return { text: "Changed the button.", sessionId: "claude-session-1" };
            },
        },
        tools: penpot,
        workspace,
        signal: abort.signal,
        emit: (kind, payload) => events.push({ kind, payload }),
        ask: async (question) => {
            questions.push(question.text);
            return options.answer ?? "fix";
        },
    };
    return { ctx, events, turns, questions };
}

function result(events: Harness["events"]): any {
    return events.filter((event) => event.kind === "result").at(-1)?.payload;
}

describe("visual-qa check", () => {
    test("scores every built screen and saves design, app and heatmap images", async () => {
        const { ctx, events, turns } = harness();

        const done = await workflow.run(ctx, {});

        const payload = result(events);
        assert.equal(payload.mode, "check");
        assert.equal(payload.threshold, 95);
        assert.deepEqual(
            payload.screens.map((s: any) => [s.name, s.route, s.width, s.height]),
            [
                ["Home", "/", 200, 300],
                ["Login", "/login", 200, 300],
            ]
        );
        const [home, login] = payload.screens;
        assert.ok(home.score < 95, `home score ${home.score}`);
        assert.equal(home.passed, false);
        assert.equal(login.score, 100);
        assert.equal(login.passed, true);
        assert.equal(payload.passed, false);
        assert.ok(home.images.design.startsWith("data:image/png;base64,"));
        assert.ok(home.images.diff.startsWith("data:image/png;base64,"));
        // designers get no file paths
        assert.equal(home.paths, undefined);
        assert.equal(turns.length, 0, "a check never asks Claude");
        assert.match(done!.summary, /1 of 2 screens match/);

        const runDir = join(workspace.metaDir, "qa", payload.runName);
        const files = readdirSync(runDir).sort();
        assert.equal(files.filter((f) => f.endsWith(".png")).length, 6);
        assert.ok(files.includes("report.json"));
        const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
        assert.equal(report.screens[0].images, undefined, "previews stay out of report.json");

        // the app is opened at the board size, through the dev server URL
        assert.deepEqual(
            browser.shots.map((shot) => [shot.url, shot.width, shot.height]),
            [
                ["http://127.0.0.1:5299/", 200, 300],
                ["http://127.0.0.1:5299/login", 200, 300],
            ]
        );
        assert.equal(browser.closed, 1);
        assert.equal(previews.released, 1);
        assert.deepEqual(
            penpot.calls.filter((c) => c.name === "capture_node_screenshot").map((c) => c.args.scale),
            [1, 1]
        );
        assert.ok(events.some((e) => e.kind === "progress" && e.payload.step === "compare"));
    });

    test("developers also get the image paths, relative to the project", async () => {
        const { ctx, events } = harness(() => {}, "developer");

        await workflow.run(ctx, { boardIds: [SCREENS.home.boardId] });

        const [home] = result(events).screens;
        assert.equal(result(events).screens.length, 1);
        assert.match(home.paths.diff, /^\.penforge\/qa\/\d{8}T\d{6}-[0-9a-f]{4}\/home-.*-diff\.png$/);
        assert.ok(existsSync(join(workspace.root, home.paths.app)));
    });

    test("skips screens with a foreign route or a broken size", async () => {
        await workspace.writeJson("map.json", {
            schemaVersion: 1,
            builtAt: "x",
            fileId: "file-1",
            commit: null,
            boards: {
                [SCREENS.home.boardId]: { name: "Home", hash: "h1", route: "//evil.test/x", files: [] },
                [SCREENS.login.boardId]: { name: "Login", hash: "h2", route: "/login", files: [] },
            },
        });
        penpot.sizes[SCREENS.login.boardId] = { width: "wide", height: 300 };
        const { ctx, events } = harness();

        await assert.rejects(workflow.run(ctx, {}));

        assert.equal(events.find((e) => e.kind === "failed")?.payload.code, "no-screens");
        assert.equal(browser.shots.length, 0);
    });

    test("compares at most maxScreens screens", async () => {
        await workspace.writeJson("qa.json", { threshold: 95, reloadDelayMs: 0, settleMs: 0, maxScreens: 1 });
        const { ctx, events } = harness();

        const done = await workflow.run(ctx, {});

        const payload = result(events);
        assert.equal(payload.screens.length, 1);
        assert.deepEqual(
            payload.skippedScreens.map((s: any) => [s.name, s.reason]),
            [["Login", "limit"]]
        );
        assert.equal(payload.limit, "screens");
        assert.match(done!.summary, /stopped at the limit of screens per check/);
    });

    test("reports a project that was not built", async () => {
        rmSync(join(workspace.metaDir, "map.json"));
        const { ctx, events } = harness();

        await assert.rejects(workflow.run(ctx, {}), /not been built/);

        assert.deepEqual(events.find((e) => e.kind === "failed")?.payload.code, "not-built");
        assert.equal(previews.acquired, 0);
    });

    test("refuses an app built from another file", async () => {
        await writeMap("file-2");
        const { ctx, events } = harness();

        await assert.rejects(workflow.run(ctx, {}));

        assert.equal(events.find((e) => e.kind === "failed")?.payload.code, "other-file");
    });

    test("fails fast while a build holds the project lock", async () => {
        const release = BuildLock.tryAcquire(workspace.root)!;
        try {
            const { ctx, events } = harness();
            await assert.rejects(workflow.run(ctx, {}));
            assert.equal(events.find((e) => e.kind === "failed")?.payload.code, "busy");
        } finally {
            release();
        }
        // the lock is free again after a run
        const { ctx } = harness();
        await workflow.run(ctx, {});
        const again = BuildLock.tryAcquire(workspace.root);
        assert.ok(again);
        again();
    });
});

describe("visual-qa fix", () => {
    test("fixes the seeded CSS mismatch, raises the score and commits", async () => {
        const { ctx, events, turns } = harness(() => writeLook("home", HOME_DESIGN));

        const done = await workflow.run(ctx, { mode: "fix" });

        const payload = result(events);
        const home = payload.screens.find((s: any) => s.name === "Home");
        assert.ok(home.before < 95, `before ${home.before}`);
        assert.equal(home.score, 100);
        assert.equal(home.passed, true);
        assert.equal(home.attempts, 1);
        assert.equal(payload.passed, true);
        assert.match(done!.summary, /2 of 2 screens match/);
        assert.ok(payload.commit);
        assert.equal(gitLog()[0], "penforge(qa): match Home to the design");

        // one Claude turn, for the failing screen only, with the three images and the files
        assert.equal(turns.length, 1);
        const [turn] = turns;
        assert.equal(turn.promptName, "visual-qa");
        assert.equal(turn.attachments?.length, 3);
        assert.ok(turn.attachments?.every((a) => a.kind === "image"));
        assert.match(turn.prompt, /src\/home\.css/);
        assert.match(turn.prompt, /viewport 200×300/);
        // Claude may change the code only, never the design
        const filter = turn.toolFilter!;
        assert.notEqual(filter.check("mcp__penpot__execute_code", {}), null);
        assert.notEqual(filter.check("mcp__penpot__update_design_node", {}), null);
        assert.equal(filter.check("mcp__penpot__get_node_properties", {}), null);
        assert.equal(filter.check("Edit", { file_path: appFile("home.css") }), null);
        assert.notEqual(filter.check("Write", { file_path: join(workspace.designDir, "DESIGN.md") }), null);
        assert.notEqual(filter.check("Bash", { command: "npm test" }), null);

        // the images of the first check are kept next to the latest ones
        const runDir = join(workspace.metaDir, "qa", payload.runName);
        assert.ok(readdirSync(runDir).some((f) => f.endsWith("-app-before.png")));
        assert.ok(events.some((e) => e.kind === "progress" && e.payload.step === "fix"));
    });

    test("undoes a change that does not raise the score", async () => {
        const { ctx, events, turns } = harness(() => writeLook("home", { ...HOME_SEEDED, headerColor: "#00ff00" }));

        await workflow.run(ctx, { mode: "fix", maxIterations: 3 });

        assert.equal(turns.length, 1, "a change that does not help ends the loop");
        // git may check the file out with CRLF (core.autocrlf on Windows)
        assert.equal(readFileSync(appFile("home.css"), "utf8").replace(/\r\n/g, "\n"), screenCss(HOME_SEEDED));
        const home = result(events).screens.find((s: any) => s.name === "Home");
        assert.equal(home.score, home.before ?? home.score);
        assert.equal(result(events).commit, null);
        assert.equal(gitLog()[0].startsWith("penforge(qa)"), false);
        assert.ok(events.some((e) => e.kind === "log" && e.payload.code === "fix-reverted"));
    });

    test("stops a screen after maxIterations turns", async () => {
        // each turn fixes the colour and moves the button 30 px closer, never reaching the design
        const { ctx, events, turns } = harness((_request, n) =>
            writeLook("home", { ...HOME_DESIGN, buttonTop: HOME_SEEDED.buttonTop + 30 * n })
        );

        await workflow.run(ctx, { mode: "fix", maxIterations: 2 });

        assert.equal(turns.length, 2);
        // every try is a fresh session with only the current images
        assert.equal(turns[1].resumeSessionId, undefined);
        assert.equal(turns[1].attachments?.length, 3);
        assert.match(turns[1].prompt, /try 1 raised the score/);
        const home = result(events).screens.find((s: any) => s.name === "Home");
        assert.equal(home.attempts, 2);
        assert.ok(home.score > home.before);
        assert.equal(home.passed, false);
        assert.ok(result(events).commit);
    });
});

describe("visual-qa settings", () => {
    test("an automatic run after a build is skipped unless turned on", async () => {
        const first = harness();
        await workflow.run(first.ctx, { trigger: "build" });
        assert.equal(result(first.events).skipped, true);
        assert.equal(previews.acquired, 0);

        const settings = harness();
        await workflow.run(settings.ctx, { mode: "settings", settings: { autoRunAfterBuild: true } });
        assert.equal(result(settings.events).settings.autoRunAfterBuild, true);
        assert.equal(JSON.parse(readFileSync(join(workspace.metaDir, "qa.json"), "utf8")).threshold, 95);

        const second = harness();
        await workflow.run(second.ctx, { trigger: "build" });
        assert.equal(result(second.events).skipped, undefined);
        assert.equal(result(second.events).trigger, "build");
        assert.equal(result(second.events).screens.length, 2);
    });

    test("accept marks the run's report", async () => {
        const check = harness();
        await workflow.run(check.ctx, {});
        const runName = result(check.events).runName;

        const accept = harness();
        await workflow.run(accept.ctx, { mode: "accept", runName });

        const report = JSON.parse(readFileSync(join(workspace.metaDir, "qa", runName, "report.json"), "utf8"));
        assert.ok(report.acceptedAt);
        await assert.rejects(workflow.run(harness().ctx, { mode: "accept", runName: "../../x" }));
    });
});

describe("visual-qa limits and safety", () => {
    /** Makes both screens fail: Login gets the wrong colour too. */
    async function bothFailing(): Promise<void> {
        writeLook("login", { ...LOGIN_DESIGN, buttonColor: "#ff3333", buttonTop: 120 });
        await workspace.commitAll("app-src", "penforge(build): login");
    }

    test("stops fixing when the run's Claude turns are spent", async () => {
        await bothFailing();
        await workspace.writeJson("qa.json", { threshold: 95, reloadDelayMs: 0, settleMs: 0, maxClaudeTurns: 1 });
        // every turn helps a bit, so only the turn limit ends the loop
        const { ctx, events, turns } = harness((_request, n) =>
            writeLook("home", { ...HOME_DESIGN, buttonTop: HOME_SEEDED.buttonTop + 30 * n })
        );

        const done = await workflow.run(ctx, { mode: "fix" });

        assert.equal(turns.length, 1);
        assert.equal(result(events).limit, "turns");
        assert.equal(result(events).claudeTurns, 1);
        assert.match(done!.summary, /stopped at the limit of AI fix turns/);
    });

    test("stops fixing when the run's time is up", async () => {
        let clock = 0;
        const { ctx, events, turns } = harness(() => {
            writeLook("home", { ...HOME_DESIGN, buttonTop: 150 });
            clock += 21 * 60_000;
        });

        await new VisualQaFlow(
            ctx,
            async () => {},
            () => clock
        ).run({ mode: "fix", maxIterations: 3 });

        assert.equal(turns.length, 1);
        assert.equal(result(events).limit, "time");
    });

    test("asks before fixing an app with uncommitted changes and can only check", async () => {
        writeFileSync(join(workspace.appSrcDir, "notes.txt"), "my own edit\n");
        const { ctx, events, turns, questions } = harness(() => writeLook("home", HOME_DESIGN), "designer", {
            answer: "check",
        });

        await workflow.run(ctx, { mode: "fix" });

        assert.equal(questions.length, 1);
        assert.match(questions[0], /1 changed file/);
        assert.equal(turns.length, 0);
        assert.equal(result(events).mode, "check");
    });

    test("commits only the files the fix changed", async () => {
        const { ctx, events } = harness(() => writeLook("home", HOME_DESIGN));

        await workflow.run(ctx, { mode: "fix" });

        const files = execFileSync("git", ["show", "--name-only", "--format=", result(events).commit], {
            cwd: workspace.appSrcDir,
            encoding: "utf8",
        })
            .trim()
            .split("\n");
        assert.deepEqual(files, ["src/home.css"]);
    });

    test("stopping during a fix puts the code back", async () => {
        const { ctx, turns } = harness(
            () => writeLook("home", { ...HOME_SEEDED, buttonColor: "#000000" }),
            "designer",
            {
                abortOnTurn: 1,
            }
        );

        await assert.rejects(workflow.run(ctx, { mode: "fix" }), /cancelled/);

        assert.equal(turns.length, 1);
        assert.equal(readFileSync(appFile("home.css"), "utf8").replace(/\r\n/g, "\n"), screenCss(HOME_SEEDED));
        assert.equal(VisualQaHost.openRuns, 0);
        assert.equal(browser.closed, 1);
        assert.equal(previews.released, 1);
    });
});
