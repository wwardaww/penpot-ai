import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AgentContext, DaemonMessage, OutputPurpose, ProjectOutputMessage } from "@penpot/mcp-common";
import { AgentError, type AgentClient } from "../AgentClient";
import { AppCatalog } from "../apps/AppCatalog";
import { BuildLock } from "../build/BuildLock";
import { Checkpoints } from "../checkpoints/Checkpoints";
import { GitRepo } from "../checkpoints/GitRepo";
import { LinkedFolders } from "../linked/LinkedFolders";
import { fakeRun } from "../linked/testing/fixtures";
import { CommandPolicy } from "../process/CommandPolicy";
import { StackConfig } from "../process/StackConfig";
import { DesignToolFilter } from "../tools/DesignToolFilter";
import { AppFolder } from "./AppFolder";
import { AppFolderPrompt } from "./AppFolderPrompt";
import { OutputFolders } from "./OutputFolders";
import { OutputService } from "./OutputService";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { WorkspaceManager } from "./WorkspaceManager";

const isWindows = process.platform === "win32";
let base: string;
let home: string;
let projectsDir: string;
let user: string;
let workspaces: WorkspaceManager;
let service: OutputService;

beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "penforge-output-")));
    home = join(base, "home");
    projectsDir = join(home, "Penforge", "projects");
    user = join(base, "user");
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(user, { recursive: true });
    restart();
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

/** A new daemon on the same home. */
function restart(): void {
    workspaces = new WorkspaceManager(projectsDir);
    const folders = new LinkedFolders(join(home, "Penforge"), home);
    service = new OutputService(new OutputFolders(folders, projectsDir), workspaces);
}

function client(): { client: AgentClient; sent: DaemonMessage[] } {
    const sent: DaemonMessage[] = [];
    return {
        sent,
        client: { id: "c1", send: (message: DaemonMessage) => sent.push(message) } as unknown as AgentClient,
    };
}

async function send(
    type: "status" | "preview" | "set",
    projectId: string,
    path = "",
    purpose: OutputPurpose = "build",
    name = "My Shop"
): Promise<ProjectOutputMessage> {
    const { client: target, sent } = client();
    const pick = { rid: "r1", projectId, path, purpose, name };
    if (type === "status") {
        await service.status(target, { type: "project.output.status", rid: "r1", projectId });
    } else if (type === "preview") {
        await service.preview(target, { type: "project.output.preview", ...pick });
    } else {
        await service.set(target, { type: "project.output.set", ...pick });
    }
    return sent[0] as ProjectOutputMessage;
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof AgentError, String(error));
        return error.reason ?? error.code;
    }
    assert.fail("not refused");
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

/** Every file below a folder with its hash, `.git` included. */
function snapshot(root: string): Record<string, string> {
    const result: Record<string, string> = {};
    const walk = (dir: string, prefix: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const name = `${prefix}${entry.name}`;
            if (entry.isDirectory()) {
                result[`${name}/`] = "dir";
                walk(join(dir, entry.name), `${name}/`);
            } else {
                result[name] = createHash("sha256")
                    .update(readFileSync(join(dir, entry.name)))
                    .digest("hex");
            }
        }
    };
    walk(root, "");
    return result;
}

/** Makes a folder look like a built app and records the build. */
async function build(workspace: ProjectWorkspace): Promise<void> {
    writeFileSync(join(workspace.appSrcDir, "package.json"), '{"name":"shop"}');
    await workspace.writeJson("map.json", { fileId: "file-1", builtAt: "2026-11-24T10:00:00Z", commit: null });
    await workspace.writeJson("stack.json", {
        name: "vite",
        version: "5",
        platform: "web",
        commands: { dev: ["npm", "run", "dev"] },
    });
    await workspace.commitAll("app-src", "penforge(build): build");
}

