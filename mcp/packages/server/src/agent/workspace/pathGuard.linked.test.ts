import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { after, before, test } from "node:test";
import { PathOutsideRootError, ProjectPathGuard } from "./pathGuard";
import { ProjectWorkspace } from "./ProjectWorkspace";

// W38: a project's linked folder is a second root of its own guard only.

const isWindows = process.platform === "win32";
let base: string;
let projects: string;
let gameA: string;
let gameB: string;
let outside: string;

before(() => {
    base = mkdtempSync(join(tmpdir(), "penforge-linked-guard-"));
    projects = join(base, "Penforge", "projects");
    mkdirSync(join(projects, "project-a", "app-src"), { recursive: true });
    mkdirSync(join(projects, "project-b", "app-src"), { recursive: true });
    gameA = join(base, "games", "GameA");
    gameB = join(base, "games", "GameB");
    outside = join(base, "outside");
    mkdirSync(join(gameA, "Assets", "UI"), { recursive: true });
    mkdirSync(join(gameB, "Assets"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(`${gameA}2`, { recursive: true });
    writeFileSync(join(gameA, "Assets", "UI", "Main.uxml"), "<ui/>");
    writeFileSync(join(gameB, "secret.md"), "b");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(gameA, "escape"), isWindows ? "junction" : "dir");
    symlinkSync(join(projects, "project-b"), join(gameA, "other-project"), isWindows ? "junction" : "dir");
    symlinkSync(join(gameA, "Assets"), join(gameA, "alias"), isWindows ? "junction" : "dir");
});

after(() => {
    rmSync(base, { recursive: true, force: true });
});

function guardOf(project: string, linked: string | null): ProjectPathGuard {
    const guard = new ProjectPathGuard(join(projects, project));
    guard.setLinkedRoot(linked);
    return guard;
}

test("accepts absolute paths inside the linked folder, existing or new", () => {
    const guard = guardOf("project-a", gameA);
    assert.equal(guard.contains(join(gameA, "Assets", "UI", "Main.uxml")), true);
    assert.equal(guard.contains(join(gameA, "PenforgeUI", "screens", "hud.png")), true);
    assert.equal(guard.contains(gameA), true);
    assert.equal(guard.linkedRoot, path.resolve(gameA));
});

test("keeps the project folder reachable and relative paths on it", () => {
    const guard = guardOf("project-a", gameA);
    assert.equal(guard.contains("app-src/index.html"), true);
    assert.equal(guard.resolve("app-src"), realpathSync.native(join(projects, "project-a", "app-src")));
    // a relative path never resolves against the linked folder
    assert.equal(guard.contains("Assets/UI/Main.uxml"), true);
    assert.ok(guard.resolve("Assets/UI/Main.uxml").startsWith(realpathSync.native(join(projects, "project-a"))));
});

test("refuses .. out of the linked folder", () => {
    const guard = guardOf("project-a", gameA);
    assert.equal(guard.contains(join(gameA, "..", "..", "outside", "secret.txt")), false);
    assert.equal(
        guard.contains(`${gameA}${path.sep}Assets${path.sep}..${path.sep}..${path.sep}GameB${path.sep}secret.md`),
        false
    );
    assert.throws(() => guard.resolve(join(gameA, "..", "GameB", "secret.md")), PathOutsideRootError);
});

test("refuses links in the linked folder that point outside it", () => {
    const guard = guardOf("project-a", gameA);
    assert.equal(guard.contains(join(gameA, "escape", "secret.txt")), false);
    assert.equal(guard.contains(join(gameA, "escape", "new.txt")), false);
    assert.equal(guard.contains(join(gameA, "other-project", "app-src")), false);
});

test("accepts links that stay inside the linked folder", () => {
    const guard = guardOf("project-a", gameA);
    assert.equal(guard.contains(join(gameA, "alias", "UI", "Main.uxml")), true);
});

test("refuses a sibling folder whose name starts with the linked folder's name", () => {
    const guard = guardOf("project-a", gameA);
    assert.equal(guard.contains(join(`${gameA}2`, "file.txt")), false);
});

test("the linked folder belongs to its project only", () => {
    const a = guardOf("project-a", gameA);
    const b = guardOf("project-b", gameB);
    assert.equal(a.contains(join(gameB, "secret.md")), false);
    assert.equal(b.contains(join(gameA, "Assets", "UI", "Main.uxml")), false);
    assert.equal(b.contains(join(gameB, "secret.md")), true);
    // another project's folder stays refused too
    assert.equal(a.contains(join(projects, "project-b", "app-src", "x.ts")), false);
});

test("without a linked folder only the project folder is reachable", () => {
    const guard = guardOf("project-a", null);
    assert.equal(guard.contains(join(gameA, "Assets")), false);
    assert.equal(guard.linkedRoot, null);
    assert.throws(() => guard.resolveLinked("Assets"), PathOutsideRootError);
    guard.setLinkedRoot(gameA);
    assert.equal(guard.contains(join(gameA, "Assets")), true);
    guard.setLinkedRoot(null);
    assert.equal(guard.contains(join(gameA, "Assets")), false);
});

test("resolveLinked takes relative paths from the linked folder and refuses escapes", () => {
    const guard = guardOf("project-a", gameA);
    assert.equal(
        guard.resolveLinked("Assets/UI/Main.uxml"),
        realpathSync.native(join(gameA, "Assets", "UI", "Main.uxml"))
    );
    assert.throws(() => guard.resolveLinked("../GameB/secret.md"), PathOutsideRootError);
    assert.throws(() => guard.resolveLinked("escape/secret.txt"), PathOutsideRootError);
});

test("refuses a relative linked folder", () => {
    const guard = new ProjectPathGuard(join(projects, "project-a"));
    assert.throws(() => guard.setLinkedRoot("games/GameA"), PathOutsideRootError);
});

test("applies the Windows device, stream and UNC rules to the linked folder", () => {
    const guard = new ProjectPathGuard("C:\\Penforge\\projects\\p", "win32");
    guard.setLinkedRoot("D:\\Games\\Mine");
    for (const candidate of [
        "D:\\Games\\Mine\\NUL",
        "D:\\Games\\Mine\\Assets\\con.txt",
        "D:\\Games\\Mine\\a.txt:stream",
        "\\\\server\\share\\Games\\Mine\\a.txt",
        "\\\\?\\D:\\Games\\Mine\\a.txt",
        "D:Games\\Mine\\a.txt",
    ]) {
        assert.equal(guard.contains(candidate), false, candidate);
    }
});

test("a workspace applies its link only while the folder exists", async () => {
    const workspace = new ProjectWorkspace(projects, "project-a");
    const link = { kind: "game" as const, root: gameA, engine: "unity" as const, stack: null, linkedAt: "" };
    workspace.setLink(link);
    assert.equal(workspace.linkedRoot, path.resolve(gameA));
    workspace.setLink({ ...link, root: join(base, "games", "Missing") });
    assert.equal(workspace.linkedRoot, null);
    assert.equal(workspace.guard.contains(join(gameA, "Assets")), false);
    assert.notEqual(workspace.linked, null);
});

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function isInside(realRoot: string, target: string): boolean {
    const normalize = (value: string) => (isWindows ? value.toLowerCase() : value);
    const relative = path.relative(normalize(realRoot), normalize(target));
    return relative === "" || (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative));
}

