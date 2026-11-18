import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configJs, FRONTEND_FLAGS } from "../gateway/configJs";
import { fakeContext } from "../testing/helpers";
import { backendArgs, backendEnv, BACKEND_FLAGS } from "./backend";
import { daemonEnv, nodeChildEnv } from "./node";
import { postgresArgs } from "./postgres";

describe("service settings", () => {
    const ctx = fakeContext("/tmp/x", { gateway: 9000, postgres: 9001, backend: 9002, mediaProcessor: 9003, mcp: 9004, bridge: 9005, agent: 9006 });

    it("runs the backend in single-user mode on loopback", () => {
        const env = backendEnv(ctx);
        assert.equal(env.PENPOT_HTTP_SERVER_HOST, "127.0.0.1");
        assert.equal(env.PENPOT_HTTP_SERVER_PORT, "9002");
        assert.equal(env.PENPOT_REDIS_URI, "mem://desktop");
        assert.equal(env.PENPOT_OBJECTS_STORAGE_BACKEND, "fs");
        assert.equal(env.PENPOT_PUBLIC_URI, "http://127.0.0.1:9000");
        assert.equal(env.PENPOT_DATABASE_URI, "postgresql://127.0.0.1:9001/postgres");
        assert.equal(env.PENPOT_PENFORGE_LOCAL_SECRET, ctx.state.localLoginSecret);
        assert.equal(env.PENPOT_MEDIA_PROCESSING_SERVICE_URI, "http://127.0.0.1:9003");
        for (const flag of ["enable-penforge-local", "enable-ai", "disable-registration", "disable-smtp"]) {
            assert.ok(BACKEND_FLAGS.includes(flag), flag);
        }
        const args = backendArgs(ctx);
        assert.ok(args.includes("--enable-preview"));
        assert.equal(args.at(-1), "app.main");
    });

    it("binds PostgreSQL to loopback without unix sockets", () => {
        const args = postgresArgs(ctx);
        assert.ok(args.includes("listen_addresses=127.0.0.1"));
        assert.ok(args.includes("unix_socket_directories="));
        assert.equal(args[args.indexOf("-p") + 1], "9001");
    });

    it("never passes backend secrets or Electron settings to Node children", () => {
        const env = nodeChildEnv(
            { ...ctx, baseEnv: { PATH: "/bin", PENPOT_DATABASE_PASSWORD: "x", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect" } },
            { A: "1" },
        );
        assert.deepEqual(env, { PATH: "/bin", A: "1" });
    });

    it("points the daemon at the gateway origin and its own ports", () => {
        const env = daemonEnv(ctx, { projectsDir: "/home/me/Penforge", claudePath: "/bin/claude" });
        assert.equal(env.PENFORGE_ALLOWED_ORIGINS, "http://127.0.0.1:9000");
        assert.equal(env.PENFORGE_AGENT_PORT, "9006");
        assert.equal(env.PENPOT_MCP_SERVER_PORT, "9004");
        assert.equal(env.PENPOT_MCP_WEBSOCKET_PORT, "9005");
        assert.equal(env.PENFORGE_HOME, "/home/me/Penforge");
        assert.equal(env.PENFORGE_CLAUDE_PATH, "/bin/claude");
        assert.equal(env.PENPOT_PENFORGE_LOCAL_SECRET, undefined);
    });

    it("writes the frontend config", () => {
        const body = configJs({ origin: "http://127.0.0.1:9000", agentPort: 9006, bridgePort: 9005, version: "0.1.0" });
        assert.match(body, /var penpotFlags = "enable-ai enable-mcp/);
        assert.ok(FRONTEND_FLAGS.includes("disable-registration"));
        assert.match(body, /var penforgeDesktop = true;/);
    });
});
