import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BrowserLocator, ChromeScreenshotter } from "./ChromeScreenshotter";
import { PixelCompare, type RgbaImage } from "./PixelCompare";
import { PngImages } from "./PngImages";
import { DevServerPreviewAccess, PreviewUnavailableError } from "./PreviewAccess";
import { QaChat } from "./QaChat";
import type { VisualQaServices } from "./QaRun";
import { QaSessionTools } from "./QaSessionTools";
import { QaToolFilter } from "./QaToolFilter";
import { FakeBrowser, FakePenpot, FakePreviews, renderScreen, SCREENS, screenCss } from "./testing/fakes";
import { CommandPolicy } from "../process/CommandPolicy";
import { DevServerManager } from "../process/DevServerManager";
import { PortPool } from "../process/PortPool";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";

/** Solid image of one colour. */
function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data.set(rgba, i * 4);
    }
    return { width, height, data };
}

/** Paints a rectangle into an image. */
function paint(image: RgbaImage, x: number, y: number, w: number, h: number, rgba: [number, number, number, number]) {
    for (let row = y; row < y + h; row++) {
        for (let col = x; col < x + w; col++) {
            image.data.set(rgba, (row * image.width + col) * 4);
        }
    }
    return image;
}

describe("PixelCompare", () => {
    test("identical images score 100", () => {
        const a = paint(solid(64, 48, [255, 255, 255, 255]), 8, 8, 20, 10, [30, 60, 200, 255]);
        const b = paint(solid(64, 48, [255, 255, 255, 255]), 8, 8, 20, 10, [30, 60, 200, 255]);

        const result = PixelCompare.compare(a, b);

        assert.equal(result.diffRatio, 0);
        assert.ok(Math.abs(result.ssim - 1) < 1e-9);
        assert.equal(result.score, 100);
        assert.deepEqual(result.regions, []);
    });

    test("measures the differing share and locates it", () => {
        const design = solid(64, 64, [255, 255, 255, 255]);
        const app = paint(solid(64, 64, [255, 255, 255, 255]), 32, 16, 16, 16, [255, 0, 0, 255]);

        const result = PixelCompare.compare(design, app);

        assert.equal(result.diffRatio, (16 * 16) / (64 * 64));
        assert.ok(result.ssim < 1);
        assert.ok(result.score < 100 && result.score > 50);
        assert.deepEqual(result.regions, [{ x: 32, y: 16, width: 16, height: 16 }]);
        // the heatmap marks the differing pixels red and fades the rest
        const at = (x: number, y: number) =>
            Array.from(result.heatmap.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
        assert.equal(at(40, 20)[0], 255);
        assert.ok(at(40, 20)[1] < 64);
        assert.deepEqual(at(0, 0), [255, 255, 255, 255]);
    });

    test("tolerates small colour differences below the threshold", () => {
        const design = solid(16, 16, [100, 100, 100, 255]);
        const app = solid(16, 16, [102, 101, 100, 255]);

        assert.equal(PixelCompare.compare(design, app).diffRatio, 0);
    });

    test("blends transparent pixels on white", () => {
        assert.equal(PixelCompare.compare(solid(8, 8, [0, 0, 0, 0]), solid(8, 8, [255, 255, 255, 255])).score, 100);
    });

    test("a bigger difference gives a lower score", () => {
        const design = solid(64, 64, [255, 255, 255, 255]);
        const small = paint(solid(64, 64, [255, 255, 255, 255]), 0, 0, 16, 16, [0, 0, 0, 255]);
        const large = paint(solid(64, 64, [255, 255, 255, 255]), 0, 0, 40, 40, [0, 0, 0, 255]);

        assert.ok(PixelCompare.compare(design, large).score < PixelCompare.compare(design, small).score);
    });

    test("refuses images of different sizes", () => {
        assert.throws(() => PixelCompare.compare(solid(4, 4, [0, 0, 0, 255]), solid(4, 5, [0, 0, 0, 255])), /size/);
    });
});

describe("PngImages", () => {
    test("fit crops and pads with white without scaling", async () => {
        const image = paint(solid(4, 4, [0, 0, 0, 255]), 0, 0, 1, 1, [255, 0, 0, 255]);

        const fitted = PngImages.fit(image, 6, 2);

        assert.equal(fitted.width, 6);
        assert.equal(fitted.height, 2);
        assert.deepEqual(Array.from(fitted.data.subarray(0, 4)), [255, 0, 0, 255]);
        assert.deepEqual(Array.from(fitted.data.subarray(5 * 4, 6 * 4)), [255, 255, 255, 255]);
        const round = await PngImages.decode(await PngImages.encode(fitted));
        assert.deepEqual(Array.from(round.data), Array.from(fitted.data));
    });
});

describe("QaToolFilter", () => {
    const root = join(tmpdir(), "project-x");
    const filter = new QaToolFilter(root, join(root, "app-src"));

    test("allows reading and changing the app only", () => {
        assert.equal(filter.check("Read", { file_path: join(root, "design", "DESIGN.md") }), null);
        assert.equal(filter.check("Edit", { file_path: join(root, "app-src", "src", "App.tsx") }), null);
        assert.equal(filter.check("Write", { file_path: "app-src/src/new.css" }), null);
        assert.notEqual(filter.check("Write", { file_path: join(root, "app-src") }), null);
        assert.notEqual(filter.check("Edit", { file_path: join(root, "app-src", "..", "design", "x.md") }), null);
        assert.notEqual(filter.check("Write", { file_path: join(root, ".penforge", "qa.json") }), null);
        assert.notEqual(filter.check("Bash", { command: "npm run build" }), null);
        assert.notEqual(filter.check("WebFetch", { url: "https://example.com" }), null);
    });

    test("allows reading the design, never changing it", () => {
        assert.equal(filter.check("mcp__penpot__generate_code_hints", { nodeId: "x" }), null);
        assert.equal(filter.check("mcp__penpot__capture_node_screenshot", { nodeId: "x" }), null);
        for (const tool of [
            "execute_code",
            "update_design_node",
            "resolve_canvas_comment",
            "import_image",
            "penforge_visual_qa",
        ]) {
            assert.notEqual(filter.check(`mcp__penpot__${tool}`, {}), null, tool);
        }
    });
});

describe("QaSessionTools", () => {
    const error =
        "Tool execution failed: Error: Multiple Penpot sessions are connected. Ask the user to select one of " +
        "the active sessions, then retry with its sessionId:\n" +
        's-1: "A" (file f-a)\n' +
        "s-2: no active workspace\n" +
        's-3: "B (copy)" (file f-b)';

    test("finds the session of a file in the dispatcher's error", () => {
        assert.equal(QaSessionTools.sessionOfFile(error, "f-b"), "s-3");
        assert.equal(QaSessionTools.sessionOfFile(error, "f-x"), null);
        assert.equal(QaSessionTools.sessionOfFile("Tool execution failed: node not found", "f-a"), null);
    });

    test("keeps the session of the tab when it is known", async () => {
        const penpot = new FakePenpot({});
        penpot.multipleSessions = error;
        const tools = new QaSessionTools(penpot, "f-a", "s-1");

        const result = await tools.call("list_boards");

        assert.equal(result.isError, false);
        assert.deepEqual(
            penpot.calls.map((c) => c.args.sessionId),
            ["s-1"]
        );
    });
});

describe("DevServerPreviewAccess", () => {
    /** Dev server manager stand-in with the public API the QA uses. */
    function manager(states: { state: string; url?: string; reason?: string }[]) {
        const watchers = new Set<any>();
        let disposed = 0;
        return {
            disposed: () => disposed,
            manager: {
                watch: (_projectId: string, observer: any) => {
                    watchers.add(observer);
                    return { dispose: () => (disposed++, watchers.delete(observer)) };
                },
                start: async () => {
                    setTimeout(() => states.slice(1).forEach((s) => watchers.forEach((w) => w.onStatus(s))), 5);
                    return states[0];
                },
            } as any,
        };
    }
    const workspaces = { get: async (projectId: string) => ({ projectId }) as any };

    test("waits until the dev server is ready and holds it until released", async () => {
        const fake = manager([{ state: "starting" }, { state: "ready", url: "http://127.0.0.1:5201/" }]);

        const lease = await new DevServerPreviewAccess(fake.manager, workspaces).acquire("p1");

        assert.equal(lease.url, "http://127.0.0.1:5201/");
        assert.equal(fake.disposed(), 0);
        lease.release();
        assert.equal(fake.disposed(), 1);
    });

    test("reports a dev server that fails to start", async () => {
        const fake = manager([{ state: "starting" }, { state: "failed", reason: "start-timeout" }]);

        await assert.rejects(
            new DevServerPreviewAccess(fake.manager, workspaces).acquire("p1"),
            (error: unknown) => error instanceof PreviewUnavailableError && error.code === "no-preview"
        );
        assert.equal(fake.disposed(), 1);
    });
});

describe("QaChat (penforge_visual_qa)", () => {
    let projectsDir: string;
    let workspace: ProjectWorkspace;
    let services: VisualQaServices;

    beforeEach(async () => {
        projectsDir = mkdtempSync(join(tmpdir(), "penforge-qa-chat-"));
        workspace = new ProjectWorkspace(projectsDir, "project-7");
        await workspace.ensure();
        await workspace.writeJson("project.json", { projectId: "project-7", fileIds: ["file-7"], updatedAt: "x" });
        await workspace.writeJson("qa.json", { threshold: 95, settleMs: 0 });
        mkdirSync(join(workspace.appSrcDir, "src"), { recursive: true });
        const good = { headerColor: "#222222", buttonColor: "#3366ff", buttonTop: 200 };
        writeFileSync(join(workspace.appSrcDir, "src", "home.css"), screenCss({ ...good, buttonColor: "#ff0000" }));
        writeFileSync(join(workspace.appSrcDir, "src", "login.css"), screenCss(good));
        await workspace.writeJson("map.json", {
            schemaVersion: 1,
            builtAt: "x",
            fileId: "file-7",
            commit: null,
            boards: {
                [SCREENS.home.boardId]: { name: "Home", hash: "a", route: "/", files: ["src/home.css"] },
                [SCREENS.login.boardId]: { name: "Login", hash: "b", route: "/login", files: ["src/login.css"] },
            },
        });
        const design = await renderScreen(good);
        services = {
            previews: new FakePreviews(),
            browsers: new FakeBrowser(workspace.appSrcDir),
            workspaces: { get: async (id: string) => (id === "project-7" ? workspace : Promise.reject(new Error(id))) },
            projectsDir,
            tools: {
                forSession: () => new FakePenpot({ [SCREENS.home.boardId]: design, [SCREENS.login.boardId]: design }),
            },
        };
    });

    afterEach(() => rmSync(projectsDir, { recursive: true, force: true }));

    test("checks the project of the file and returns scores and the worst screen's images", async () => {
        const content = await new QaChat(services).handle({ fileId: "file-7" });

        const summary = JSON.parse((content[0] as { text: string }).text);
        assert.equal(summary.screens.length, 2);
        const home = summary.screens.find((s: any) => s.name === "Home");
        assert.equal(home.passed, false);
        assert.deepEqual(home.files, ["src/home.css"]);
        assert.match(home.paths.diff, /^\.penforge\/qa\//);
        assert.equal(content.filter((part) => part.type === "image").length, 3);
        assert.match((content.at(-1) as { text: string }).text, /commit: true/);
    });

    test("commits the code changes on request", async () => {
        const content = await new QaChat(services).handle({ fileId: "file-7", commit: true });

        assert.ok(JSON.parse((content[0] as { text: string }).text).commit);
    });

    test("explains a known failure instead of throwing", async () => {
        rmSync(join(workspace.metaDir, "map.json"));

        const content = await new QaChat(services).handle({ fileId: "file-7" });

        assert.equal(JSON.parse((content[0] as { text: string }).text).error, "not-built");
    });

    test("needs a project that opened the file", async () => {
        await assert.rejects(new QaChat(services).handle({ fileId: "file-unknown" }), /No Penforge project/);
    });
});

describe("ChromeScreenshotter", () => {
    test("opens only pages of this machine", () => {
        assert.doesNotThrow(() => ChromeScreenshotter.checkUrl("http://127.0.0.1:5200/login"));
        assert.doesNotThrow(() => ChromeScreenshotter.checkUrl("http://localhost:5200/"));
        assert.throws(() => ChromeScreenshotter.checkUrl("http://192.168.1.4:5200/"), /this machine/);
        assert.throws(() => ChromeScreenshotter.checkUrl("file:///etc/passwd"), /this machine/);
        assert.throws(() => ChromeScreenshotter.checkUrl("not a url"), /valid/);
    });

    test("finds a configured browser and ignores a missing one", () => {
        assert.equal(BrowserLocator.find({ PENFORGE_QA_BROWSER: join(tmpdir(), "no-such-browser.exe") }), null);
        assert.equal(BrowserLocator.find({ PENFORGE_QA_BROWSER: process.execPath }), process.execPath);
    });

    const browserPath = BrowserLocator.find();
    test(
        "screenshots a page at the viewport size",
        { skip: browserPath ? false : "no Chrome/Edge on this machine" },
        async () => {
            const server: Server = createServer((_req, res) => {
                res.setHeader("content-type", "text/html");
                res.end(
                    "<!doctype html><html><body style='margin:0;background:#ffffff'>" +
                        "<div style='height:60px;background:#222222'></div>" +
                        "<div style='margin:140px 20px 0;height:60px;background:#3366ff'></div></body></html>"
                );
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const port = (server.address() as { port: number }).port;
            const browser = await ChromeScreenshotter.launch(browserPath!);
            try {
                const png = await browser.capture({
                    url: `http://127.0.0.1:${port}/`,
                    width: 200,
                    height: 300,
                    settleMs: 0,
                });
                const image = await PngImages.decode(png);
                assert.equal(image.width, 200);
                assert.equal(image.height, 300);
                const design = await PngImages.decode(
                    await renderScreen({ headerColor: "#222222", buttonColor: "#3366ff", buttonTop: 200 })
                );
                // same layout as the SVG design except the rounded corners
                assert.ok(PixelCompare.compare(design, image).score >= 95);
            } finally {
                await browser.close();
                server.close();
            }
        }
    );
});

describe("dev server and browser together", () => {
    const browserPath = BrowserLocator.find();
    const fakeServer = join(dirname(fileURLToPath(import.meta.url)), "..", "process", "testing", "fakeDevServer.mjs")
        .split("\\")
        .join("/");

    test(
        "starts the project's dev server and screenshots it at the board size",
        { skip: browserPath ? false : "no Chrome/Edge on this machine" },
        async () => {
            const projectsDir = mkdtempSync(join(tmpdir(), "penforge-qa-dev-"));
            const workspace = new ProjectWorkspace(projectsDir, "project-dev");
            await workspace.ensure();
            await workspace.writeJson("stack.json", { commands: { dev: ["node", fakeServer, "serve"] } });
            const manager = new DevServerManager({
                ports: new PortPool(47380, 47389),
                probeIntervalMs: 50,
                commandPolicy: new CommandPolicy(["node"]),
            });
            const lease = await new DevServerPreviewAccess(manager, { get: async () => workspace }).acquire(
                "project-dev"
            );
            const browser = await ChromeScreenshotter.launch(browserPath!);
            try {
                assert.match(lease.url, /^http:\/\/(127\.0\.0\.1|localhost):4738\d\/$/);
                const png = await browser.capture({ url: lease.url, width: 320, height: 240, settleMs: 0 });
                const image = await PngImages.decode(png);
                assert.deepEqual([image.width, image.height], [320, 240]);
            } finally {
                await browser.close();
                lease.release();
                await manager.stopAll();
                rmSync(projectsDir, { recursive: true, force: true });
            }
        }
    );
});