describe("picking a folder", () => {
    test("an empty folder is used as it is", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);

        const preview = await send("preview", "project-a", folder);
        assert.deepEqual(preview.target, { picked: folder, path: folder, subFolder: false, existing: false });
        assert.deepEqual(readdirSync(folder), [], "a preview creates nothing");

        const set = await send("set", "project-a", folder);
        assert.deepEqual(set.app, { state: "ready", path: folder, built: false });
        assert.deepEqual(readdirSync(folder).sort(), [".git", AppFolder.MARKER]);
        assert.equal(git(folder, "status", "--porcelain"), "");
    });

    test("a folder with files gets a new sub-folder and none of its bytes change", async () => {
        writeFileSync(join(user, "notes.txt"), "mine");
        mkdirSync(join(user, "photos"));
        writeFileSync(join(user, "photos", "a.jpg"), "jpg");
        const before = snapshot(user);

        const preview = await send("preview", "project-a", user);
        assert.equal(preview.target?.path, join(user, "my-shop"));
        assert.equal(preview.target?.subFolder, true);
        assert.deepEqual(snapshot(user), before);

        const set = await send("set", "project-a", user);
        assert.equal(set.app.path, join(user, "my-shop"));
        const after = snapshot(user);
        for (const [name, hash] of Object.entries(before)) {
            assert.equal(after[name], hash, name);
        }
        assert.deepEqual(readdirSync(user).sort(), ["my-shop", "notes.txt", "photos"]);
    });

    test("a taken sub-folder name gets the next free one", async () => {
        mkdirSync(join(user, "my-shop"));
        writeFileSync(join(user, "my-shop", "theirs.txt"), "x");
        writeFileSync(join(user, "my-shop-2"), "a file");
        const before = snapshot(user);

        const set = await send("set", "project-a", user);

        assert.equal(set.app.path, join(user, "my-shop-3"));
        const after = snapshot(user);
        Object.entries(before).forEach(([name, hash]) => assert.equal(after[name], hash, name));
    });

    test("picking the same folder again gives the same app folder", async () => {
        writeFileSync(join(user, "notes.txt"), "mine");
        const first = await send("set", "project-a", user);
        const commit = git(first.app.path!, "rev-parse", "HEAD");

        const again = await send("preview", "project-a", user);
        assert.deepEqual(again.target, { picked: user, path: first.app.path, subFolder: true, existing: true });
        const set = await send("set", "project-a", first.app.path!);

        assert.equal(set.app.path, first.app.path);
        assert.equal(git(first.app.path!, "rev-parse", "HEAD"), commit);
        assert.deepEqual(readdirSync(user).sort(), ["my-shop", "notes.txt"]);
    });

    test("an empty folder is used without git for Instruct", async () => {
        const folder = join(user, "spec");
        mkdirSync(folder);
        const set = await send("set", "project-a", folder, "instruct");
        assert.deepEqual(set.output, { state: "ready", path: folder });
        assert.deepEqual(set.app, { state: "none", path: null, built: false });
        assert.deepEqual(readdirSync(folder), []);
    });

    test("folder names are plain and never a device name", () => {
        assert.equal(OutputFolders.folderName("Mağazam İçin Şık Uygulama ı"), "magazam-icin-sik-uygulama-i");
        assert.equal(OutputFolders.folderName("../../etc"), "etc");
        assert.equal(OutputFolders.folderName("日本"), "penforge-app");
        assert.equal(OutputFolders.folderName("CON"), "con-app");
        assert.equal(OutputFolders.folderName("a".repeat(90)).length, 60);
    });
});

