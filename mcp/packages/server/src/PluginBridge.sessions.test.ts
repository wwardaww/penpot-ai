import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, beforeEach, mock, test } from "node:test";
import { WebSocket } from "ws";
import { HEARTBEAT_REQUEST_INTERVAL_MS, PluginBridge } from "./PluginBridge";
import { PluginTask } from "./PluginTask";
import type { PenpotMcpServer } from "./PenpotMcpServer";
import { RequestGuard } from "./RequestGuard";

let bridge: PluginBridge;
let port = 17_600;
let userToken: string | undefined;
let multiUser: boolean;
let sockets: WebSocket[];

beforeEach(() => {
    port++;
    userToken = "alice";
    multiUser = true;
    sockets = [];
    bridge = new PluginBridge(
        {
            host: "127.0.0.1",
            isMultiUserMode: () => multiUser,
            getSessionContext: () => ({ userToken }),
            requestGuard: RequestGuard.allowing(["localhost", "127.0.0.1"]),
        } as PenpotMcpServer,
        port,
        1
    );
});

afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await bridge.close();
});

async function connect(sessionId: string, token = "alice", fileName = "Design", reply = sessionId) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?userToken=${token}`);
    sockets.push(socket);
    await once(socket, "open");
    // answer tasks from the start, since one may arrive right behind the initialization
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        if (request.type !== "initialized" && request.type !== "heartbeat-request") {
            socket.send(JSON.stringify({ id: request.id, success: true, data: reply }));
        }
    });
    const initialized = once(socket, "message", { signal: AbortSignal.timeout(1500) });
    socket.send(JSON.stringify({ type: "initialize", session: { sessionId, fileId: "file-1", fileName } }));
    const [message] = await initialized;
    assert.equal(JSON.parse(message.toString()).type, "initialized");
    return socket;
}

test("asks each plugin for a heartbeat at a fixed interval", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
        const socket = await connect("tab-1");
        const requested = once(socket, "message", { signal: AbortSignal.timeout(1500) });
        mock.timers.tick(HEARTBEAT_REQUEST_INTERVAL_MS);
        const [message] = await requested;
        assert.deepEqual(JSON.parse(message.toString()), { type: "heartbeat-request" });
    } finally {
        mock.timers.reset();
    }
});

test("keeps two tabs for the same file and dispatches to the selected session", async () => {
    await connect("tab-1");
    await connect("tab-2");
    const result = await bridge.executePluginTask(new PluginTask("test", {}), "tab-2");
    assert.equal(result.data, "tab-2");
});

test("requires user selection when more than one session is connected", async () => {
    await connect("tab-1", "alice", "First design");
    await connect("tab-2", "alice", "Second design");
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), (error: Error) => {
        assert.match(error.message, /Ask the user/);
        assert.match(error.message, /tab-1.*First design/);
        assert.match(error.message, /tab-2.*Second design/);
        return true;
    });
});

test("implicitly selects the only session belonging to the requesting user", async () => {
    await connect("alice-tab");
    await connect("bob-tab", "bob");
    const result = await bridge.executePluginTask(new PluginTask("test", {}));
    assert.equal(result.data, "alice-tab");
});

test("does not dispatch to another user's session", async () => {
    await connect("alice-tab");
    await connect("bob-tab", "bob");
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {}), "bob-tab"), /not connected/);
});

test("reports no sessions when no plugin has initialized", async () => {
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), /No Penpot.*connected/);
});

test("regular plugins without user tokens can select among multiple sessions", async () => {
    multiUser = false;
    await connect("first", "");
    await connect("second", "");
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), /Ask the user/);
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "second")).data, "second");
});

test("disconnecting one session leaves its sibling available for implicit selection", async () => {
    const first = await connect("first");
    await connect("second");
    const closed = once(first, "close");
    first.close();
    await closed;
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}))).data, "second");
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {}), "first"), /not connected/);
});

test("a reconnect with the same session ID replaces the previous connection", async () => {
    const previous = await connect("tab", "alice", "Design", "previous");
    const closed = once(previous, "close");
    await connect("tab", "alice", "Design", "current");
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}))).data, "current");
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "tab")).data, "current");
});

test("a half-open previous connection does not block a reconnect with the same session ID", async () => {
    const previous = await connect("tab", "alice", "Design", "previous");
    // stop answering, as a socket whose network path is gone would
    previous.pause();
    await connect("tab", "alice", "Design", "current");
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "tab")).data, "current");
});

test("replacing a session does not affect another user's session with the same ID", async () => {
    await connect("tab", "bob", "Design", "bob");
    await connect("tab", "alice", "Design", "alice");
    userToken = "bob";
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "tab")).data, "bob");
});

test("uninitialized sockets are not candidates for discovery", async () => {
    await connect("ready");
    const pending = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`);
    sockets.push(pending);
    await once(pending, "open");
    assert.equal((await bridge.executePluginTask(new PluginTask("test", {}))).data, "ready");
});

