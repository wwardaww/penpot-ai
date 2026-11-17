import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AgentError } from "../AgentClient";
import { PathGuard } from "../workspace/pathGuard";
import { ChildEnv } from "./ChildEnv";
import { CommandLauncher } from "./CommandLauncher";
import { CommandPolicy } from "./CommandPolicy";
import { PortPool } from "./PortPool";
import { StackConfig } from "./StackConfig";

const root = mkdtempSync(join(tmpdir(), "penforge-stack-"));
after(() => rmSync(root, { recursive: true, force: true }));
const appSrcDir = join(root, "app-src");
mkdirSync(join(appSrcDir, "web"), { recursive: true });
mkdirSync(join(root, "design"), { recursive: true });
const guard = new PathGuard(appSrcDir);
const policy = new CommandPolicy();

function badRequest(error: unknown): boolean {
    return error instanceof AgentError && error.code === "bad-request";
}

test("reads commands.dev with defaults", () => {
    const stack = StackConfig.parse(
        { name: "vite-react", commands: { dev: ["npm", "run", "dev", "--", "--port", "{port}", "--strictPort"] } },
        appSrcDir,
        policy
    );
    assert.equal(stack.name, "vite-react");
    assert.equal(stack.portEnv, "PORT");
    assert.equal(stack.cwd, guard.resolve(appSrcDir));
    assert.equal(stack.readyPath, "/");
    assert.equal(stack.readyTimeoutMs, 120_000);
    assert.deepEqual(stack.argvFor(5201), ["npm", "run", "dev", "--", "--port", "5201", "--strictPort"]);
});

test("splits the legacy dev string and accepts portEnv, cwd, readyPath and readyTimeoutS", () => {
    const stack = StackConfig.parse(
        { dev: "pnpm dev --port {port}", portEnv: "WEB_PORT", cwd: "web", readyPath: "/health", readyTimeoutS: 5000 },
        appSrcDir,
        policy
    );
    assert.deepEqual(stack.devArgv, ["pnpm", "dev", "--port", "{port}"]);
    assert.equal(stack.portEnv, "WEB_PORT");
    assert.equal(stack.cwd, guard.resolve(join(appSrcDir, "web")));
    assert.equal(stack.readyPath, "/health");
    assert.equal(stack.readyTimeoutMs, 900_000, "the timeout is capped");
});

test("rejects invalid stack files", () => {
    assert.throws(() => StackConfig.parse({}, appSrcDir, policy), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "  " }, appSrcDir, policy), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "npm dev", portEnv: "BAD NAME" }, appSrcDir, policy), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "npm dev", readyPath: "health" }, appSrcDir, policy), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "npm dev", readyTimeoutS: -1 }, appSrcDir, policy), badRequest);
});

test("cwd must stay inside app-src", () => {
    assert.throws(() => StackConfig.parse({ dev: "npm dev", cwd: "../design" }, appSrcDir, policy), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "npm dev", cwd: "../../elsewhere" }, appSrcDir, policy), badRequest);
    assert.throws(() => StackConfig.parse({ dev: "npm dev", cwd: root }, appSrcDir, policy), badRequest);
});

test("the dev command is an argument vector of a package manager, without shell syntax", () => {
    assert.deepEqual(policy.validate(["npm", "run", "dev"]), ["npm", "run", "dev"]);
    for (const unsafe of [
        "npm run dev && curl evil.test",
        "npm run dev; rm -rf /",
        "npm run dev | sh",
        "npm run $(whoami)",
        "npm run `id`",
        "node server.js",
        "sh -c dev",
    ]) {
        assert.throws(() => policy.validate(unsafe), badRequest, unsafe);
    }
    assert.throws(() => policy.validate(["npm", "run", "a b"]), badRequest);
    assert.throws(() => policy.validate(["npm", 'run"']), badRequest);
    assert.throws(() => policy.validate([]), badRequest);
    assert.throws(() => policy.validate(new Array(17).fill("npm")), badRequest);
});

test("posix programs are spawned directly", () => {
    const spec = new CommandLauncher({ PATH: "/usr/bin" }, "linux").spawnSpec(["npm", "run", "dev"]);
    assert.deepEqual(spec, { file: "npm", args: ["run", "dev"], windowsVerbatimArguments: false });
});

test("windows batch shims run through cmd.exe with quoted arguments", { skip: process.platform !== "win32" }, () => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "fakepm.cmd"), "@echo off\r\n");
    const env = { PATH: bin, PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
    const launcher = new CommandLauncher(env, "win32");
    const spec = launcher.spawnSpec(["fakepm", "run", "dev", "--port", "5200"]);
    assert.equal(spec.file, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(spec.windowsVerbatimArguments, true);
    assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(spec.args[3], `""${join(bin, "fakepm.cmd")}" "run" "dev" "--port" "5200""`);
    assert.throws(() => launcher.spawnSpec(["fakepm", "%PATH%"]), /safely/);
    assert.throws(() => launcher.spawnSpec(["fakepm", "a^b"]), /safely/);
    assert.throws(() => launcher.spawnSpec(["missing"]), /not found/);
});

test("secrets are dropped from the child environment", () => {
    const env = ChildEnv.scrub(
        {
            PATH: "/bin",
            HOME: "/home/u",
            PENFORGE_TOKEN: "t",
            PENFORGE_HOME: "/p",
            ANTHROPIC_API_KEY: "k",
            CLAUDE_CONFIG_DIR: "/c",
            NPM_TOKEN: "n",
            AWS_SECRET_ACCESS_KEY: "a",
            OPENAI_API_KEY: "o",
            MY_PASSWORD: "p",
            SSH_PRIVATE_KEY: "s",
        },
        { PORT: "5200" }
    );
    assert.deepEqual(env, { PATH: "/bin", HOME: "/home/u", PORT: "5200" });
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

test("the pool hands out each port once until released, and claims only free pool ports", async () => {
    const pool = new PortPool(47420, 47421);
    const a = await pool.acquire();
    const b = await pool.acquire();
    assert.notEqual(a, b);
    await assert.rejects(() => pool.acquire(), /No free port/);
    assert.equal(pool.claim(a), false, "taken");
    assert.equal(pool.claim(47500), false, "outside the pool");
    pool.release(a);
    assert.equal(pool.claim(a), true);
    pool.release(a);
    assert.equal(await pool.acquire(), a);
});
