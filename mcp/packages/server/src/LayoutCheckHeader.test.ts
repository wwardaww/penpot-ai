import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { LayoutCheckHeader } from "./LayoutCheckHeader";
import { PenpotMcpServer } from "./PenpotMcpServer";

test("only the value 1 asks for the check", () => {
    assert.equal(LayoutCheckHeader.isSet({ ...LayoutCheckHeader.HEADERS }), true);
    assert.equal(LayoutCheckHeader.isSet({ "x-penforge-layout-check": "0" }), false);
    assert.equal(LayoutCheckHeader.isSet({}), false);
});

test("execute_code asks the plugin to check the layout for clients that send the header", async () => {
    const previousEnv = { ...process.env };
    Object.assign(process.env, {
        PENPOT_MCP_SERVER_HOST: "127.0.0.1",
        PENPOT_MCP_SERVER_PORT: "16990",
        PENPOT_MCP_WEBSOCKET_PORT: "0",
        PENPOT_MCP_REPL_ENABLE: "false",
    });
    const server = new PenpotMcpServer(false);
    const params: any[] = [];
    (server.pluginBridge as any).executePluginTask = async (task: any) => {
        params.push(task.params);
        return { data: { result: 1, log: "" } };
    };
    await server.start();
    try {
        for (const headers of [{}, { ...LayoutCheckHeader.HEADERS }]) {
            const client = new Client({ name: "layout-check-test", version: "1" });
            const url = new URL(`http://127.0.0.1:${server.port}/mcp`);
            await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
            await client.callTool({ name: "execute_code", arguments: { code: "return 1;" } });
            await client.close();
        }
    } finally {
        await server.stop();
        process.env = previousEnv;
    }
    assert.deepEqual(params, [
        { code: "return 1;", trackShapes: true },
        { code: "return 1;", trackShapes: true, checkLayout: true },
    ]);
});
