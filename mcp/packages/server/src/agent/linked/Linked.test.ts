import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { DaemonMessage } from "@penpot/mcp-common";
import type { AgentClient } from "../AgentClient";
import { ClientMessageSchema } from "../ClientMessageSchema";
import { WorkspaceManager } from "../workspace/WorkspaceManager";
import { workflow as projectRead } from "../workflows/project-read";
import { FolderInspector } from "./FolderInspector";
import { GitIgnore } from "./GitIgnore";
import { LinkedFolders, LinkRefusal } from "./LinkedFolders";
import { LinkedProjectPrompt } from "./LinkedProjectPrompt";
import { LinkService } from "./LinkService";
import { LookGuard } from "./LookGuard";
import type { ProjectLink } from "./ProjectLink";
import { ProjectTypes } from "./ProjectTypes";
import { SourceInventory } from "./SourceInventory";
import { fakeRun, reactApp, unityGame, unrealGame, writeTree } from "./testing/fixtures";

let base: string;
let penforgeHome: string;
let projectsDir: string;
let unity: string;
let unreal: string;
let react: string;
let empty: string;

before(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "penforge-linked-")));
    penforgeHome = join(base, "Penforge");
    projectsDir = join(penforgeHome, "projects");
    mkdirSync(projectsDir, { recursive: true });
    unity = join(base, "work", "StarMiner");
    unreal = join(base, "work", "Skyfall");
    react = join(base, "work", "tasks-app");
    empty = join(base, "work", "empty");
    unityGame(unity);
    unrealGame(unreal);
    reactApp(react);
    mkdirSync(empty, { recursive: true });
    mkdirSync(join(base, "work", ".hidden"), { recursive: true });
});

after(() => {
    rmSync(base, { recursive: true, force: true });
});

class FakeClient implements AgentClient {
    public readonly id = "client-1";
    public readonly sent: DaemonMessage[] = [];
    public readonly closed = new AbortController().signal;
    public send(message: DaemonMessage): void {
        this.sent.push(message);
    }
    public setup(): never {
        throw new Error("not used");
    }
}

function link(kind: ProjectLink["kind"], root: string, extra: Partial<ProjectLink> = {}): ProjectLink {
    return { kind, root, engine: null, stack: null, linkedAt: "2026-11-21T00:00:00.000Z", ...extra };
}

describe("FolderInspector", () => {
    test("tells Unity, Unreal, a React app and an empty folder apart", async () => {
        const inspector = new FolderInspector();
        const unityFacts = await inspector.facts(unity);
        assert.equal(unityFacts.engine, "unity");
        assert.equal(unityFacts.unity, true);
        const unrealFacts = await inspector.facts(unreal);
        assert.equal(unrealFacts.engine, "unreal");
        assert.equal(unrealFacts.uproject, "Skyfall.uproject");
        assert.ok(unrealFacts.markers.includes("*.uproject"));
        const reactFacts = await inspector.facts(react);
        assert.equal(reactFacts.engine, null);
        assert.deepEqual(reactFacts.stack, { platform: "web", name: "react" });
        assert.ok(reactFacts.markers.includes("package.json"));
        assert.ok(reactFacts.markers.includes("DESIGN.md"));
        const emptyFacts = await inspector.facts(empty);
        assert.equal(emptyFacts.empty, true);
        assert.equal(emptyFacts.stack, null);
    });

    test("detects mobile stacks", async () => {
        const expo = join(base, "work", "expo-app");
        writeTree(expo, { "package.json": JSON.stringify({ dependencies: { expo: "51", "react-native": "0.74" } }) });
        const flutter = join(base, "work", "flutter-app");
        writeTree(flutter, { "pubspec.yaml": "name: app" });
        const inspector = new FolderInspector();
        assert.deepEqual((await inspector.facts(expo)).stack, { platform: "mobile", name: "expo" });
        assert.deepEqual((await inspector.facts(flutter)).stack, { platform: "mobile", name: "flutter" });
    });
});