describe("refused folders", () => {
    test("roots, home, system folders and the Penforge home", async () => {
        const root = isWindows ? `${base.slice(0, 2)}\\` : "/";
        for (const folder of [root, home, join(home, "Penforge"), projectsDir, base]) {
            assert.equal(await refusal(send("set", "project-a", folder)), "folder-refused", folder);
        }
        const system = isWindows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr";
        assert.equal(await refusal(send("set", "project-a", system)), "folder-refused");
        assert.equal(await refusal(send("set", "project-a", join(user, "missing"))), "folder-missing");
        assert.equal(await refusal(send("set", "project-a", "relative/folder")), "bad-path");
        writeFileSync(join(user, "file.txt"), "x");
        assert.equal(await refusal(send("set", "project-a", join(user, "file.txt"))), "not-a-folder");
        assert.equal(await refusal(send("set", "project-a", "   ")), "bad-path");
    });

    test("a link into the Penforge home", async () => {
        symlinkSync(projectsDir, join(user, "link"), isWindows ? "junction" : "dir");
        assert.equal(await refusal(send("set", "project-a", join(user, "link"))), "folder-refused");
    });

    test("another project's app folder, inside it, and its linked or picked folder", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        mkdirSync(join(folder, "src"));
        assert.equal(await refusal(send("set", "project-b", folder)), "folder-taken");
        assert.equal(await refusal(send("set", "project-b", join(folder, "src"), "instruct")), "folder-taken");
        // also for its own project: never inside the app
        assert.equal(await refusal(send("set", "project-a", join(folder, "src"), "instruct")), "folder-taken");

        const spec = join(user, "spec");
        mkdirSync(spec);
        await send("set", "project-a", spec, "instruct");
        assert.equal(await refusal(send("set", "project-b", spec, "instruct")), "folder-taken");

        const linked = join(user, "existing");
        mkdirSync(join(linked, "src"), { recursive: true });
        const link = { kind: "existing" as const, root: linked, engine: null, stack: null, linkedAt: "" };
        await workspaces.setLink("project-c", link);
        assert.equal(await refusal(send("set", "project-b", join(linked, "src"))), "folder-taken");
    });

    test("a marker of another project counts even without its project.json", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        rmSync(join(projectsDir, "project-a"), { recursive: true, force: true });
        restart();
        assert.equal(await refusal(send("set", "project-b", folder)), "folder-taken");
    });

    test("Build never goes into a repository of the user; Instruct may", async () => {
        const repo = join(user, "repo");
        mkdirSync(join(repo, "empty"), { recursive: true });
        writeFileSync(join(repo, "a.txt"), "x");
        git(repo, "init", "-q", "-b", "main");
        const before = snapshot(repo);

        assert.equal(await refusal(send("set", "project-a", repo)), "inside-git");
        assert.equal(await refusal(send("set", "project-a", join(repo, "empty"))), "inside-git");
        assert.deepEqual(snapshot(repo), before);

        const set = await send("set", "project-a", repo, "instruct");
        assert.equal(set.output.path, join(repo, "my-shop"));
        assert.equal(existsSync(join(repo, "my-shop", ".git")), false);
        assert.equal(await refusal(send("set", "project-a", join(repo, ".git"), "instruct")), "folder-refused");
    });

    test("a repository of the user in a folder Penforge only wrote a spec to", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder, "instruct");
        git(folder, "init", "-q", "-b", "main");
        assert.equal(await refusal(send("set", "project-a", folder)), "inside-git");
    });

    test("Game UI and Existing projects, server mode and a running build", async () => {
        await workspaces.open({
            projectId: "project-g",
            teamId: "t",
            fileId: "f",
            projectType: "game",
        } as AgentContext);
        assert.equal(await refusal(send("set", "project-g", user)), "bad-request");

        const release = BuildLock.tryAcquire((await workspaces.get("project-a")).root)!;
        assert.equal(await refusal(send("set", "project-a", user)), "build-running");
        release();

        const hosted = new OutputService(
            new OutputFolders(new LinkedFolders(join(home, "Penforge"), home), projectsDir),
            workspaces,
            "server mode"
        );
        const request = { type: "project.output.status" as const, rid: "r", projectId: "project-a" };
        assert.equal(await refusal(hosted.status(client().client, request)), "not-configured");
        assert.equal(await refusal(send("status", "../escape")), "bad-request");
    });
});

