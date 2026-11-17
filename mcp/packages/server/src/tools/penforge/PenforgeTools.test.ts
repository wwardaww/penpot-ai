import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";
import { PenforgeTools } from "./PenforgeTools";
import { CaptureNodeScreenshotTool } from "./CaptureNodeScreenshotTool";
import { PenforgeOverviewTool } from "./PenforgeOverviewTool";

let server: PenpotMcpServer;
let client: Client;
let previousEnv: NodeJS.ProcessEnv;
let nextPort = 17_500;

beforeEach(async () => {
    previousEnv = { ...process.env };
    process.env.PENPOT_MCP_SERVER_HOST = "127.0.0.1";
    process.env.PENPOT_MCP_SERVER_PORT = String(nextPort++);
    process.env.PENPOT_MCP_WEBSOCKET_PORT = "0";
    process.env.PENPOT_MCP_DEVENV = "false";
    process.env.PENPOT_MCP_REPL_ENABLE = "false";
    delete process.env.PENPOT_MCP_REMOTE_MODE;
    delete process.env.PENPOT_MCP_REDIS_URI;
    delete process.env.PENPOT_MCP_AUTH_URI;
    server = new PenpotMcpServer(false);
    await server.start();
    client = new Client(
        { name: "penforge-test", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
});

afterEach(async () => {
    await client?.close();
    await server?.stop();
    process.env = previousEnv;
});

/**
 * Replaces the plugin bridge call with a stub that records the code and returns the given result.
 */
function stubPlugin(t: any, result: (code: string) => unknown): string[] {
    const codes: string[] = [];
    t.mock.method(server.pluginBridge, "executePluginTask", async (task: any) => {
        codes.push(task.params.code);
        return { data: { result: result(task.params.code), log: "" } };
    });
    return codes;
}

/**
 * Runs generated plugin code against a fake `penpotUtils` and returns the method call it makes.
 */
async function runGeneratedCode(code: string): Promise<{ method: string; params: unknown }> {
    let call: { method: string; params: unknown } | undefined;
    const penforge = new Proxy(
        {},
        {
            get: (_target, method: string) => async (params: unknown) => {
                call = { method, params };
                return null;
            },
        }
    );
    const fn = new Function("penpotUtils", `return (async () => { ${code} })();`);
    await fn({ penforge });
    assert.ok(call, "generated code did not call penpotUtils.penforge");
    return call;
}

function textOf(result: any, index: number = 0): string {
    const item = result.content[index];
    assert.equal(item.type, "text");
    return item.text;
}

test("tools/list exposes all contract tools and penforge_overview with JSON schemas", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [...PenforgeTools.CONTRACT_TOOL_NAMES, "penforge_overview"]) {
        const tool = byName.get(name);
        assert.ok(tool, `missing tool ${name}`);
        assert.equal(tool.inputSchema.type, "object");
        assert.ok(tool.description && tool.description.length > 20, `tool ${name} needs a description`);
    }
    assert.deepEqual(byName.get("get_node_properties")!.inputSchema.required, ["nodeId"]);
    assert.deepEqual(byName.get("update_design_node")!.inputSchema.required, ["nodeId", "mutations"]);
    assert.deepEqual(byName.get("resolve_canvas_comment")!.inputSchema.required, ["threadId"]);
    assert.deepEqual(byName.get("generate_code_hints")!.inputSchema.required, ["nodeId"]);

    const mutations: any = (byName.get("update_design_node")!.inputSchema.properties as any).mutations;
    assert.equal(mutations.additionalProperties, false);
    assert.deepEqual(Object.keys(mutations.properties).sort(), [
        "fills",
        "height",
        "layout",
        "layoutChild",
        "name",
        "opacity",
        "radius",
        "strokes",
        "text",
        "tokens",
        "visible",
        "width",
        "x",
        "y",
    ]);

    const screenshot: any = byName.get("capture_node_screenshot")!.inputSchema.properties;
    assert.equal(screenshot.scale.default, 2);
    assert.equal(screenshot.format.default, "png");
    assert.ok(screenshot.padding);
    assert.ok(screenshot.savePath, "savePath is offered when file system access is enabled");

    const comments: any = byName.get("list_canvas_comments")!.inputSchema.properties;
    assert.deepEqual(comments.status.enum, ["unresolved", "all"]);
});

test("buildCode embeds parameters as a JSON literal and rejects bad method names", async () => {
    const params = { nodeId: 'x"); globalThis.hacked = true; ("', depth: 2 };
    const code = PenforgePluginTool.buildCode("getNodeProperties", params);
    const call = await runGeneratedCode(code);
    assert.equal(call.method, "getNodeProperties");
    assert.deepEqual(call.params, params);
    assert.equal((globalThis as any).hacked, undefined);
    assert.throws(() => PenforgePluginTool.buildCode("x; evil()", {}), /Invalid Penforge plugin method name/);
});

test("generated code fails clearly on a plugin without Penforge helpers", async () => {
    const code = PenforgePluginTool.buildCode("getPrototypeGraph", {});
    const fn = new Function("penpotUtils", `return (async () => { ${code} })();`);
    await assert.rejects(fn({}), /no Penforge helpers/);
});

test("get_node_properties calls the plugin helper with defaults and returns its JSON", async (t) => {
    const codes = stubPlugin(t, () => ({ id: "n1", name: "Title" }));
    const result = await client.callTool({ name: "get_node_properties", arguments: { nodeId: "n1" } });
    assert.deepEqual(JSON.parse(textOf(result)), { id: "n1", name: "Title" });
    assert.deepEqual(await runGeneratedCode(codes[0]), {
        method: "getNodeProperties",
        params: { nodeId: "n1", depth: 1 },
    });
});

