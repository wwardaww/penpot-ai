import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { waitForHttp } from "../health/probes";
import { randomFreePort } from "../net/ports";
import { exitedReason, type ServiceDefinition } from "../services/context";
import { fakeContext, FAKE_SERVICE, sleep, tempDir } from "../testing/helpers";
import { Supervisor, type ServiceStatus } from "./Supervisor";

const temp = tempDir();
after(() => temp.cleanup());

interface FakeOptions {
    critical?: boolean;
    port?: number;
    env?: Record<string, string>;
    log?: string[];
    /** Without a port, `ready` waits this long and then checks the process is alive. */
    readyWaitMs?: number;
}

function fakeService(name: string, options: FakeOptions): ServiceDefinition {
    return {
        name,
        critical: options.critical ?? true,
        spec: (ctx) => ({
            name,
            command: process.execPath,
            args: [FAKE_SERVICE],
            env: { ...ctx.baseEnv, FAKE_PORT: String(options.port ?? 0), ...options.env },
            logFile: join(ctx.data.logs, `${name}.log`),
        }),
        ready: async (_ctx, proc) => {
            options.log?.push(`ready:${name}`);
            if (options.port) {
                await waitForHttp(`http://127.0.0.1:${options.port}/`, { timeoutMs: 5000, intervalMs: 50, abort: exitedReason(proc) });
            } else {
                await sleep(options.readyWaitMs ?? 100);
                const reason = exitedReason(proc)();
                if (reason) {
                    throw new Error(reason);
                }
            }
        },
        stopOptions: () => {
            options.log?.push(`stop:${name}`);
            return { timeoutMs: 2000 };
        },
    };
}

describe("Supervisor", () => {
    it("starts services in order and stops them in reverse order", async () => {
        const log: string[] = [];
        const ports = [await randomFreePort(), await randomFreePort()];
        const supervisor = new Supervisor({
            context: fakeContext(join(temp.dir, "order")),
            services: [fakeService("first", { port: ports[0], log }), fakeService("second", { port: ports[1], log })],
        });
        await supervisor.start();
        assert.deepEqual(supervisor.statuses().map((s) => s.state), ["ready", "ready"]);
        await supervisor.stop();
        assert.deepEqual(log, ["ready:first", "ready:second", "stop:second", "stop:first"]);
        assert.deepEqual(supervisor.statuses().map((s) => s.state), ["stopped", "stopped"]);
        assert.deepEqual(supervisor.leftovers(), []);
    });

    it("stops what started when a critical service fails", async () => {
        const log: string[] = [];
        const supervisor = new Supervisor({
            context: fakeContext(join(temp.dir, "critical")),
            services: [
                fakeService("db", { log }),
                fakeService("broken", { env: { FAKE_CRASH_AFTER: "1" }, readyWaitMs: 2000, log }),
                fakeService("never", { log }),
            ],
        });
        await assert.rejects(supervisor.start(), /process exited/);
        const states = Object.fromEntries(supervisor.statuses().map((s) => [s.name, s.state]));
        assert.equal(states.broken, "failed");
        assert.equal(states.db, "stopped");
        assert.equal(states.never, "pending");
        assert.ok(!log.includes("ready:never"));
    });

    it("keeps going when a non-critical service fails", async () => {
        const supervisor = new Supervisor({
            context: fakeContext(join(temp.dir, "optional")),
            services: [
                fakeService("optional", { critical: false, env: { FAKE_CRASH_AFTER: "1" }, readyWaitMs: 2000 }),
                fakeService("main", {}),
            ],
        });
        await supervisor.start();
        const states = Object.fromEntries(supervisor.statuses().map((s) => [s.name, s.state]));
        assert.equal(states.optional, "failed");
        assert.equal(states.main, "ready");
        await supervisor.stop();
    });

    it("restarts a service that crashes after it was ready, then gives up", async () => {
        const failed: ServiceStatus[] = [];
        const supervisor = new Supervisor({
            context: fakeContext(join(temp.dir, "restart")),
            services: [fakeService("flaky", { env: { FAKE_CRASH_AFTER: "1500" } })],
            restartPolicy: { maxRestarts: 2, windowMs: 60_000, baseDelayMs: 50 },
        });
        const seen: string[] = [];
        supervisor.on("status", (statuses: ServiceStatus[]) => seen.push(statuses[0]!.state));
        supervisor.on("failed", (status: ServiceStatus) => failed.push(status));
        await supervisor.start();
        const deadline = Date.now() + 20_000;
        while (failed.length === 0 && Date.now() < deadline) {
            await sleep(100);
        }
        await supervisor.stop();
        assert.equal(failed.length, 1);
        assert.equal(seen.filter((state) => state === "restarting").length, 2);
        assert.match(failed[0]!.detail ?? "", /crashed 3 times/);
    });
});
