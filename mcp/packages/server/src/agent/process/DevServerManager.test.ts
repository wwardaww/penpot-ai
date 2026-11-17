import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentError } from "../AgentClient";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import type { DevServerObserver, LogLine, PreviewStatus } from "./DevServer";
import { DevServerManager } from "./DevServerManager";
import { PortPool } from "./PortPool";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "testing", "fakeDevServer.mjs");
const FIRST_PORT = 47310;

/** Observer that records everything and lets a test wait for a state. */
class RecordingObserver implements DevServerObserver {
    public readonly statuses: PreviewStatus[] = [];
    public readonly logs: LogLine[] = [];
    private waiters: { state: string; resolve: (status: PreviewStatus) => void }[] = [];

    public onStatus(status: PreviewStatus): void {
        this.statuses.push(status);
        this.waiters = this.waiters.filter((waiter) => {
            if (waiter.state === status.state) {
                waiter.resolve(status);
                return false;
            }
            return true;
        });
    }

    public onLog(line: LogLine): void {
        this.logs.push(line);
    }

    public next(state: PreviewStatus["state"], timeoutMs = 15_000): Promise<PreviewStatus> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${state}`)), timeoutMs);
            this.waiters.push({
                state,
                resolve: (status) => {
                    clearTimeout(timer);
                    resolve(status);
                },
            });
        });
    }
}

let home: string;
let manager: DevServerManager;
let blockers: Server[];
let projectCount = 0;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "penforge-devserver-"));
    manager = new DevServerManager({
        ports: new PortPool(FIRST_PORT, FIRST_PORT + 9),
        maxRestarts: 2,
        probeIntervalMs: 50,
        restartDelayMs: 50,
        idleStopMs: 60_000,
    });
    blockers = [];
});

afterEach(async () => {
    await manager.stopAll();
    for (const blocker of blockers) {
        blocker.close();
    }
    rmSync(home, { recursive: true, force: true });
});

/** Creates a project whose stack runs the fake dev server in the given mode. */
async function project(mode: string, extra: Record<string, unknown> = {}): Promise<ProjectWorkspace> {
    const workspace = new ProjectWorkspace(join(home, "projects"), `project-${++projectCount}`);
    mkdirSync(workspace.appSrcDir, { recursive: true });
    await workspace.writeJson("stack.json", {
        name: "fake",
        dev: `node "${FAKE_SERVER}" ${mode}`,
        ...extra,
    });
    return workspace;
}

async function httpBody(url: string): Promise<string> {
    const response = await fetch(url.replace("localhost", "127.0.0.1"));
    return response.text();
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error("condition not met in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

function listenOn(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server));
    });
}

test("starts the dev server on a pool port and reports ready", async () => {
    const workspace = await project("serve");
    const observer = new RecordingObserver();
    manager.watch(workspace.projectId, observer);
    const ready = observer.next("ready");

    const first = await manager.start(workspace);
    assert.equal(first.state, "starting");

    const status = await ready;
    assert.equal(status.url, `http://localhost:${FIRST_PORT}/`);
    assert.match(await httpBody(status.url!), /fake app/);
    assert.ok(observer.logs.some((line) => line.stream === "stdout" && line.text.includes("Local:")));
    assert.ok(!observer.logs.some((line) => line.text.includes("\u001b")), "ANSI codes are stripped");
});

test("start is idempotent while the server is live", async () => {
    const workspace = await project("serve");
    const observer = new RecordingObserver();
    manager.watch(workspace.projectId, observer);
    const ready = observer.next("ready");
    await Promise.all([manager.start(workspace), manager.start(workspace)]);
    await ready;
    const again = await manager.start(workspace);
    assert.equal(again.state, "ready");
    assert.deepEqual(manager.liveProjects, [workspace.projectId]);
});

test("two projects get different ports, and busy ports are skipped", async () => {
    blockers.push(await listenOn(FIRST_PORT));
    const a = await project("serve");
    const b = await project("serve");
    const observerA = new RecordingObserver();
    const observerB = new RecordingObserver();
    manager.watch(a.projectId, observerA);
    manager.watch(b.projectId, observerB);
    const readyA = observerA.next("ready");
    const readyB = observerB.next("ready");
    await Promise.all([manager.start(a), manager.start(b)]);
    const urls = [(await readyA).url, (await readyB).url];
    assert.equal(new Set(urls).size, 2);
    assert.ok(!urls.includes(`http://localhost:${FIRST_PORT}/`), "the busy port is not used");
    for (const url of urls) {
        assert.match(await httpBody(url!), /fake app/);
    }
});