test("each read tool calls its plugin helper with the expected parameters", async (t) => {
    const codes = stubPlugin(t, () => []);
    await client.callTool({ name: "list_canvas_comments", arguments: {} });
    await client.callTool({ name: "list_canvas_comments", arguments: { pageId: "p1", status: "all" } });
    await client.callTool({ name: "resolve_canvas_comment", arguments: { threadId: "t1", resolutionNote: "Done" } });
    await client.callTool({ name: "list_boards", arguments: { pageId: "p1" } });
    await client.callTool({ name: "get_prototype_graph", arguments: {} });
    await client.callTool({ name: "generate_code_hints", arguments: { nodeId: "n1" } });
    const calls = [];
    for (const code of codes) {
        calls.push(await runGeneratedCode(code));
    }
    assert.deepEqual(calls, [
        { method: "listCanvasComments", params: { status: "unresolved" } },
        { method: "listCanvasComments", params: { status: "all", pageId: "p1" } },
        { method: "resolveCanvasComment", params: { threadId: "t1", resolutionNote: "Done" } },
        { method: "listBoards", params: { pageId: "p1" } },
        { method: "getPrototypeGraph", params: {} },
        { method: "generateCodeHints", params: { nodeId: "n1" } },
    ]);
});

test("update_design_node passes whitelisted mutations to the plugin", async (t) => {
    const codes = stubPlugin(t, () => ({ applied: ["fills"], undoGrouped: true, node: { id: "n1" } }));
    const mutations = { fills: [{ color: "#1A2B3C", opacity: 0.5 }], radius: 4, layoutChild: { margin: { top: 2 } } };
    const result = await client.callTool({ name: "update_design_node", arguments: { nodeId: "n1", mutations } });
    assert.equal(JSON.parse(textOf(result)).undoGrouped, true);
    assert.deepEqual(await runGeneratedCode(codes[0]), {
        method: "updateDesignNode",
        params: { nodeId: "n1", mutations },
    });
});

test("update_design_node rejects unknown and malformed keys without calling the plugin", async (t) => {
    const codes = stubPlugin(t, () => null);
    const cases: [object, RegExp][] = [
        [{ rotation: 45 }, /rotation/],
        [{ fills: [{ fillColor: "#FF0000" }] }, /fillColor/],
        [{ fills: [{ color: "red" }] }, /hex/],
        [{ opacity: 2 }, /opacity/],
        [{}, /at least one key/],
    ];
    for (const [mutations, expected] of cases) {
        const result: any = await client.callTool({
            name: "update_design_node",
            arguments: { nodeId: "n1", mutations },
        });
        assert.equal(result.isError, true, JSON.stringify(mutations));
        assert.match(textOf(result), expected);
    }
    assert.deepEqual(codes, []);
});

test("capture_node_screenshot returns the image with metadata, padding and optional file", async (t) => {
    const png = await sharp({
        create: { width: 4, height: 3, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
        .png()
        .toBuffer();
    const codes = stubPlugin(t, () => ({
        node: { id: "n1", name: "Card", type: "board" },
        target: "n1",
        image: { __type: "base64", data: png.toString("base64") },
    }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penforge-shot-"));
    const savePath = path.join(dir, "shots", "card.png");
    try {
        const result: any = await client.callTool({
            name: "capture_node_screenshot",
            arguments: { nodeId: "n1", padding: 2, savePath },
        });
        assert.equal(result.content[0].type, "image");
        assert.equal(result.content[0].mimeType, "image/png");
        const meta = JSON.parse(textOf(result, 1));
        assert.deepEqual(meta, {
            node: { id: "n1", name: "Card", type: "board" },
            format: "png",
            scale: 2,
            width: 8,
            height: 7,
            savedPath: savePath,
        });
        const saved = await sharp(fs.readFileSync(savePath)).metadata();
        assert.equal(saved.width, 8);
        assert.deepEqual(await runGeneratedCode(codes[0]), {
            method: "captureNodeScreenshot",
            params: { target: "n1", scale: 2, format: "png" },
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("capture_node_screenshot converts to the requested format", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 255 } } })
        .png()
        .toBuffer();
    const result = await CaptureNodeScreenshotTool.finish(new Uint8Array(png), "jpeg", 0);
    assert.equal((await sharp(result.bytes).metadata()).format, "jpeg");
    const same = await CaptureNodeScreenshotTool.finish(new Uint8Array(png), "png", 0);
    assert.equal(same.width, 2);
});

test("capture_node_screenshot hides savePath when file system access is disabled", () => {
    const remote = { isFileSystemAccessEnabled: () => false } as unknown as PenpotMcpServer;
    const tool = new CaptureNodeScreenshotTool(remote);
    assert.equal("savePath" in tool.getInputSchema(), false);
    assert.doesNotMatch(tool.getToolDescription(), /savePath/);
});

test("penforge_overview returns the guide naming every contract tool", async () => {
    const result = await client.callTool({ name: "penforge_overview", arguments: {} });
    const text = textOf(result);
    assert.equal(text, PenforgeOverviewTool.GUIDE);
    for (const name of PenforgeTools.CONTRACT_TOOL_NAMES) {
        assert.ok(text.includes(name), `guide does not mention ${name}`);
    }
});
