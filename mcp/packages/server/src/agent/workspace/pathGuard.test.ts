import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PathGuard, PathOutsideRootError } from "./pathGuard";

const isWindows = process.platform === "win32";
let base: string;
let root: string;
let outside: string;

before(() => {
    base = mkdtempSync(join(tmpdir(), "penforge-guard-"));
    root = join(base, "project");
    outside = join(base, "outside");
    mkdirSync(join(root, "app-src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
});

after(() => {
    rmSync(base, { recursive: true, force: true });
});

test("accepts a relative path inside the root", () => {
    const guard = new PathGuard(root);
    assert.equal(guard.contains("app-src/index.html"), true);
});

test("accepts a path that does not exist yet", () => {
    const guard = new PathGuard(root);
    assert.equal(guard.contains(join(root, "app-src", "new", "deep", "file.ts")), true);
});

test("accepts the root itself", () => {
    const guard = new PathGuard(root);
    assert.equal(guard.contains(root), true);
});

test("rejects parent traversal with ..", () => {
    const guard = new PathGuard(root);
    assert.throws(() => guard.resolve("../outside/secret.txt"), PathOutsideRootError);
});

test("rejects traversal hidden in the middle of a path", () => {
    const guard = new PathGuard(root);
    assert.equal(guard.contains("app-src/../../outside/secret.txt"), false);
});

test("rejects an absolute path outside the root", () => {
    const guard = new PathGuard(root);
    assert.equal(guard.contains(join(outside, "secret.txt")), false);
});

test("rejects a sibling folder whose name starts with the root's name", () => {
    mkdirSync(`${root}2`, { recursive: true });
    const guard = new PathGuard(root);
    assert.equal(guard.contains(`${root}2/file.txt`), false);
});

test("rejects an empty path and a path with a NUL character", () => {
    const guard = new PathGuard(root);
    assert.equal(guard.contains(""), false);
    assert.equal(guard.contains("app-src/a\0b"), false);
});

test("rejects a path through a directory link that points outside the root", () => {
    const link = join(root, "escape");
    // a junction needs no extra privileges on Windows
    symlinkSync(outside, link, isWindows ? "junction" : "dir");
    const guard = new PathGuard(root);
    assert.equal(guard.contains("escape/secret.txt"), false);
    assert.equal(guard.contains("escape/new-file.txt"), false);
});

test("accepts a path through a directory link that stays inside the root", () => {
    const link = join(root, "alias");
    symlinkSync(join(root, "app-src"), link, isWindows ? "junction" : "dir");
    const guard = new PathGuard(root);
    assert.equal(guard.contains("alias/file.txt"), true);
});

test("rejects a dangling file link", (t) => {
    const link = join(root, "dangling.txt");
    try {
        symlinkSync(join(outside, "missing.txt"), link, "file");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
            t.skip("creating file links needs extra privileges on this machine");
            return;
        }
        throw error;
    }
    const guard = new PathGuard(root);
    assert.equal(guard.contains("dangling.txt"), false);
});

test("ignores the case of the drive letter and folders on Windows", { skip: !isWindows }, () => {
    const guard = new PathGuard(root);
    const flipped =
        root[0] === root[0].toUpperCase()
            ? root[0].toLowerCase() + root.slice(1)
            : root[0].toUpperCase() + root.slice(1);
    assert.equal(guard.contains(join(flipped, "app-src", "x.txt")), true);
    assert.equal(guard.contains(join(root.toUpperCase(), "app-src", "x.txt")), true);
});

test("rejects UNC paths on Windows", () => {
    const guard = new PathGuard("C:\\penforge\\project", "win32");
    assert.equal(guard.contains("\\\\server\\share\\file.txt"), false);
    assert.equal(guard.contains("//server/share/file.txt"), false);
});

test("rejects device paths on Windows", () => {
    const guard = new PathGuard("C:\\penforge\\project", "win32");
    assert.equal(guard.contains("\\\\?\\C:\\penforge\\project\\file.txt"), false);
    assert.equal(guard.contains("\\\\.\\C:\\penforge\\project\\file.txt"), false);
});

test("rejects drive-relative paths on Windows", () => {
    const guard = new PathGuard("C:\\penforge\\project", "win32");
    assert.equal(guard.contains("C:file.txt"), false);
});

test("rejects another drive on Windows", () => {
    const guard = new PathGuard("C:\\penforge\\project", "win32");
    assert.equal(guard.contains("D:\\penforge\\project\\file.txt"), false);
});