test("passes the port as {port} and in the port variable", async () => {
    const workspace = await project("announce {port}", { portEnv: "APP_PORT" });
    const observer = new RecordingObserver();
    manager.watch(workspace.projectId, observer);
    const ready = observer.next("ready");
    await manager.start(workspace);
    assert.equal((await ready).url, `http://localhost:${FIRST_PORT}/`);
});

test("finds a server that announces another port", async () => {
    const other = FIRST_PORT + 50;
    const workspace = await project(`announce ${other}`);
    const observer = new RecordingObserver();
    manager.watch(workspace.projectId, observer);
    const ready = observer.next("ready");
    await manager.start(workspace);
    assert.equal((await ready).url, `http://localhost:${other}/`);
});

test("stop kills the whole process tree and frees the port", async () => {
    const pidFile = join(home, "grandchild.pid");
    const workspace = await project(`tree "${pidFile}"`);
    const observer = new RecordingObserver();
    manager.watch(workspace.projectId, observer);
    const ready = observer.next("ready");
    await manager.start(workspace);
    const status = await ready;
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.ok(isAlive(grandchild));

    const stopped = observer.next("stopped");
    assert.equal(await manager.stop(workspace.projectId, "Stopped"), true);
    assert.equal((await stopped).message, "Stopped");
    await waitUntil(() => !isAlive(grandchild));
    assert.equal(await PortPool.isFree(Number(new URL(status.url!).port)), true);
    assert.deepEqual(manager.liveProjects, []);
});

test("restarts a crashed server", async () => {
    const marker = join(home, "crashed-once");
    const workspace = await project(`crash-once "${marker}"`);
    const observer = new RecordingObserver();
    manager.watch(workspace.projectId, observer);
    const ready = observer.next("ready");
    await manager.start(workspace);
    const status = await ready;
    assert.equal(status.restarts, 1);
    assert.ok(observer.logs.some((line) => line.stream === "stderr" && line.text.includes("first start crashes")));
});

test("gives up after the maximum number of restarts", async () => {
    const workspace = await project("crash");
    const observer = new RecordingObserver();
    manager.watch(workspace.projectId, observer);
    const failed = observer.next("failed");
    await manager.start(workspace);
    const status = await failed;
    assert.equal(status.restarts, 2);
    assert.match(status.message ?? "", /could not be restarted/);
    assert.deepEqual(manager.liveProjects, []);
    assert.equal(manager.status(workspace.projectId), undefined);
});

test("fails a server that never answers in time", async () => {
    const workspace = await project("never", { readyTimeoutS: 1 });
    const observer = new RecordingObserver();
    manager.watch(workspace.projectId, observer);
    const failed = observer.next("failed");
    await manager.start(workspace);
    assert.match((await failed).message ?? "", /did not start in time/);
});

test("a failed server can be started again", async () => {
    const workspace = await project("never", { readyTimeoutS: 1 });
    const observer = new RecordingObserver();
    manager.watch(workspace.projectId, observer);
    const failed = observer.next("failed");
    await manager.start(workspace);
    await failed;
    await workspace.writeJson("stack.json", { dev: `node "${FAKE_SERVER}" serve` });
    const ready = observer.next("ready");
    await manager.start(workspace);
    assert.equal((await ready).state, "ready");
});

test("stops a server once nobody watches it", async () => {
    manager = new DevServerManager({ ports: new PortPool(FIRST_PORT, FIRST_PORT + 9), idleStopMs: 100 });
    const workspace = await project("serve");
    const observer = new RecordingObserver();
    const watch = manager.watch(workspace.projectId, observer);
    const ready = observer.next("ready");
    await manager.start(workspace);
    await ready;
    watch.dispose();
    await waitUntil(() => manager.liveProjects.length === 0);
});

test("a watcher that comes back in time keeps the server", async () => {
    manager = new DevServerManager({ ports: new PortPool(FIRST_PORT, FIRST_PORT + 9), idleStopMs: 300 });
    const workspace = await project("serve");
    const observer = new RecordingObserver();
    const ready = observer.next("ready");
    manager.watch(workspace.projectId, observer).dispose();
    const watch = manager.watch(workspace.projectId, observer);
    await manager.start(workspace);
    await ready;
    watch.dispose();
    manager.watch(workspace.projectId, observer);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(manager.liveProjects, [workspace.projectId]);
});

test("refuses a project without a generated app", async () => {
    const workspace = new ProjectWorkspace(join(home, "projects"), "empty-project");
    await assert.rejects(
        () => manager.start(workspace),
        (error: unknown) => error instanceof AgentError && error.code === "not-configured"
    );
});