test("every fuzzed path is refused or stays inside one of the two roots", () => {
    const guard = guardOf("project-a", gameA);
    const realProject = realpathSync.native(join(projects, "project-a"));
    const realGame = realpathSync.native(gameA);
    const forbidden = [outside, gameB, join(projects, "project-b")].map((dir) => realpathSync.native(dir));
    const segments = [
        "..",
        ".",
        "Assets",
        "UI",
        "escape",
        "alias",
        "other-project",
        "GameB",
        "secret.md",
        "NUL",
        "a:b",
        "app-src",
        "",
    ];
    const separators = ["/", "\\", "//"];
    const prefixes = ["", gameA, join(gameA, "Assets"), base, join(projects, "project-a"), "\\\\?\\", "C:"];
    const random = prng(0x38a11);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 3000; i++) {
        const parts = Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(segments));
        const value = pick(prefixes) + parts.map((part) => pick(separators) + part).join("");
        let resolved: string;
        try {
            resolved = guard.resolve(value);
        } catch (error) {
            assert.ok(
                error instanceof PathOutsideRootError,
                `unexpected ${String(error)} for ${JSON.stringify(value)}`
            );
            refused++;
            continue;
        }
        accepted++;
        assert.ok(
            isInside(realProject, resolved) || isInside(realGame, resolved),
            `${JSON.stringify(value)} escaped to ${resolved}`
        );
        for (const dir of forbidden) {
            assert.ok(!isInside(dir, resolved), `${JSON.stringify(value)} reached ${dir}`);
        }
    }
    assert.ok(accepted > 100, `only ${accepted} accepted`);
    assert.ok(refused > 100, `only ${refused} refused`);
});