describe("LinkedFolders", () => {
    const folders = () => new LinkedFolders(penforgeHome);

    test("lists the roots with the home folder", async () => {
        const reply = await folders().list("r1", undefined);
        assert.equal(reply.path, null);
        assert.ok(reply.roots.some((root) => root.kind === "home" && root.path === homedir()));
        assert.ok(reply.roots.some((root) => root.kind === "drive"));
    });

    test("lists sub-folders by name, hidden ones skipped, with the folder's facts", async () => {
        const reply = await folders().list("r2", join(base, "work"));
        const names = reply.entries.map((entry) => entry.name);
        assert.ok(names.includes("StarMiner") && names.includes("tasks-app"));
        assert.ok(!names.includes(".hidden"));
        assert.deepEqual(
            names,
            [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))
        );
        assert.equal(reply.parent, base);
        const game = await folders().list("r3", unity);
        assert.equal(game.facts?.engine, "unity");
        assert.ok(game.entries.every((entry) => !("size" in entry)));
    });

    test("refuses relative, missing and file paths", async () => {
        await assert.rejects(
            folders().list("r", "work/StarMiner"),
            (error: LinkRefusal) => error.refusal === "bad-path"
        );
        await assert.rejects(
            folders().list("r", join(base, "nope")),
            (error: LinkRefusal) => error.refusal === "folder-missing"
        );
        await assert.rejects(
            folders().list("r", join(unity, "README.md")),
            (error: LinkRefusal) => error.refusal === "not-a-folder"
        );
    });

    test("refuses roots, the home folder and the Penforge home for a link", async () => {
        const f = folders();
        await assert.rejects(
            f.accept("existing", homedir()),
            (error: LinkRefusal) => error.refusal === "folder-refused"
        );
        await assert.rejects(
            f.accept("existing", penforgeHome),
            (error: LinkRefusal) => error.refusal === "folder-refused"
        );
        await assert.rejects(
            f.accept("existing", projectsDir),
            (error: LinkRefusal) => error.refusal === "folder-refused"
        );
        // a folder that holds the Penforge home
        await assert.rejects(f.accept("existing", base), (error: LinkRefusal) => error.refusal === "folder-refused");
        assert.equal(f.isRefusedRoot(process.platform === "win32" ? "C:\\" : "/"), true);
        assert.equal(
            new LinkedFolders("C:\\Users\\me\\Penforge", "C:\\Users\\me", "win32", {
                SystemRoot: "C:\\Windows",
            }).isRefusedRoot("C:\\Windows\\System32"),
            true
        );
        assert.equal(
            new LinkedFolders("C:\\Users\\me\\Penforge", "C:\\Users\\me", "win32", {}).isRefusedRoot(
                "C:\\Program Files\\Game"
            ),
            true
        );
        assert.equal(
            new LinkedFolders("C:\\Users\\me\\Penforge", "C:\\Users\\me", "win32", {}).isRefusedRoot("D:\\Games\\Mine"),
            false
        );
    });

    test("refuses a non-game folder for Game UI and an empty folder for Existing project", async () => {
        await assert.rejects(
            folders().accept("game", react),
            (error: LinkRefusal) => error.refusal === "not-a-game" && /Unity/.test(error.message)
        );
        await assert.rejects(
            folders().accept("existing", empty),
            (error: LinkRefusal) => error.refusal === "empty-folder"
        );
        const accepted = await folders().accept("game", unreal);
        assert.equal(accepted.facts.engine, "unreal");
        assert.equal(accepted.root, realpathSync.native(unreal));
    });
});

describe("LinkService", () => {
    test("links a project, keeps the link across context updates and reports it", async () => {
        const workspaces = new WorkspaceManager(projectsDir);
        const service = new LinkService(new LinkedFolders(penforgeHome), workspaces);
        const client = new FakeClient();
        await service.link(client, {
            type: "project.link",
            rid: "l1",
            projectId: "proj-link",
            kind: "existing",
            path: react,
        });
        const reply = client.sent[0] as Extract<DaemonMessage, { type: "project.linked" }>;
        assert.equal(reply.type, "project.linked");
        assert.equal(reply.linked, true);
        assert.deepEqual(reply.stack, { platform: "web", name: "react" });
        await workspaces.open({
            fileId: "f",
            fileName: "F",
            projectId: "proj-link",
            teamId: "t",
            pageId: "p",
            persona: "designer",
            platform: "web",
            projectType: "existing",
        });
        const json = JSON.parse(readFileSync(join(projectsDir, "proj-link", ".penforge", "project.json"), "utf8"));
        assert.equal(json.linkedRoot, react);
        assert.equal(json.linkedKind, "existing");
        assert.equal(json.platform, "existing");
        await service.status(client, { type: "project.link.status", rid: "s1", projectId: "proj-link" });
        assert.equal((client.sent[1] as { linked: boolean }).linked, true);
        // a fresh manager (daemon restart) loads the link from project.json
        const reloaded = await new WorkspaceManager(projectsDir).get("proj-link");
        assert.equal(reloaded.linkedRoot, react);
    });

    test("answers not linked for a project without a folder and refuses bad ids", async () => {
        const service = new LinkService(new LinkedFolders(penforgeHome), new WorkspaceManager(projectsDir));
        const client = new FakeClient();
        await service.status(client, { type: "project.link.status", rid: "s", projectId: "proj-none" });
        assert.equal((client.sent[0] as { linked: boolean }).linked, false);
        await assert.rejects(
            service.link(client, {
                type: "project.link",
                rid: "x",
                projectId: "../evil",
                kind: "existing",
                path: react,
            }),
            /Invalid project id/
        );
    });

    test("is refused in server mode", async () => {
        const service = new LinkService(
            new LinkedFolders(penforgeHome),
            new WorkspaceManager(projectsDir),
            "server mode"
        );
        await assert.rejects(
            service.list(new FakeClient(), { type: "folder.list", rid: "x" }),
            (error: { code?: string }) => error.code === "not-configured"
        );
    });
});

