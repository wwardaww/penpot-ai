// Smoke check of the built daemon bundle (W11): starts `node dist/index.js --penforge` with the
// fake runner on free ports and waits until `/health` answers. Fails on a startup crash, such as
// a dependency esbuild bundled that cannot load in ESM ("Dynamic require of "fs" is not
// supported"), which the tsx test suite cannot see because it never loads the bundle.
//
// Usage (from mcp/packages/server): `pnpm run smoke` (builds first) or, after a build,
// `node ./scripts/smoke-bundle.mjs`. Exit code 0 when the daemon came up and stopped cleanly.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = join("dist", "index.js");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function killTree(child) {
    if (child.exitCode !== null || child.pid === undefined) {
        return;
    }
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
        child.kill("SIGTERM");
    }
}

async function health(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    }
}

async function main() {
    if (!existsSync(BUNDLE)) {
        console.error(`smoke: ${BUNDLE} is missing; run \`pnpm run build\` first`);
        return 1;
    }
    const home = mkdtempSync(join(tmpdir(), "penforge-smoke-"));
    const [mcpPort, wsPort, replPort, agentPort] = [
        await freePort(),
        await freePort(),
        await freePort(),
        await freePort(),
    ];
    const env = {
        ...process.env,
        PENPOT_MCP_SERVER_HOST: "127.0.0.1",
        PENPOT_MCP_SERVER_PORT: String(mcpPort),
        PENPOT_MCP_WEBSOCKET_PORT: String(wsPort),
        PENPOT_MCP_REPL_PORT: String(replPort),
        PENFORGE_HOME: home,
        PENFORGE_AGENT_HOST: "127.0.0.1",
        PENFORGE_AGENT_PORT: String(agentPort),
        PENFORGE_RUNNER: "fake",
    };
    delete env.PENPOT_MCP_LOG_DIR;
    delete env.PENFORGE_FAKE_RECORDING;

    let output = "";
    const child = spawn(process.execPath, [BUNDLE, "--penforge"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

    const started = Date.now();
    let status = null;
    let crashed = null;
    child.once("exit", (code, signal) => (crashed = { code, signal }));
    while (Date.now() - started < TIMEOUT_MS && crashed === null) {
        status = await health(agentPort);
        if (status) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // read before stopping it: our own kill ends the process too
    const startupCrash = crashed;
    killTree(child);
    await exited;
    rmSync(home, { recursive: true, force: true });

    const tail = output.split(/\r?\n/).slice(-30).join("\n");
    if (startupCrash !== null) {
        console.error(
            `smoke: the daemon exited during startup (code ${startupCrash.code}, signal ${startupCrash.signal})\n${tail}`
        );
        return 1;
    }
    if (!status) {
        console.error(`smoke: /health did not answer within ${TIMEOUT_MS} ms\n${tail}`);
        return 1;
    }
    if (status.ok !== true || status.runner !== "fake" || !Array.isArray(status.workflows)) {
        console.error(`smoke: unexpected /health answer ${JSON.stringify(status)}`);
        return 1;
    }
    if (/Dynamic require|ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(output)) {
        console.error(`smoke: the daemon came up but logged a module loading error\n${tail}`);
        return 1;
    }
    console.log(
        `smoke: ok, daemon up in ${Date.now() - started} ms (runner ${status.runner}, ${status.workflows.length} workflows)`
    );
    return 0;
}

main().then(
    (code) => process.exit(code),
    (error) => {
        console.error("smoke:", error);
        process.exit(1);
    }
);
