import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocket } from "ws";
import { PluginBridge } from "./PluginBridge";
import type { PenpotMcpServer } from "./PenpotMcpServer";

// Penforge server mode (W24): plugin connections authenticated from the upgrade request

let bridge: PluginBridge;
let port = 17_900;
let sockets: WebSocket[];

beforeEach(() => {
    port++;
    sockets = [];
    bridge = new PluginBridge(
        {
            host: "127.0.0.1",
            isMultiUserMode: () => true,
            getSessionContext: () => ({}),
        } as unknown as PenpotMcpServer,
        port,
        1
    );
    bridge.setConnectionAuthenticator({
        userTokenFor: async (request) => {
            const session = /auth-token=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
            return session === "alice-session" ? "token-alice" : null;
        },
    });
});

afterEach(async () => {
    for (const socket of sockets) {
        socket.terminate();
    }
    await bridge.close();
});

async function initialize(url: string, headers: Record<string, string>): Promise<{ type?: string; code?: number }> {
    const socket = new WebSocket(url, { headers });
    sockets.push(socket);
    await once(socket, "open");
    const outcome = new Promise<{ type?: string; code?: number }>((resolve) => {
        socket.once("message", (raw) => resolve({ type: JSON.parse(raw.toString()).type }));
        socket.once("close", (code) => resolve({ code }));
    });
    socket.send(
        JSON.stringify({ type: "initialize", session: { sessionId: "tab-1", fileId: "file-1", fileName: "F" } })
    );
    return outcome;
}

test("a connection with a valid session is keyed with the authenticator's token", async () => {
    const result = await initialize(`ws://127.0.0.1:${port}`, { Cookie: "auth-token=alice-session" });
    assert.equal(result.type, "initialized");
    assert.equal(bridge.getUserConnections("token-alice")?.getSessions().length, 1);
});

test("a connection without a session is closed, and a userToken query does not help", async () => {
    const result = await initialize(`ws://127.0.0.1:${port}?userToken=token-alice`, {});
    assert.equal(result.code, 1011);
    assert.equal(bridge.getUserConnections("token-alice"), undefined);
});
