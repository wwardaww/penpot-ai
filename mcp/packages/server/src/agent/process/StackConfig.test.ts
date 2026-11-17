import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AgentError } from "../AgentClient";
import { PathGuard } from "../workspace/pathGuard";
import { PortPool } from "./PortPool";
import { StackConfig } from "./StackConfig";

const root = mkdtempSync(join(tmpdir(), "penforge-stack-"));
after(() => rmSync(root, { recursive: true, force: true }));
const guard = new PathGuard(root);
const workspace = { appSrcDir: join(root, "app-src"), resolve: (path: string) => guard.resolve(path) };

function badRequest(error: unknown): boolean {
    return error instanceof AgentError && error.code === "bad-request";
}

test("reads the dev command with defaults", () => {
    const stack = StackConfig.parse(
        { name: "vite-react", dev: "npm run dev -- --port {port} --strictPort" },
        workspace
    );
    assert.equal(stack.name, "vite-react");
    assert.equal(stack.portEnv, "PORT");
    assert.equal(stack.cwd, guard.resolve(workspace.appSrcDir));
    assert.equal(stack.readyPath, "/");
    assert.equal(stack.readyTimeoutMs, 120_000);
    assert.equal(stack.commandFor(5201), "npm run dev -- --port 5201 --strictPort");
});

test("accepts devCommand, portEnv, cwd, readyPath and readyTimeoutS", () => {
    const stack = StackConfig.parse(
        { devCommand: "flutter run", portEnv: "WEB_PORT", cwd: "web", readyPath: "/health", readyTimeoutS: 5000 },
        workspace
    );
    assert.equal(stack.devCommand, "flutter run");
    assert.equal(stack.portEnv, "WEB_PORT");
    assert.equal(stack.cwd, guard.resolve(join(workspace.appSrcDir, "web")));
    assert.equal(stack.readyPath, "/health");
    assert.equal(stack.readyTimeoutMs, 900_000, "the timeout is capped");
});

test("rejects invalid stack files", () => {
    assert.throws(() => StackConfig.parse({}, workspace), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "  " }, workspace), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "x", portEnv: "BAD NAME" }, workspace), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "x", cwd: "../../elsewhere" }, workspace), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "x", readyPath: "health" }, workspace), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "x", readyTimeoutS: -1 }, workspace), badRequest);
});

test("port ranges parse with a fallback to the default", () => {
    const pool = PortPool.fromRange("6000-6009");
    assert.equal(pool.first, 6000);
    assert.equal(pool.last, 6009);
    const fallback = PortPool.fromRange("nonsense");
    assert.equal(fallback.first, PortPool.DEFAULT_FIRST);
    assert.equal(fallback.last, PortPool.DEFAULT_LAST);
    assert.throws(() => new PortPool(10, 5));
});

test("the pool hands out each port once until released", async () => {
    const pool = new PortPool(47420, 47421);
    const a = await pool.acquire();
    const b = await pool.acquire();
    assert.notEqual(a, b);
    await assert.rejects(() => pool.acquire(), /No free port/);
    pool.release(a);
    assert.equal(await pool.acquire(), a);
});