describe("the app folder of a project", () => {
    test("is remembered over a restart, with only metadata in the Penforge home", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        await build(await workspaces.get("project-a"));
        restart();

        const status = await send("status", "project-a");
        assert.deepEqual(status.app, { state: "ready", path: folder, built: true });
        assert.deepEqual(status.output, { state: "ready", path: folder });
        const workspace = await workspaces.get("project-a");
        assert.equal(workspace.appSrcDir, folder);
        assert.equal(workspace.resolve(join(folder, "src", "new.ts")), join(folder, "src", "new.ts"));
        assert.deepEqual(
            readdirSync(workspace.internalAppDir).filter((name) => name !== ".git"),
            []
        );
        // another project's guard never sees it
        const other = await workspaces.get("project-b");
        assert.throws(() => other.resolve(join(folder, "package.json")));
        // context updates keep it
        await workspaces.open({ projectId: "project-a", teamId: "t", fileId: "f" } as AgentContext);
        assert.equal((await send("status", "project-a")).app.path, folder);
    });

    test("a new project opened after the pick makes no app-src in the Penforge home", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        rmSync(join(projectsDir, "project-a", "app-src"), { recursive: true, force: true });
        restart();
        const workspace = await workspaces.get("project-a");
        assert.equal(existsSync(workspace.internalAppDir), false);
        assert.equal(existsSync(workspace.designDir), true);
    });

    test("commits go to the app's own repository, without the marker and PenforgeUI", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        const workspace = await workspaces.get("project-a");
        mkdirSync(join(folder, "PenforgeUI"));
        writeFileSync(join(folder, "PenforgeUI", "README.md"), "spec");
        writeFileSync(join(folder, "index.html"), "app");

        const commit = await workspace.commitAll("app-src", "penforge(test): app");

        assert.equal(git(folder, "ls-tree", "-r", "--name-only", commit!), "index.html");
        assert.equal(git(folder, "status", "--porcelain"), "");
    });

    test("a missing folder, a removed marker or a link in its place closes the guard", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        const workspace = await workspaces.get("project-a");

        renameSync(folder, join(user, "moved"));
        assert.equal((await send("status", "project-a")).app.state, "missing");
        assert.equal(workspace.appSrcDir, folder, "nothing falls back to the Penforge home");
        assert.throws(() => workspace.resolve(join(folder, "a.ts")));
        await assert.rejects(workspace.commitAll("app-src", "x"), /missing/);

        symlinkSync(join(user, "moved"), folder, isWindows ? "junction" : "dir");
        assert.equal((await send("status", "project-a")).app.state, "missing");
        rmSync(folder, { recursive: true, force: true });

        renameSync(join(user, "moved"), folder);
        assert.equal((await send("status", "project-a")).app.state, "ready");
        rmSync(join(folder, AppFolder.MARKER));
        assert.equal((await send("status", "project-a")).app.state, "missing");
        assert.equal(workspace.guard.contains(join(folder, "a.ts")), false);
    });

    test("a tampered project.json opens no other folder", async () => {
        const folder = join(user, "shop");
        const private_ = join(user, "private");
        mkdirSync(folder);
        mkdirSync(private_);
        writeFileSync(join(private_, "secret.txt"), "x");
        await send("set", "project-a", folder);
        const file = join(projectsDir, "project-a", ".penforge", "project.json");
        for (const appRoot of [private_, user, home]) {
            writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), appRoot }));
            restart();
            const workspace = await workspaces.get("project-a");
            assert.equal(workspace.appRoot, null, appRoot);
            assert.equal(workspace.guard.contains(join(appRoot, "secret.txt")), false, appRoot);
            await assert.rejects(workspace.commitAll("app-src", "x"));
            assert.equal(existsSync(join(appRoot, ".git")), false, appRoot);
        }
    });

    test("git in the app folder never reaches a repository above it", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        // the user makes the parent a repository later, and the app's own one goes away
        writeFileSync(join(user, "mine.txt"), "mine");
        git(user, "init", "-q", "-b", "main");
        git(user, "add", "mine.txt");
        git(user, "-c", "user.name=U", "-c", "user.email=u@localhost", "commit", "-q", "-m", "mine");
        rmSync(join(folder, ".git"), { recursive: true, force: true });
        writeFileSync(join(user, "mine.txt"), "changed and not committed");
        const before = snapshot(user);

        const repo = new GitRepo(folder);
        await assert.rejects(repo.head());
        await assert.rejects(repo.resetHard(git(user, "rev-parse", "HEAD")));
        const workspace = await workspaces.get("project-a");
        await assert.rejects(workspace.commitAll("app-src", "x"));

        assert.deepEqual(snapshot(user), before);
        assert.equal(await refusal(send("set", "project-a", folder)), "inside-git");
    });

    test("checkpoints from before the pick can still be restored", async () => {
        const run = await fakeRun(projectsDir, null, { projectType: "web", projectId: "project-a" });
        const workspace = run.ctx.workspace as ProjectWorkspace;
        writeFileSync(join(workspace.appSrcDir, "old.txt"), "old");
        const old = await new Checkpoints(run.ctx).create({ label: "before" });
        rmSync(join(workspace.appSrcDir, "old.txt"));
        await workspace.commitAll("app-src", "clean");

        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        workspace.setOutput((await workspaces.get("project-a")).outputFolder);
        writeFileSync(join(folder, "new.txt"), "new");
        const saved = await new Checkpoints(run.ctx).create({ label: "after" });
        assert.equal(saved.appSha, git(folder, "rev-parse", "HEAD"));

        await new Checkpoints(run.ctx).restore({ id: old.id, confirmed: true });
        assert.equal(readFileSync(join(folder, "old.txt"), "utf8"), "old");
        assert.equal(existsSync(join(folder, "new.txt")), false);
        assert.equal(existsSync(join(folder, AppFolder.MARKER)), true);
        await new Checkpoints(run.ctx).restore({ id: saved.id, confirmed: true });
        assert.equal(readFileSync(join(folder, "new.txt"), "utf8"), "new");
    });

    test("the Apps dashboard and the dev server use it", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        const workspace = await workspaces.get("project-a");
        await build(workspace);

        const app = (await new AppCatalog(projectsDir).list())[0];
        assert.equal(app.appPath, folder);
        assert.equal(app.projectId, "project-a");
        const policy = new CommandPolicy();
        assert.equal((await StackConfig.load(workspace, policy)).cwd, folder);
        renameSync(folder, join(user, "moved"));
        await assert.rejects(StackConfig.load(workspace, policy), { reason: "folder-missing" });
    });

    test("Instruct in a folder does not move the app, and Build may use that folder next", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder, "instruct");
        const workspace = await workspaces.get("project-a");
        assert.equal(workspace.appSrcDir, workspace.internalAppDir);
        const set = await send("set", "project-a", folder);
        assert.deepEqual(set.app, { state: "ready", path: folder, built: false });
        assert.equal(workspace.appSrcDir, folder);
    });
});