describe("SourceInventory", () => {
    test("Unity: Markdown and UI files, never Library or Temp", async () => {
        const index = await new SourceInventory(unity, "game", "unity").build();
        const paths = index.files.map((file) => file.path);
        assert.ok(paths.includes("Docs/GDD.md"));
        assert.ok(paths.includes("Assets/UI/Main.uxml"));
        assert.ok(paths.includes("Assets/UI/Main.uss"));
        assert.ok(paths.includes("Assets/Scripts/HudController.cs"));
        assert.ok(!paths.includes("Assets/Scripts/EnemyAI.cs"));
        assert.ok(paths.every((path) => !path.startsWith("Library/") && !path.startsWith("Temp/")));
        const prefab = index.files.find((file) => file.path === "Assets/UI/Prefabs/PauseMenu.prefab");
        assert.equal(prefab?.hash, null);
        assert.ok(index.skipped.folders >= 2);
        assert.equal(index.files[0].kind, "markdown");
    });

    test("UE5: UI sources, UI config and widget names, never Binaries or .uasset bytes", async () => {
        const index = await new SourceInventory(unreal, "game", "unreal").build();
        const paths = index.files.map((file) => file.path);
        assert.ok(paths.includes("Source/Skyfall/SkyfallHUD.h"));
        assert.ok(paths.includes("Source/Skyfall/MainMenuWidget.cpp"));
        assert.ok(!paths.includes("Source/Skyfall/Weapon.cpp"));
        assert.ok(paths.includes("Config/DefaultGame.ini"));
        assert.ok(!paths.includes("Config/DefaultInput.ini"));
        assert.equal(index.files.find((file) => file.path === "Content/UI/WBP_Main.uasset")?.hash, null);
        assert.ok(!paths.includes("Content/Characters/Hero.uasset"));
        assert.ok(paths.every((path) => !path.startsWith("Binaries/") && !path.startsWith("Intermediate/")));
    });

    test("Existing project: Markdown and code, never node_modules, dist or .gitignore'd files", async () => {
        const index = await new SourceInventory(react, "existing", null).build();
        const paths = index.files.map((file) => file.path);
        assert.equal(paths[0], "DESIGN.md");
        assert.ok(
            paths.includes("src/App.tsx") &&
                paths.includes("src/pages/Settings.tsx") &&
                paths.includes("src/styles.css")
        );
        assert.ok(paths.every((path) => !path.startsWith("node_modules/") && !path.startsWith("dist/")));
        assert.ok(!paths.includes("secret/keys.ts"));
        assert.ok(index.skipped.ignored >= 1);
    });

    test("reports changed, added and removed files", async () => {
        const dir = join(base, "work", "changing");
        writeTree(dir, { "README.md": "# a", "src/a.ts": "1", "src/b.ts": "2" });
        const first = await new SourceInventory(dir, "existing", null).build();
        writeTree(dir, { "src/a.ts": "changed", "src/c.ts": "3" });
        rmSync(join(dir, "src", "b.ts"));
        const second = await new SourceInventory(dir, "existing", null).build();
        assert.deepEqual(SourceInventory.changes(first, second), {
            added: ["src/c.ts"],
            changed: ["src/a.ts"],
            removed: ["src/b.ts"],
        });
        assert.deepEqual(SourceInventory.changes(second, second), { added: [], changed: [], removed: [] });
    });

    test("stops at the file budget", async () => {
        const index = await new SourceInventory(react, "existing", null, { maxFiles: 3 }).build();
        assert.equal(index.files.length, 3);
        assert.ok(index.skipped.overBudget > 0);
    });
});

