import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Path of `fakeDevServer.mjs` that a dev command accepts.
 *
 * Dev commands refuse arguments with spaces, so a checkout below a folder such as `My Projects`
 * runs a copy from the temp folder.
 */
function fakeServerPath(): string {
    const source = join(dirname(fileURLToPath(import.meta.url)), "fakeDevServer.mjs");
    if (!/\s/.test(source)) {
        return source.replace(/\\/g, "/");
    }
    const dir = mkdtempSync(join(tmpdir(), "penforge-fake-server-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    const copy = join(dir, "fakeDevServer.mjs");
    copyFileSync(source, copy);
    return copy.replace(/\\/g, "/");
}

export const FAKE_SERVER = fakeServerPath();
