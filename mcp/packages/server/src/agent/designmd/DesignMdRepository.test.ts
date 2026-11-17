import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { DesignMdRepository } from "./DesignMdRepository";

let projectsDir: string;
let workspace: ProjectWorkspace;

beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-designmd-repo-"));
    workspace = new ProjectWorkspace(projectsDir, "3e5c1a7b-9f02-4d6e-8b1a-7c4d2e9f0a11");
    await workspace.ensure();
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

test("a write that cannot replace the file fails and leaves no temporary file", async () => {
    // a folder where DESIGN.md should be: the rename can never succeed
    mkdirSync(join(workspace.designDir, DesignMdRepository.FILE_NAME));
    const repository = new DesignMdRepository(workspace);

    await assert.rejects(repository.write("---\nname: X\n---\n"));

    assert.deepEqual(readdirSync(join(workspace.metaDir, "tmp")), []);
});

test("hashes ignore line endings", () => {
    assert.equal(DesignMdRepository.hash("a\r\nb\n"), DesignMdRepository.hash("a\nb\n"));
    assert.notEqual(DesignMdRepository.hash("a\n"), DesignMdRepository.hash("b\n"));
});
