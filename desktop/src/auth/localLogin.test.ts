import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { randomFreePort } from "../net/ports";
import { localLogin, parseSetCookie } from "./localLogin";

describe("parseSetCookie", () => {
    it("reads name, value and attributes", () => {
        const cookie = parseSetCookie("auth-token=abc.def=; Path=/; HttpOnly; Max-Age=3600; SameSite=Lax");
        assert.equal(cookie?.name, "auth-token");
        assert.equal(cookie?.value, "abc.def=");
        assert.equal(cookie?.httpOnly, true);
        assert.equal(cookie?.path, "/");
        assert.ok(Math.abs(cookie!.expirationDate! - (Date.now() / 1000 + 3600)) < 5);
    });

    it("rejects a header without a name", () => {
        assert.equal(parseSetCookie("=x"), undefined);
        assert.equal(parseSetCookie(""), undefined);
    });
});

describe("localLogin", () => {
    it("posts the secret and answers the session cookie", async () => {
        const port = await randomFreePort();
        let received = "";
        let url = "";
        const server = createServer((req, res) => {
            url = req.url ?? "";
            req.on("data", (chunk: Buffer) => (received += chunk.toString()));
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json", "set-cookie": ["auth-token=tok; Path=/; HttpOnly"] });
                res.end(JSON.stringify({ id: "p-1" }));
            });
        });
        await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
        try {
            const result = await localLogin(port, "s3cret", { fullname: "Ada", persona: "designer" });
            assert.equal(url, "/api/main/methods/penforge-local-login");
            assert.deepEqual(JSON.parse(received), { secret: "s3cret", fullname: "Ada", persona: "designer" });
            assert.equal(result.profileId, "p-1");
            assert.equal(result.cookies[0]?.value, "tok");
        } finally {
            server.close();
        }
    });

    it("fails on an error answer", async () => {
        const port = await randomFreePort();
        const server = createServer((_req, res) => {
            res.writeHead(400);
            res.end('{"code":"wrong-credentials"}');
        });
        await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
        try {
            await assert.rejects(localLogin(port, "bad"), /local login failed \(400\)/);
        } finally {
            server.close();
        }
    });
});
