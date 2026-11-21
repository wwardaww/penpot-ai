import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PenpotMcpServer } from "../../PenpotMcpServer";
import { AnimationSpecMap } from "./GetAnimationSpecTool";

let server: PenpotMcpServer;
let client: Client;
let previousEnv: NodeJS.ProcessEnv;
let home: string;
let nextPort = 17_650;

beforeEach(async () => {
    previousEnv = { ...process.env };
    home = fs.mkdtempSync(path.join(os.tmpdir(), "penforge-w32-"));
    process.env.PENFORGE_HOME = home;
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
        { name: "penforge-w32-test", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
});

afterEach(async () => {
    await client?.close();
    await server?.stop();
    process.env = previousEnv;
    fs.rmSync(home, { recursive: true, force: true });
});

/** Replaces the plugin bridge call with a stub that records the code and returns the given result. */
function stubPlugin(t: any, result: (code: string) => unknown): string[] {
    const codes: string[] = [];
    t.mock.method(server.pluginBridge, "executePluginTask", async (task: any) => {
        codes.push(task.params.code);
        return { data: { result: result(task.params.code), log: "" } };
    });
    return codes;
}

/** Runs generated plugin code against a fake `penpotUtils` and returns the method call it makes. */
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

function textOf(result: any): string {
    const item = result.content[0];
    assert.equal(item.type, "text");
    return item.text;
}

const fadeUp = {
    effects: [{ type: "fade" }, { type: "slide", direction: "up", distance: 16 }],
    duration: 300,
    easing: "ease-out",
    stagger: { each: 60 },
};

test("tools/list exposes the three animation tools", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["get_animations", "update_animations", "get_animation_spec"]) {
        const tool = byName.get(name);
        assert.ok(tool, `missing tool ${name}`);
        assert.ok(tool.description && tool.description.length > 50);
    }
    assert.deepEqual(byName.get("update_animations")!.inputSchema.required, ["operations"]);
    assert.deepEqual(byName.get("get_animation_spec")!.inputSchema.required, ["fileId"]);
    assert.match(byName.get("update_animations")!.description!, /150-400 ms/);
});

test("update_animations passes the operations to the plugin helper", async (t) => {
    const codes = stubPlugin(t, () => ({ pageId: "p1", undoGrouped: true, results: [] }));
    const operations = [
        { op: "set", nodeId: "list", entrance: fadeUp },
        { op: "update", nodeId: "button", states: { hover: { scale: 1.03 }, press: null } },
        { op: "set", nodeId: "spinner", loop: { type: "spin", duration: 900, count: "infinite" } },
        { op: "set-smart", nodeId: "row", index: 0, duration: 300, easing: { type: "spring", damping: 20 } },
        { op: "remove", nodeId: "old", sections: ["exit", "hover"] },
        { op: "remove-smart", nodeId: "row", index: 1 },
    ];
    const result = await client.callTool({ name: "update_animations", arguments: { operations } });
    assert.equal(JSON.parse(textOf(result)).undoGrouped, true);
    assert.deepEqual(await runGeneratedCode(codes[0]), { method: "updateAnimations", params: { operations } });
});

test("update_animations rejects malformed operations without calling the plugin", async (t) => {
    const codes = stubPlugin(t, () => null);
    const cases: [object[], RegExp][] = [
        [[], /operations/],
        [[{ op: "animate", nodeId: "a" }], /op/],
        [[{ op: "set", nodeId: "a", entrance: { effects: [{ type: "wobble" }], duration: 300 } }], /type|wobble/],
        [[{ op: "set", nodeId: "a", entrance: { duration: 300, easing: "bouncy" } }], /easing/],
        [[{ op: "set", nodeId: "a", glow: {} }], /glow|Unrecognized/],
        [[{ op: "set", nodeId: "a", states: { focus: { scale: 1 } } }], /focus|Unrecognized/],
        [[{ op: "set", nodeId: "a", states: { hover: { fill: "red" } } }], /hex/],
        [[{ op: "set-smart", nodeId: "a", index: -1 }], /index/],
    ];
    for (const [operations, expected] of cases) {
        const result: any = await client.callTool({ name: "update_animations", arguments: { operations } });
        assert.equal(result.isError, true, JSON.stringify(operations));
        assert.match(textOf(result), expected, JSON.stringify(operations));
    }
    assert.deepEqual(codes, []);
});