describe("GitIgnore", () => {
    test("matches anchored, folder, glob and negated rules", () => {
        const rules = new GitIgnore("# c\n/build\nlogs/\n*.local\n!keep.local\ndocs/**/draft.md\n");
        assert.equal(rules.match("build", true), true);
        assert.equal(rules.match("src/build", true), null);
        assert.equal(rules.match("a/logs", true), true);
        assert.equal(rules.match("a/logs", false), null);
        assert.equal(rules.match("x/y.local", false), true);
        assert.equal(rules.match("keep.local", false), false);
        assert.equal(rules.match("docs/a/b/draft.md", false), true);
        assert.equal(rules.match("docs/draft.md", false), true);
    });
});

describe("LookGuard", () => {
    test("flags files outside the look and look files that gain logic", () => {
        const flagged = LookGuard.check([
            { path: "src/styles.css", added: [":root { --primary: #ff3366; }"] },
            { path: "src/components/Card.tsx", added: ['<div className="card card--elevated">'] },
            { path: "src/pages/Home.tsx", added: ["const tasks = await fetch('/api/tasks');"] },
            { path: "src/api/client.ts", added: ["export async function deleteTask() {}"] },
            { path: "public/logo.svg", added: ["<svg/>"] },
            { path: "package.json", added: ['"lodash": "4"'] },
        ]);
        assert.deepEqual(
            flagged.map((item) => [item.path, item.reason]),
            [
                ["src/pages/Home.tsx", "logic"],
                ["src/api/client.ts", "path"],
                ["package.json", "path"],
            ]
        );
    });

    test("accepts the files of a feature the user asked for", () => {
        const flagged = LookGuard.check([{ path: "src/api/client.ts", added: ["x"] }], ["src/api/client.ts"]);
        assert.deepEqual(flagged, []);
    });
});

describe("ProjectTypes", () => {
    test("maps project types to screen platforms", () => {
        const sent = {
            fileId: "f",
            fileName: "F",
            projectId: "p",
            teamId: "t",
            pageId: "g",
            persona: "designer" as const,
        };
        assert.equal(ProjectTypes.context({ ...sent, platform: "mobile" }).platform, "mobile");
        const game = ProjectTypes.context({ ...sent, platform: "game" });
        assert.equal(game.platform, "web");
        assert.equal(game.projectType, "game");
        const existing = ProjectTypes.context({ ...sent, platform: "existing" });
        assert.equal(
            ProjectTypes.withLink(existing, link("existing", react, { stack: { platform: "mobile", name: "expo" } }))
                .platform,
            "mobile"
        );
        assert.equal(ProjectTypes.isLinked("web"), false);
    });

    test("the client schema accepts the new types and messages", () => {
        const context = ClientMessageSchema.parse({
            type: "context.set",
            fileId: "f",
            fileName: "F",
            projectId: "p",
            teamId: "t",
            pageId: "g",
            persona: "designer",
            platform: "game",
        });
        assert.ok("message" in context);
        assert.ok("message" in ClientMessageSchema.parse({ type: "folder.list", rid: "r" }));
        assert.ok(
            "message" in
                ClientMessageSchema.parse({
                    type: "project.link",
                    rid: "r",
                    projectId: "p",
                    kind: "game",
                    path: "C:\\G",
                })
        );
        assert.ok(
            "error" in
                ClientMessageSchema.parse({
                    type: "project.link",
                    rid: "r",
                    projectId: "p",
                    kind: "web",
                    path: "C:\\G",
                })
        );
    });
});

describe("LinkedProjectPrompt", () => {
    test("adds the look-only rule and the brief for linked projects only", async () => {
        const meta = join(base, "meta-prompt");
        mkdirSync(meta, { recursive: true });
        writeFileSync(join(meta, "project-brief.md"), "# Star Miner\n## Screens\n- HUD — HudController.cs");
        const context = {
            fileId: "f",
            fileName: "F",
            projectId: "p",
            teamId: "t",
            pageId: "g",
            persona: "designer" as const,
            platform: "web" as const,
        };
        const section = await LinkedProjectPrompt.section(
            { metaDir: meta, linked: link("game", unity, { engine: "unity" }), linkedRoot: unity },
            { ...context, projectType: "game" }
        );
        assert.match(section, /Game UI project/);
        assert.match(section, /ONLY the look/);
        assert.match(section, /HudController\.cs/);
        assert.equal(await LinkedProjectPrompt.section({ metaDir: meta, linked: null, linkedRoot: null }, context), "");
    });
});