test("invalid initialization metadata cannot register a session", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`);
    sockets.push(socket);
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "initialize", session: { sessionId: "bad", fileId: 42 } }));
    assert.equal((await closed)[0], 1008);
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), /No Penpot sessions/);
});

test("a dashboard session remains routable while its workspace metadata changes", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`);
    sockets.push(socket);
    await once(socket, "open");
    const initialized = once(socket, "message");
    socket.send(
        JSON.stringify({
            type: "initialize",
            session: { sessionId: "tab", fileId: null, fileName: null, workspaceState: "none" },
        })
    );
    await initialized;
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ id: request.id, success: true, data: "ok" }));
    });
    for (const context of [
        { fileId: "file-1", fileName: "Design", workspaceState: "ready" },
        { fileId: null, fileName: null, workspaceState: "none" },
    ]) {
        socket.send(JSON.stringify({ type: "context-update", context }));
        assert.equal((await bridge.executePluginTask(new PluginTask("test", {}), "tab")).data, "ok");
        assert.deepEqual(bridge.getUserConnections("alice")!.getSessions(), [{ sessionId: "tab", ...context }]);
    }
});

test("a task fails at once when its plugin connection closes before answering", async () => {
    const plugin = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`);
    sockets.push(plugin);
    await once(plugin, "open");
    const initialized = once(plugin, "message");
    plugin.send(JSON.stringify({ type: "initialize", session: { sessionId: "tab", fileId: null, fileName: null } }));
    await initialized;
    // the socket closes once the task reaches it
    plugin.on("message", () => plugin.terminate());
    const started = Date.now();
    await assert.rejects(
        bridge.executePluginTask(new PluginTask("test", {}), "tab"),
        /connection closed before the task finished/
    );
    // well within the 1s task timeout of these tests
    assert.ok(Date.now() - started < 500);
});

test("a tab busy with a task is not taken for suspended: the next task waits behind it", async () => {
    multiUser = false;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(socket);
    await once(socket, "open");
    // holds every task until released, like a tab running a long script
    const held: string[] = [];
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        if (request.type !== "initialized" && request.type !== "heartbeat-request") {
            held.push(request.id);
        }
    });
    const initialized = once(socket, "message", { signal: AbortSignal.timeout(1500) });
    socket.send(JSON.stringify({ type: "initialize", session: { sessionId: "tab-1", fileId: "f", fileName: "D" } }));
    await initialized;
    const connection = [
        ...(
            bridge as unknown as { connectionsBySocket: Map<unknown, { lastHeartbeat: number }> }
        ).connectionsBySocket.values(),
    ][0];

    const first = bridge.executePluginTask(new PluginTask("test", {}));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(held.length, 1);
    // the long script keeps the tab from answering heartbeats
    connection.lastHeartbeat = Date.now() - 120_000;
    const second = bridge.executePluginTask(new PluginTask("test", {}));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(held.length, 2, "the second task is sent, not refused as suspended");
    for (const id of held) {
        socket.send(JSON.stringify({ id, success: true, data: id }));
    }
    assert.equal((await first).data, held[0]);
    assert.equal((await second).data, held[1]);

    // with nothing running, a missing heartbeat still means a suspended tab
    connection.lastHeartbeat = Date.now() - 120_000;
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), /appears to be suspended/);
});

test("a task that finds no plugin session asks the tabs to restart it and waits for it", async () => {
    let asked = 0;
    bridge.setSessionRecovery(() => {
        asked++;
        // the tab restarts its plugin a little later
        setTimeout(() => void connect("tab-new"), 100);
        return 1;
    });
    // the tab's old session id is gone; the restarted plugin has a new one
    const [first, second] = await Promise.all([
        bridge.executePluginTask(new PluginTask("test", {}), "tab-old"),
        bridge.executePluginTask(new PluginTask("test", {})),
    ]);
    assert.equal(first.data, "tab-new");
    assert.equal(second.data, "tab-new");
    assert.equal(asked, 1, "tasks waiting at the same time share one restart request");
});

test("with no tab to ask, a task without a session fails at once", async () => {
    bridge.setSessionRecovery(() => 0);
    const started = Date.now();
    await assert.rejects(bridge.executePluginTask(new PluginTask("test", {})), /No Penpot sessions are connected/);
    assert.ok(Date.now() - started < 500);
});

test("a connected session is used without asking for a restart", async () => {
    let asked = 0;
    bridge.setSessionRecovery(() => {
        asked++;
        return 1;
    });
    await connect("tab-1");
    const result = await bridge.executePluginTask(new PluginTask("test", {}), "tab-1");
    assert.equal(result.data, "tab-1");
    assert.equal(asked, 0);
});

test("closes a WebSocket opened by a page on a foreign site with a policy violation", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`, {
        headers: { Origin: "http://attacker.example" },
    });
    sockets.push(socket);
    const [code] = await once(socket, "close", { signal: AbortSignal.timeout(1500) });
    assert.equal(code, 1008);
    assert.equal(bridge.getUserConnections("alice"), undefined);
});

test("closes a WebSocket that reaches the server under a foreign host name", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`, {
        headers: { Host: `attacker.example:${port}` },
    });
    sockets.push(socket);
    const [code] = await once(socket, "close", { signal: AbortSignal.timeout(1500) });
    assert.equal(code, 1008);
});

test("accepts a WebSocket opened by a plugin page served from an allowed host", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?userToken=alice`, {
        headers: { Origin: "http://localhost:4400" },
    });
    sockets.push(socket);
    await once(socket, "open");
    const initialized = once(socket, "message", { signal: AbortSignal.timeout(1500) });
    socket.send(JSON.stringify({ type: "initialize", session: { sessionId: "tab", fileId: null, fileName: null } }));
    const [message] = await initialized;
    assert.equal(JSON.parse(message.toString()).type, "initialized");
});