test("get_animations sends one target, nodeIds first", async (t) => {
    const codes = stubPlugin(t, () => ({ layers: [], count: 0 }));
    await client.callTool({ name: "get_animations", arguments: { nodeIds: ["a"], boardId: "b" } });
    await client.callTool({ name: "get_animations", arguments: { boardId: "b", pageId: "p" } });
    await client.callTool({ name: "get_animations", arguments: {} });
    assert.deepEqual(await Promise.all(codes.map(runGeneratedCode)), [
        { method: "getAnimations", params: { nodeIds: ["a"] } },
        { method: "getAnimations", params: { boardId: "b" } },
        { method: "getAnimations", params: {} },
    ]);
});

/** The plugin's spec for a file with one animated screen. */
function pluginSpec(fileId: string): any {
    return {
        version: 1,
        fileId,
        fileName: "Todo",
        layerCount: 1,
        pages: [
            {
                pageId: "p1",
                pageName: "App",
                boards: [
                    {
                        boardId: "home",
                        boardName: "Home",
                        componentName: "Home",
                        layers: [{ nodeId: "list", name: "Card List", animations: { v: 1, entrance: fadeUp } }],
                    },
                    { boardId: "draft", boardName: "Draft", componentName: "Draft", layers: [] },
                ],
                otherLayers: [],
            },
        ],
    };
}

/** Creates a Penforge project folder listing the file, with an optional build map. */
function project(fileId: string, map?: object): void {
    const meta = path.join(home, "projects", "proj-1", ".penforge");
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(
        path.join(meta, "project.json"),
        JSON.stringify({ projectId: "proj-1", fileIds: [fileId], updatedAt: "2026-11-21T00:00:00Z" })
    );
    if (map) {
        fs.writeFileSync(path.join(meta, "map.json"), JSON.stringify(map));
    }
}

test("get_animation_spec adds the routes and files of the last build", async (t) => {
    project("file-1", {
        schemaVersion: 1,
        builtAt: "2026-11-20T10:00:00Z",
        fileId: "file-1",
        commit: "abc123",
        boards: { home: { name: "Home", hash: "h", route: "/", files: ["src/screens/Home.tsx"] } },
    });
    const codes = stubPlugin(t, () => pluginSpec("file-1"));
    const result = await client.callTool({ name: "get_animation_spec", arguments: { fileId: "file-1" } });
    const spec = JSON.parse(textOf(result));
    assert.deepEqual(await runGeneratedCode(codes[0]), { method: "getAnimationSpec", params: {} });
    assert.deepEqual(spec.map, { found: true, builtAt: "2026-11-20T10:00:00Z", commit: "abc123" });
    assert.deepEqual(
        spec.pages[0].boards.map((b: any) => [b.boardId, b.built, b.route, b.files]),
        [
            ["home", true, "/", ["src/screens/Home.tsx"]],
            ["draft", false, null, []],
        ]
    );
    assert.deepEqual(spec.pages[0].boards[0].layers[0].animations.entrance, fadeUp);
});

test("get_animation_spec works without a build and refuses another tab's file", async (t) => {
    stubPlugin(t, () => pluginSpec("file-1"));
    const spec = JSON.parse(
        textOf(await client.callTool({ name: "get_animation_spec", arguments: { fileId: "file-1" } }))
    );
    assert.deepEqual(spec.map, { found: false, builtAt: null, commit: null });
    assert.equal(spec.pages[0].boards[0].route, null);

    const other: any = await client.callTool({ name: "get_animation_spec", arguments: { fileId: "file-2" } });
    assert.equal(other.isError, true);
    assert.match(textOf(other), /has file file-1 open, not file-2/);
});

test("a build map of another file gives no hints", () => {
    const spec = AnimationSpecMap.attach(pluginSpec("file-1"), {
        fileId: "file-9",
        builtAt: "x",
        boards: { home: { route: "/", files: ["a.tsx"] } },
    });
    assert.equal(spec.map.found, false);
    assert.equal(spec.pages[0].boards[0].built, false);
    assert.equal(spec.pages[0].boards[0].route, null);
});
