import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renameWithRetry } from "./renameWithRetry";

test("renameWithRetry moves a file over an existing one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "penforge-rename-"));
    try {
        writeFileSync(join(dir, "a.tmp"), "new");
        writeFileSync(join(dir, "a.json"), "old");
        await renameWithRetry(join(dir, "a.tmp"), join(dir, "a.json"));
        assert.equal(readFileSync(join(dir, "a.json"), "utf8"), "new");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("renameWithRetry does not retry errors that are not locks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "penforge-rename-"));
    try {
        const started = Date.now();
        await assert.rejects(renameWithRetry(join(dir, "missing"), join(dir, "b.json")), { code: "ENOENT" });
        assert.ok(Date.now() - started < 200);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
