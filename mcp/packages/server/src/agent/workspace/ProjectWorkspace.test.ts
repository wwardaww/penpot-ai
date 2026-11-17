import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { WorkspaceManager } from "./WorkspaceManager";

const PROJECT_ID = "7c1f0a52-0b9e-4a51-9d1e-5e1b0c8d2f10";
let projectsDir: string;

function commitCount(dir: string): number {
    return Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir }).toString().trim());
}

beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-projects-"));
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

test("ensure creates the project folders and two git repos with an initial commit", async () => {
    const workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);

    await workspace.ensure();

    assert.equal(existsSync(join(workspace.metaDir, "chat")), true);
    assert.equal(commitCount(workspace.designDir), 1);
    assert.equal(commitCount(workspace.appSrcDir), 1);
});

test("ensure keeps existing repos", async () => {
    const workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    await workspace.ensure();

    await workspace.ensure();

    assert.equal(commitCount(workspace.designDir), 1);
});

test("commitAll commits changes and returns null when nothing changed", async () => {
    const workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    await workspace.ensure();
    writeFileSync(join(workspace.appSrcDir, "index.html"), "<h1>hi</h1>");

    const hash = await workspace.commitAll("app-src", "penforge(test): add index");
    const second = await workspace.commitAll("app-src", "penforge(test): nothing");

    assert.match(hash ?? "", /^[0-9a-f]{40}$/);
    assert.equal(second, null);
    assert.equal(commitCount(workspace.appSrcDir), 2);
});

test("writeJson and readJson round-trip metadata files", async () => {
    const workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    await workspace.ensure();

    await workspace.writeJson("stack.json", { framework: "react" });

    assert.deepEqual(await workspace.readJson("stack.json", null), { framework: "react" });
    assert.equal(await workspace.readJson("missing.json", "fallback"), "fallback");
});

test("metadata names cannot leave the metadata folder", async () => {
    const workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    await workspace.ensure();

    await assert.rejects(workspace.writeJson("../app-src/evil.json", {}), /Invalid metadata file name/);
});

test("project ids with path characters are refused", () => {
    assert.throws(() => new ProjectWorkspace(projectsDir, "../escape"), /Invalid project id/);
    assert.throws(() => new ProjectWorkspace(projectsDir, "C:\\x"), /Invalid project id/);
});

test("the manager records the context in project.json", async () => {
    const manager = new WorkspaceManager(projectsDir);

    const workspace = await manager.open({
        fileId: "file-1",
        fileName: "Landing",
        projectId: PROJECT_ID,
        projectName: "Shop",
        teamId: "team-1",
        pageId: "page-1",
        persona: "designer",
        platform: "mobile",
    });

    const info = await workspace.readJson<Record<string, unknown> | null>("project.json", null);
    assert.equal(info?.platform, "mobile");
    assert.equal(info?.projectName, "Shop");
    assert.deepEqual(info?.fileIds, ["file-1"]);
});