describe("project-read", () => {
    const brief =
        "# Star Miner\n## What it is\nA mining game.\n## Screens\n- HUD: hull and fuel — Assets/Scripts/HudController.cs\n" +
        "## Notes for the designer\n- Core loop: mine asteroids, upgrade the ship (Docs/GDD.md).";

    test("lists, reads and writes the brief; a second open reads nothing again", async () => {
        const run = await fakeRun(projectsDir, link("game", unity, { engine: "unity" }), {
            projectType: "game",
            projectId: "read-unity",
            turn: () => ({ text: brief }),
        });
        await projectRead.run(run.ctx, {});
        const result = run.events.find((event) => event.kind === "result")!.payload;
        assert.equal(result.state, "ready");
        const written = readFileSync(join(projectsDir, "read-unity", ".penforge", "project-brief.md"), "utf8");
        assert.match(written, /HudController/);
        assert.match(written, /Core loop/);
        assert.match(written, /Skipped by the reader/);
        const index = JSON.parse(
            readFileSync(join(projectsDir, "read-unity", ".penforge", "source-index.json"), "utf8")
        );
        assert.ok(index.files.every((file: { path: string }) => !file.path.startsWith("Library/")));
        // the prompt never offers Library files either
        assert.doesNotMatch(run.turns[0].prompt, /Library\//);
        assert.ok(run.turns[0].toolFilter);
        assert.notEqual(run.turns[0].toolFilter!.check("Read", { file_path: join(unity, "Docs", "GDD.md") }), "x");
        assert.equal(run.turns[0].toolFilter!.check("Read", { file_path: join(unity, "Docs", "GDD.md") }), null);
        assert.notEqual(run.turns[0].toolFilter!.check("Read", { file_path: join(unreal, "Docs", "Design.md") }), null);
        assert.notEqual(run.turns[0].toolFilter!.check("Write", { file_path: join(unity, "x.md") }), null);
        assert.notEqual(run.turns[0].toolFilter!.check("Bash", { command: "ls" }), null);
        assert.ok(run.events.some((event) => event.kind === "progress" && event.payload.step === "inventory"));

        const again = await fakeRun(projectsDir, link("game", unity, { engine: "unity" }), {
            projectType: "game",
            projectId: "read-unity",
            turn: () => ({ text: brief }),
        });
        await projectRead.run(again.ctx, {});
        assert.equal(again.turns.length, 0);
        assert.equal(again.events.find((event) => event.kind === "result")!.payload.state, "unchanged");

        const forced = await fakeRun(projectsDir, link("game", unity, { engine: "unity" }), {
            projectType: "game",
            projectId: "read-unity",
            turn: () => ({ text: brief }),
        });
        await projectRead.run(forced.ctx, { force: true });
        assert.equal(forced.turns.length, 1);
    });

    test("Existing project: copies DESIGN.md into the design repository and keeps node_modules out", async () => {
        const run = await fakeRun(projectsDir, link("existing", react, { stack: { platform: "web", name: "react" } }), {
            projectType: "existing",
            projectId: "read-react",
            turn: () => ({
                text: "# Tasks\n## Screens\n- / — Home — src/pages/Home.tsx\n- /settings — Settings — src/pages/Settings.tsx",
            }),
        });
        await projectRead.run(run.ctx, {});
        const result = run.events.find((event) => event.kind === "result")!.payload;
        assert.equal(result.designMd, "copied");
        assert.ok(existsSync(join(projectsDir, "read-react", "design", "DESIGN.md")));
        assert.doesNotMatch(run.turns[0].prompt, /node_modules/);
        assert.match(
            readFileSync(join(projectsDir, "read-react", ".penforge", "project-brief.md"), "utf8"),
            /\/settings/
        );
    });

    test("reports a project without a link or with a missing folder", async () => {
        const none = await fakeRun(projectsDir, null, { projectType: "existing", projectId: "read-none" });
        await projectRead.run(none.ctx, {});
        assert.deepEqual(
            [none.events.at(-1)!.payload.state, none.events.at(-1)!.payload.reason],
            ["not-linked", "none"]
        );
        const missing = await fakeRun(projectsDir, link("existing", join(base, "work", "gone")), {
            projectType: "existing",
            projectId: "read-missing",
        });
        await projectRead.run(missing.ctx, {});
        assert.equal(missing.events.at(-1)!.payload.reason, "missing");
        assert.equal(missing.turns.length, 0);
    });

    test("fails when Claude writes no brief", async () => {
        const run = await fakeRun(projectsDir, link("game", unreal, { engine: "unreal" }), {
            projectType: "game",
            projectId: "read-fail",
            turn: () => ({ text: "" }),
        });
        await assert.rejects(projectRead.run(run.ctx, {}), /no project brief|did not write/);
    });
});
