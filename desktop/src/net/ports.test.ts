import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { choosePorts, isPortFree, randomFreePort } from "./ports";

describe("ports", () => {
    it("reuses a preferred port that is free", async () => {
        const wish = await randomFreePort();
        const ports = await choosePorts(["a"], { a: wish });
        assert.equal(ports.a, wish);
    });

    it("replaces a preferred port that is taken", async () => {
        const server = createServer();
        const busy = await new Promise<number>((resolve) => {
            server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
        });
        try {
            assert.equal(await isPortFree(busy), false);
            const ports = await choosePorts(["a"], { a: busy });
            assert.notEqual(ports.a, busy);
            assert.equal(await isPortFree(ports.a), true);
        } finally {
            server.close();
        }
    });

    it("never hands out the same port twice", async () => {
        const wish = await randomFreePort();
        const ports = await choosePorts(["a", "b", "c"], { a: wish, b: wish });
        assert.equal(ports.a, wish);
        assert.equal(new Set(Object.values(ports)).size, 3);
    });
});
