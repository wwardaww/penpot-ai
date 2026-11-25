import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Environment whose `pnpm` command forwards to `corepack pnpm`.
 *
 * Package scripts call a bare `pnpm`. Another pnpm on PATH refuses to run them
 * below corepack (wrong version, and it does not switch versions there), so a
 * small shim goes first on PATH. The shim folder is private: a fixed name in
 * the shared temp folder could hold another user's `pnpm`.
 */
export function withPnpmShim(env = process.env) {
    const dir = mkdtempSync(join(tmpdir(), "penforge-pnpm-shim-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "pnpm.cmd"), "@corepack pnpm %*\r\n");
    writeFileSync(join(dir, "pnpm"), '#!/bin/sh\nexec corepack pnpm "$@"\n');
    chmodSync(join(dir, "pnpm"), 0o755);
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    return {
        ...env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        [pathKey]: `${dir}${delimiter}${env[pathKey] ?? ""}`,
    };
}
