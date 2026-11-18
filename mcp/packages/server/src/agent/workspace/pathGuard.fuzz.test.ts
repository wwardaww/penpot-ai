import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { after, before, test } from "node:test";
import { PathGuard, PathOutsideRootError } from "./pathGuard";

// W11 security review: fuzzes the path guard with random mixes of traversal, separators,
// drive letters, device names and links. Every candidate must either be refused with
// PathOutsideRootError or resolve to a real path inside the real root.

const isWindows = process.platform === "win32";
let base: string;
let root: string;

before(() => {
    base = mkdtempSync(join(tmpdir(), "penforge-guard-fuzz-"));
    root = join(base, "project");
    mkdirSync(join(root, "app-src", "src"), { recursive: true });
    mkdirSync(join(base, "outside"), { recursive: true });
    writeFileSync(join(base, "outside", "secret.txt"), "secret");
    symlinkSync(join(base, "outside"), join(root, "escape"), isWindows ? "junction" : "dir");
    symlinkSync(join(root, "app-src"), join(root, "alias"), isWindows ? "junction" : "dir");
});

after(() => {
    rmSync(base, { recursive: true, force: true });
});

/** Small deterministic PRNG (mulberry32), so a failure can be replayed from its seed. */
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

const SEGMENTS = [
    "..",
    ".",
    "...",
    "app-src",
    "src",
    "escape",
    "alias",
    "outside",
    "secret.txt",
    "project",
    "project2",
    "%2e%2e",
    "..%2f",
    "\u2025",
    "\uff0e\uff0e",
    "a b",
    "NUL",
    "con.txt",
    "COM1",
    "file.txt:stream",
    "C:",
    "~",
    "",
];
const SEPARATORS = ["/", "\\", "//", "/./"];
const PREFIXES = () => ["", "/", "\\", "C:", "C:\\", "\\\\?\\", "\\\\server\\share\\", root, base, root.toUpperCase()];

function candidate(random: () => number): string {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const count = 1 + Math.floor(random() * 6);
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
        parts.push(pick(SEGMENTS));
    }
    return pick(PREFIXES()) + parts.map((part, i) => (i === 0 ? part : pick(SEPARATORS) + part)).join("");
}

function isInside(realRoot: string, target: string): boolean {
    const normalize = (value: string) => (isWindows ? value.toLowerCase() : value);
    const relative = path.relative(normalize(realRoot), normalize(target));
    return relative === "" || (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative));
}

test("every fuzzed path is refused or stays inside the real root", () => {
    const guard = new PathGuard(root);
    const realRoot = realpathSync.native(root);
    const realOutside = realpathSync.native(join(base, "outside"));
    const random = prng(0x5eed11);
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 3000; i++) {
        const value = candidate(random);
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
        assert.ok(isInside(realRoot, resolved), `${JSON.stringify(value)} escaped to ${resolved}`);
        assert.ok(!isInside(realOutside, resolved), `${JSON.stringify(value)} reached the outside folder`);
    }
    // the generator must exercise both outcomes, or the test proves nothing
    assert.ok(accepted > 100, `only ${accepted} accepted`);
    assert.ok(refused > 100, `only ${refused} refused`);
});

test("rejects reserved device names on Windows", () => {
    const guard = new PathGuard("C:\\penforge\\project", "win32");
    for (const name of ["NUL", "nul.txt", "app-src\\CON", "COM1 .log", "lpt9", "aux.tar.gz", "CONIN$", "prn."]) {
        assert.equal(guard.contains(name), false, name);
    }
});

test("rejects alternate data streams on Windows", () => {
    const guard = new PathGuard("C:\\penforge\\project", "win32");
    assert.equal(guard.contains("app-src\\index.html:evil"), false);
    assert.equal(guard.contains("C:\\penforge\\project\\a.txt::$DATA"), false);
});

test("keeps names that only start like a device name on Windows", { skip: !isWindows }, () => {
    const guard = new PathGuard(root, "win32");
    for (const name of ["console.ts", "nullable.ts", "com10.txt", "auxiliary", "app-src\\lpt.md"]) {
        assert.equal(guard.contains(name), true, name);
    }
});