describe("projects built before W41", () => {
    test("stay in app-src and work as before", async () => {
        const workspace = await workspaces.get("project-old");
        await build(workspace);
        restart();
        const status = await send("status", "project-old");
        assert.deepEqual(status.app, { state: "internal", path: workspace.internalAppDir, built: true });
        assert.equal((await new AppCatalog(projectsDir).find("project-old"))?.appPath, workspace.internalAppDir);
        const prompt = new AppFolderPrompt(await workspaces.get("project-old"));
        assert.equal(prompt.noAppSection({ projectType: "web" } as AgentContext), "");
        assert.equal(prompt.text("files in `app-src/`"), "files in `app-src/`");
        assert.deepEqual(prompt.directories, []);
        // an Instruct folder does not change that
        const folder = join(user, "spec");
        mkdirSync(folder);
        const set = await send("set", "project-old", folder, "instruct");
        assert.equal(set.app.state, "internal");
    });
});

describe("what Claude is told", () => {
    test("prompts name the picked folder and writes to app-src are refused", async () => {
        const folder = join(user, "shop");
        mkdirSync(folder);
        await send("set", "project-a", folder);
        const workspace = await workspaces.get("project-a");
        const prompt = new AppFolderPrompt(workspace);
        const shown = folder.split("\\").join("/");

        assert.equal(
            prompt.text("Write only inside `app-src/`; my-app-src/ stays."),
            `Write only inside \`${shown}/\`; my-app-src/ stays.`
        );
        assert.ok(prompt.section({ projectType: "web" } as AgentContext).includes(shown));
        assert.equal(prompt.section({ projectType: "game" } as AgentContext), "");
        assert.equal(prompt.noAppSection({ projectType: "web" } as AgentContext), "");
        const unbuilt = new AppFolderPrompt(await workspaces.get("project-new"));
        assert.match(unbuilt.noAppSection({ projectType: "web" } as AgentContext), /press Build/);
        assert.equal(unbuilt.noAppSection({ projectType: "existing" } as AgentContext), "");
        assert.deepEqual(prompt.directories, [folder]);

        const policy = prompt.permissions({ decide: async () => ({ allow: true }) });
        const use = (toolName: string, file_path: string) =>
            policy.decide({ toolName, input: { file_path }, signal: new AbortController().signal });
        assert.equal((await use("Write", "app-src/src/App.tsx")).allow, false);
        assert.equal((await use("Edit", join(workspace.internalAppDir, "a.ts"))).allow, false);
        assert.equal((await use("Read", "app-src/src/App.tsx")).allow, true);
        assert.equal((await use("Write", join(folder, "src", "App.tsx"))).allow, true);
        assert.equal((await use("Write", "design/notes.md")).allow, true);
    });

    test("the design tool filter lets Claude change the picked folder only", () => {
        const filter = new DesignToolFilter(join(projectsDir, "project-a"), join(user, "shop"));
        assert.equal(filter.check("Write", { file_path: join(user, "shop", "src", "a.ts") }), null);
        assert.match(filter.check("Write", { file_path: join(user, "notes.txt") }) ?? "", /Only files inside/);
        assert.match(filter.check("Write", { file_path: "app-src/a.ts" }) ?? "", /Only files inside/);
        const rule = filter.allowedTools.find((tool) => tool.startsWith("Edit("));
        assert.match(rule ?? "", /^Edit\(\/\/.*\/user\/shop\/\*\*\)$/);
        assert.deepEqual(
            new DesignToolFilter("/p", "/p/app-src").allowedTools.filter((tool) => tool.startsWith("Edit(")),
            ["Edit(app-src/**)"]
        );
    });
});
