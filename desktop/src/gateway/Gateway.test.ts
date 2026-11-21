import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { randomFreePort } from "../net/ports";
import { tempDir } from "../testing/helpers";
import { configJs } from "./configJs";
import { allowedHost, Gateway, safeJoin } from "./Gateway";
import { GoogleFonts } from "./GoogleFonts";

interface Answer {
    status?: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const req = request(
            { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...options.headers } },
            (res) => {
                let body = "";
                res.on("data", (chunk: Buffer) => (body += chunk.toString()));
                res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
            },
        );
        req.on("error", reject);
        req.end(options.body);
    });
}

describe("safeJoin and allowedHost", () => {
    it("keeps paths inside the root", () => {
        const root = join("x", "root");
        assert.ok(safeJoin(root, "/js/app.js")?.endsWith(join("root", "js", "app.js")));
        assert.equal(safeJoin(root, "/../secret.txt"), undefined);
        assert.equal(safeJoin(root, "/%2e%2e/secret.txt"), undefined);
        assert.equal(safeJoin(root, "/..%5csecret.txt"), undefined);
        assert.equal(safeJoin(root, "/a%00b"), undefined);
        assert.equal(safeJoin(root, "/%E0%A4%A"), undefined);
    });

    it("accepts only loopback hosts of its own port", () => {
        assert.ok(allowedHost("127.0.0.1:8080", 8080));
        assert.ok(allowedHost("localhost:8080", 8080));
        assert.ok(!allowedHost("127.0.0.1:8081", 8080));
        assert.ok(!allowedHost("evil.example:8080", 8080));
        assert.ok(!allowedHost(undefined, 8080));
    });
});

