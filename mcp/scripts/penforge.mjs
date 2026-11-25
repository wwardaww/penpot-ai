#!/usr/bin/env node
// Penforge: start the local AI agent (daemon) with one command on any OS.
//
//   node mcp/scripts/penforge.mjs          (from the repository root)
//
// Installs dependencies when missing, builds the MCP packages, then starts
// the daemon (MCP 4401, plugin bridge 4402, agent 4410). Only needs Node.js;
// pnpm is taken from corepack. No environment variables required.

import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withPnpmShim } from "./pnpm-shim.mjs";

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const env = withPnpmShim();

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
