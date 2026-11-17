#!/usr/bin/env node
// Penforge: start the local AI agent (daemon) with one command on any OS.
//
//   node mcp/scripts/penforge.mjs          (from the repository root)
//
// Installs dependencies when missing, builds the MCP packages, then starts
// the daemon (MCP 4401, plugin bridge 4402, agent 4410). Only needs Node.js;
// pnpm is taken from corepack. No environment variables required.

import { spawnSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// Package scripts call a bare `pnpm`. When pnpm is only available through
// corepack, put a small `pnpm` shim that forwards to `corepack pnpm` on PATH.
function pnpmShimDir() {
    const probe = spawnSync("pnpm --version", { shell: true, stdio: "ignore" });
    if (probe.status === 0) {
        return null;
    }
    const dir = join(tmpdir(), "penforge-pnpm-shim");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pnpm.cmd"), "@corepack pnpm %*\r\n");
    writeFileSync(join(dir, "pnpm"), '#!/bin/sh\nexec corepack pnpm "$@"\n');
    chmodSync(join(dir, "pnpm"), 0o755);
    return dir;
}

const shimDir = pnpmShimDir();
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const env = {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    ...(shimDir ? { [pathKey]: `${shimDir}${delimiter}${process.env[pathKey] ?? ""}` } : {}),
};

function pnpm(args, label) {
    console.log(`[penforge] ${label}...`);
    // Fixed, trusted arguments only: run as one shell command line so it
    // resolves `corepack.cmd` on Windows.
    const result = spawnSync(`corepack pnpm ${args.join(" ")}`, {
        cwd: mcpDir,
        env,
        stdio: "inherit",
        shell: true,
    });
    if (result.status !== 0) {
        console.error(`[penforge] ${label} failed (exit ${result.status}).`);
        process.exit(result.status ?? 1);
    }
}

if (!existsSync(join(mcpDir, "node_modules"))) {
    pnpm(["-r", "install"], "Installing dependencies (first run)");
}
pnpm(["-r", "run", "build"], "Building");

console.log("[penforge] Starting the agent. Keep this window open; Ctrl+C stops it.");
const daemon = spawn(process.execPath, [join(mcpDir, "packages", "server", "dist", "index.js"), "--penforge"], {
    cwd: join(mcpDir, "packages", "server"),
    env,
    stdio: "inherit",
});
const stop = () => daemon.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
daemon.on("exit", (code) => process.exit(code ?? 0));