describe("Gateway", () => {
    const temp = tempDir();
    let gatewayPort = 0;
    let backendPort = 0;
    let backend: Server;
    let gateway: Gateway;
    const backendSockets = new Set<import("node:net").Socket>();
    const seen: { method?: string; url?: string; body: string; forwardedFor?: string }[] = [];
    const fontRequests: string[] = [];

    before(async () => {
        const frontend = join(temp.dir, "frontend");
        const plugin = join(temp.dir, "plugin");
        const assets = join(temp.dir, "assets");
        mkdirSync(join(frontend, "js"), { recursive: true });
        mkdirSync(plugin, { recursive: true });
        mkdirSync(join(assets, "ab"), { recursive: true });
        writeFileSync(join(frontend, "index.html"), "<html><body>penpot</body></html>");
        writeFileSync(join(frontend, "js", "main.js"), "console.log(1);");
        writeFileSync(join(plugin, "manifest.json"), '{"name":"mcp"}');
        writeFileSync(join(assets, "ab", "object-1"), "PNGDATA");
        writeFileSync(join(temp.dir, "secret.txt"), "secret");

        backendPort = await randomFreePort();
        gatewayPort = await randomFreePort();
        backend = createServer((req, res) => {
            let body = "";
            req.on("data", (chunk: Buffer) => (body += chunk.toString()));
            req.on("end", () => {
                seen.push({ method: req.method, url: req.url, body, forwardedFor: String(req.headers["x-forwarded-for"]) });
                if (req.url?.startsWith("/assets/by-id/")) {
                    res.writeHead(204, {
                        "x-accel-redirect": "/internal/assets/ab/object-1",
                        "content-type": "image/png",
                        "cache-control": "max-age=60",
                    });
                    res.end();
                } else if (req.url?.startsWith("/assets/escape")) {
                    res.writeHead(204, { "x-accel-redirect": "/internal/assets/../secret.txt" });
                    res.end();
                } else {
                    res.writeHead(201, { "content-type": "application/json", "set-cookie": "auth-token=abc; Path=/" });
                    res.end(JSON.stringify({ echo: body }));
                }
            });
        });
        backend.on("connection", (socket) => backendSockets.add(socket));
        backend.on("upgrade", (_req, socket) => {
            socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
            socket.on("data", (data: Buffer) => socket.write(data));
        });
        await new Promise<void>((resolve) => backend.listen(backendPort, "127.0.0.1", resolve));

        gateway = new Gateway({
            port: gatewayPort,
            frontendDir: frontend,
            mcpPluginDir: plugin,
            assetsDir: assets,
            backendPort,
            configJs: () => configJs({ origin: `http://127.0.0.1:${gatewayPort}`, agentPort: 7001, bridgePort: 7002, version: "1.2.3" }),
            googleFonts: new GoogleFonts({
                cacheDir: join(temp.dir, "font-cache"),
                fetch: async (url) => {
                    fontRequests.push(url);
                    const body = url.includes("/css?") ? "@font-face{font-family:'Inter'}" : "FONTDATA";
                    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
                },
            }),
        });
        await gateway.start();
    });

    after(async () => {
        await gateway.stop();
        for (const socket of backendSockets) {
            socket.destroy();
        }
        await new Promise((resolve) => backend.close(resolve));
        temp.cleanup();
    });

    it("serves the frontend with an SPA fallback", async () => {
        const index = await call(gatewayPort, "/");
        assert.equal(index.status, 200);
        assert.match(index.body, /penpot/);
        assert.equal(index.headers["cache-control"], "no-store");

        const script = await call(gatewayPort, "/js/main.js?version=1");
        assert.equal(script.status, 200);
        assert.match(String(script.headers["content-type"]), /javascript/);

        assert.equal((await call(gatewayPort, "/dashboard")).status, 200);
        assert.equal((await call(gatewayPort, "/js/missing.js")).status, 404);
        assert.equal((await call(gatewayPort, "/%2e%2e/secret.txt")).status, 404);
    });

    it("answers a 304 for an unchanged file", async () => {
        const first = await call(gatewayPort, "/js/main.js");
        const second = await call(gatewayPort, "/js/main.js", { headers: { "if-modified-since": String(first.headers["last-modified"]) } });
        assert.equal(second.status, 304);
    });

    it("generates config.js", async () => {
        const config = await call(gatewayPort, "/js/config.js");
        assert.equal(config.status, 200);
        assert.match(config.body, /var penpotPublicURI = "http:\/\/127\.0\.0\.1:\d+";/);
        assert.match(config.body, /var penforgeAgentURI = "ws:\/\/127\.0\.0\.1:7001\/agent";/);
        assert.match(config.body, /var penforgeMcpBridgeURI = "ws:\/\/127\.0\.0\.1:7002";/);
        assert.match(config.body, /enable-ai/);
    });

    it("serves the MCP plugin", async () => {
        const manifest = await call(gatewayPort, "/plugins/mcp/manifest.json");
        assert.equal(manifest.status, 200);
        assert.equal(manifest.body, '{"name":"mcp"}');
    });

    it("proxies the API with method, body, status and cookies", async () => {
        const answer = await call(gatewayPort, "/api/main/methods/get-profile", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"a":1}',
        });
        assert.equal(answer.status, 201);
        assert.deepEqual(JSON.parse(answer.body), { echo: '{"a":1}' });
        assert.deepEqual(answer.headers["set-cookie"], ["auth-token=abc; Path=/"]);
        const last = seen.at(-1)!;
        assert.equal(last.method, "POST");
        assert.equal(last.forwardedFor, "127.0.0.1");
    });

    it("never forwards the local login RPC", async () => {
        const before = seen.length;
        const answer = await call(gatewayPort, "/api/main/methods/penforge-local-login", { method: "POST", body: "{}" });
        assert.equal(answer.status, 404);
        assert.equal(seen.length, before);
    });

    it("refuses requests for another Host", async () => {
        const answer = await call(gatewayPort, "/", { headers: { host: "rebound.example" } });
        assert.equal(answer.status, 403);
    });

    it("reads x-accel-redirect assets from disk", async () => {
        const asset = await call(gatewayPort, "/assets/by-id/123");
        assert.equal(asset.status, 200);
        assert.equal(asset.body, "PNGDATA");
        assert.equal(asset.headers["content-type"], "image/png");
        assert.equal(asset.headers["cache-control"], "max-age=60");
        assert.equal(asset.headers["x-accel-redirect"], undefined);
        assert.equal((await call(gatewayPort, "/assets/escape")).status, 404);
    });

    it("proxies the notifications WebSocket", async () => {
        const reply = await new Promise<string>((resolve, reject) => {
            const socket = connect(gatewayPort, "127.0.0.1", () => {
                socket.write(
                    `GET /ws/notifications HTTP/1.1\r\nHost: 127.0.0.1:${gatewayPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
                );
            });
            let data = "";
            socket.on("data", (chunk: Buffer) => {
                data += chunk.toString();
                if (data.includes("\r\n\r\n") && !data.includes("ping")) {
                    socket.write("ping");
                }
                if (data.includes("ping")) {
                    socket.destroy();
                    resolve(data);
                }
            });
            socket.on("error", reject);
        });
        assert.match(reply, /101 Switching Protocols/);
        assert.match(reply, /ping$/);
    });

    it("answers the Google Fonts routes and keeps font files on disk", async () => {
        const css = await call(gatewayPort, "/internal/gfonts/css?family=Inter:400,700&display=block");
        assert.equal(css.status, 200);
        assert.match(String(css.headers["content-type"]), /text\/css/);
        assert.match(css.body, /Inter/);
        assert.equal(fontRequests.at(-1), "https://fonts.googleapis.com/css?family=Inter:400,700&display=block");

        const path = "/internal/gfonts/font/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2";
        const font = await call(gatewayPort, path);
        assert.equal(font.status, 200);
        assert.equal(font.headers["content-type"], "font/woff2");
        assert.equal(font.body, "FONTDATA");
        const asked = fontRequests.length;
        const again = await call(gatewayPort, path);
        assert.equal(again.body, "FONTDATA");
        assert.equal(fontRequests.length, asked, "the second load comes from the disk cache");
    });

    it("never answers an internal route with the app page", async () => {
        assert.equal((await call(gatewayPort, "/internal/gfonts/font/../secret.txt")).status, 404);
        const other = await call(gatewayPort, "/internal/somewhere/else");
        assert.equal(other.status, 404);
        assert.doesNotMatch(other.body, /penpot/);
    });
});
