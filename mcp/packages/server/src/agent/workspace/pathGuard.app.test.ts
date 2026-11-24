import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { after, before, test } from "node:test";
import { PathOutsideRootError, ProjectPathGuard } from "./pathGuard";

// W41: the app folder the user picked is another root of its own project's guard only.

const isWindows = process.platform === "win32";
let base: string;
let projects: string;
let appA: string;
let appB: string;
let linked: string;
let outside: string;

before(() => {
    base = mkdtempSync(join(tmpdir(), "penforge-app-guard-"));
    projects = join(base, "Penforge", "projects");
    mkdirSync(join(projects, "project-a", "app-src"), { recursive: true });
    mkdirSync(join(projects, "project-b", "app-src"), { recursive: true });
    appA = join(base, "apps", "shop");
    appB = join(base, "apps", "blog");
    linked = join(base, "linked");
    outside = join(base, "outside");
    for (const dir of [join(appA, "src"), appB, `${appA}2`, linked, outside]) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(appA, "src", "App.tsx"), "app");
    writeFileSync(join(base, "apps", "notes.txt"), "the user's file next to the app");
    writeFileSync(join(appB, "secret.md"), "b");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(appA, "escape"), isWindows ? "junction" : "dir");
    symlinkSync(join(projects, "project-b"), join(appA, "other-project"), isWindows ? "junction" : "dir");
    symlinkSync(join(appA, "src"), join(appA, "alias"), isWindows ? "junction" : "dir");
});

after(() => {
    rmSync(base, { recursive: true, force: true });
});

function guardOf(project: string, app: string | null, link: string | null = null): ProjectPathGuard {
    const guard = new ProjectPathGuard(join(projects, project));
    guard.setLinkedRoot(link);
    guard.setAppRoot(app);
    return guard;
}

test("accepts absolute paths inside the app folder, existing or new", () => {
    const guard = guardOf("project-a", appA);
    assert.equal(guard.contains(join(appA, "src", "App.tsx")), true);
    assert.equal(guard.contains(join(appA, "src", "pages", "Home.tsx")), true);
    assert.equal(guard.contains(appA), true);
    assert.equal(guard.contains(join(appA, "alias", "App.tsx")), true);
    assert.equal(guard.appRoot, path.resolve(appA));
});

test("relative paths stay on the project folder", () => {
    const guard = guardOf("project-a", appA);
    assert.equal(guard.resolve("app-src"), realpathSync.native(join(projects, "project-a", "app-src")));
    assert.ok(guard.resolve("src/App.tsx").startsWith(realpathSync.native(join(projects, "project-a"))));
});

test("refuses the folder around the app, siblings and name prefixes", () => {
    const guard = guardOf("project-a", appA);
    for (const candidate of [
        join(base, "apps"),
        join(base, "apps", "notes.txt"),
        join(appA, "..", "notes.txt"),
        `${appA}${path.sep}src${path.sep}..${path.sep}..${path.sep}blog${path.sep}secret.md`,
        join(appB, "secret.md"),
        join(`${appA}2`, "file.txt"),
        join(outside, "secret.txt"),
    ]) {
        assert.throws(() => guard.resolve(candidate), PathOutsideRootError, candidate);
    }
});

test("refuses links in the app folder that point outside it", () => {
    const guard = guardOf("project-a", appA);
    assert.equal(guard.contains(join(appA, "escape", "secret.txt")), false);
    assert.equal(guard.contains(join(appA, "escape", "new.txt")), false);
    assert.equal(guard.contains(join(appA, "other-project", "app-src")), false);
});

test("the app folder belongs to its project only", () => {
    const a = guardOf("project-a", appA);
    const b = guardOf("project-b", appB);
    const none = guardOf("project-b", null);
    assert.equal(a.contains(join(appB, "secret.md")), false);
    assert.equal(b.contains(join(appA, "src", "App.tsx")), false);
    assert.equal(none.contains(join(appA, "src", "App.tsx")), false);
    assert.equal(a.contains(join(projects, "project-b", "app-src", "x.ts")), false);
});

test("the app folder and the linked folder are separate roots", () => {
    const guard = guardOf("project-a", appA, linked);
    assert.equal(guard.contains(join(appA, "src", "App.tsx")), true);
    assert.equal(guard.contains(join(linked, "file.txt")), true);
    assert.throws(() => guard.resolveLinked(join(appA, "src", "App.tsx")), PathOutsideRootError);
    guard.setAppRoot(null);
    assert.equal(guard.contains(join(appA, "src", "App.tsx")), false);
    assert.equal(guard.contains(join(linked, "file.txt")), true);
    assert.equal(guard.appRoot, null);
});

test("an app folder that went away holds no path", () => {
    const guard = guardOf("project-a", join(base, "apps", "gone"));
    assert.equal(guard.contains(join(base, "apps", "gone", "src", "App.tsx")), false);
    assert.equal(guard.contains(join(appA, "src", "App.tsx")), false);
    assert.equal(guard.contains("app-src/index.html"), true);
});

test("refuses a relative app folder", () => {
    const guard = new ProjectPathGuard(join(projects, "project-a"));
    assert.throws(() => guard.setAppRoot("apps/shop"), PathOutsideRootError);
});

test("applies the Windows device, stream and UNC rules to the app folder", () => {
    const guard = new ProjectPathGuard("C:\\Penforge\\projects\\p", "win32");
    guard.setAppRoot("D:\\Apps\\Shop");
    for (const candidate of [
        "D:\\Apps\\Shop\\NUL",
        "D:\\Apps\\Shop\\src\\con.txt",
        "D:\\Apps\\Shop\\a.txt:stream",
        "\\\\server\\share\\Apps\\Shop\\a.txt",
        "\\\\?\\D:\\Apps\\Shop\\a.txt",
        "D:Apps\\Shop\\a.txt",
    ]) {
        assert.equal(guard.contains(candidate), false, candidate);
    }
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

test("every fuzzed path is refused or stays inside one of the roots", () => {
    const guard = guardOf("project-a", appA, linked);
    const roots = [join(projects, "project-a"), appA, linked].map((dir) => realpathSync.native(dir));
    const forbidden = [outside, appB, join(projects, "project-b")].map((dir) => realpathSync.native(dir));
    const segments = ["..", ".", "src", "App.tsx", "escape", "alias", "other-project", "blog", "NUL", "a:b", ""];
    const separators = ["/", "\\", "//"];
    const prefixes = [
        "",
        appA,
        join(appA, "src"),
        linked,
        join(base, "apps"),
        join(projects, "project-a"),
        "\\\\?\\",
        "C:",
    ];
    const random = prng(0x41a11);
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
            assert.ok(error instanceof PathOutsideRootError, `unexpected ${String(error)} for ${value}`);
            refused++;
            continue;
        }
        accepted++;
        assert.ok(
            roots.some((root) => isInside(root, resolved)),
            `${JSON.stringify(value)} escaped to ${resolved}`
        );
        for (const dir of forbidden) {
            assert.ok(!isInside(dir, resolved), `${JSON.stringify(value)} reached ${dir}`);
        }
    }
    assert.ok(accepted > 100, `only ${accepted} accepted`);
    assert.ok(refused > 100, `only ${refused} refused`);
});
