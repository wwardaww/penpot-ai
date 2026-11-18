import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FAKE_SERVICE, sleep, tempDir } from "../testing/helpers";
import { ManagedProcess } from "./ManagedProcess";
import { isAlive } from "./treeKill";

const temp = tempDir();
after(() => temp.cleanup());

function fake(name: string, env: Record<string, string> = {}): ManagedProcess {
    return new ManagedProcess({
        name,
        command: process.execPath,
        args: [FAKE_SERVICE],
        env: { ...process.env, ...env },
        logFile: join(temp.dir, `${name}.log`),
    });
}

async function waitFor<T>(read: () => T | undefined, ms = 5000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = read();
        if (value !== undefined) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error("timed out");
        }
        await sleep(50);
    }
}

describe("ManagedProcess", () => {
    it("writes the output of the process to its log file", async () => {
        const proc = fake("logs", { FAKE_GRANDCHILD: "1" });
        await proc.start();
        const line = await waitFor(() => proc.log.lastLines().find((l) => l.startsWith("GRANDCHILD_PID=")));
        assert.match(line, /^GRANDCHILD_PID=\d+$/);
        await proc.stop({ timeoutMs: 2000 });
        await proc.dispose();
        assert.match(readFileSync(proc.log.file, "utf8"), /GRANDCHILD_PID=/);
    });

    it("kills the whole process tree on stop", async () => {
        const proc = fake("tree", { FAKE_GRANDCHILD: "1" });
        await proc.start();
        const line = await waitFor(() => proc.log.lastLines().find((l) => l.startsWith("GRANDCHILD_PID=")));
        const grandchild = Number(line.split("=")[1]);
        assert.ok(isAlive(grandchild));
        const info = await proc.stop({ timeoutMs: 2000 });
        await proc.dispose();
        assert.equal(info.expected, true);
        await waitFor(() => (isAlive(grandchild) ? undefined : true));
        assert.equal(proc.running, false);
    });

    it("reports an unexpected exit", async () => {
        const proc = fake("crash", { FAKE_CRASH_AFTER: "100" });
        const exited = new Promise((resolve) => proc.once("exit", resolve));
        await proc.start();
        const info = (await exited) as { code: number; expected: boolean };
        await proc.dispose();
        assert.equal(info.code, 3);
        assert.equal(info.expected, false);
    });

    it("rejects when the binary does not exist", async () => {
        const proc = new ManagedProcess({
            name: "missing",
            command: join(temp.dir, "no-such-binary"),
            args: [],
            env: process.env,
            logFile: join(temp.dir, "missing.log"),
        });
        await assert.rejects(proc.start(), /cannot start/);
        await proc.dispose();
    });

    it("runs the polite stop first", async () => {
        const proc = fake("graceful");
        await proc.start();
        let called = false;
        await proc.stop({
            timeoutMs: 1000,
            graceful: async () => {
                called = true;
            },
        });
        await proc.dispose();
        assert.equal(called, true);
        assert.equal(proc.running, false);
    });
});
