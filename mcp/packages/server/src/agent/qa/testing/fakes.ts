import { readFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import type { WorkflowToolResult, WorkflowToolsApi } from "@penpot/mcp-common";
import type { AppScreenshotter, AppScreenshotterFactory, AppShotRequest } from "../ChromeScreenshotter";
import type { PreviewAccess, PreviewLease } from "../PreviewAccess";

/**
 * Look of a test screen: a dark header and one button, as the design draws it and as the fake
 * app renders it from CSS custom properties in `app-src/src/<screen>.css`.
 */
export interface ScreenLook {
    headerColor: string;
    buttonColor: string;
    buttonTop: number;
}

/** Two-screen test app: route → screen file. */
export const SCREENS = {
    home: { boardId: "board-home", name: "Home", route: "/", width: 200, height: 300 },
    login: { boardId: "board-login", name: "Login", route: "/login", width: 200, height: 300 },
} as const;

/** Renders a screen as PNG with sharp (SVG input). */
export async function renderScreen(look: ScreenLook, width = 200, height = 300): Promise<Buffer> {
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
        `<rect width="${width}" height="${height}" fill="#ffffff"/>` +
        `<rect width="${width}" height="60" fill="${look.headerColor}"/>` +
        `<rect x="20" y="${look.buttonTop}" width="160" height="60" rx="8" fill="${look.buttonColor}"/>` +
        "</svg>";
    return sharp(Buffer.from(svg)).png().toBuffer();
}

/** CSS of a screen file. */
export function screenCss(look: ScreenLook): string {
    return (
        ":root {\n" +
        `  --header-color: ${look.headerColor};\n` +
        `  --button-color: ${look.buttonColor};\n` +
        `  --button-top: ${look.buttonTop}px;\n` +
        "}\n"
    );
}

/** Reads a look back from a screen's CSS. */
export function parseCss(css: string): ScreenLook {
    const value = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim() ?? "";
    return {
        headerColor: value("header-color"),
        buttonColor: value("button-color"),
        buttonTop: parseInt(value("button-top"), 10),
    };
}

/**
 * Penpot behind the tools the QA calls: `list_boards` and `capture_node_screenshot`.
 */
export class FakePenpot implements WorkflowToolsApi {
    public readonly calls: { name: string; args: Record<string, unknown> }[] = [];
    /** answer every call without `sessionId` with the "Multiple Penpot sessions" error */
    public multipleSessions: string | null = null;

    constructor(private readonly designs: Record<string, Buffer>) {}

    public async call(name: string, args: Record<string, unknown> = {}): Promise<WorkflowToolResult> {
        this.calls.push({ name, args });
        if (this.multipleSessions && args.sessionId === undefined) {
            return { isError: true, content: [], text: this.multipleSessions };
        }
        switch (name) {
            case "list_boards":
                return FakePenpot.json(
                    Object.values(SCREENS).map((screen) => ({
                        id: screen.boardId,
                        name: screen.name,
                        pageId: "page-1",
                        pageName: "Screens",
                        x: 0,
                        y: 0,
                        width: screen.width,
                        height: screen.height,
                    }))
                );
            case "capture_node_screenshot": {
                const png = this.designs[String(args.nodeId)];
                if (!png) {
                    return { isError: true, content: [], text: "Tool execution failed: node not found" };
                }
                return {
                    isError: false,
                    content: [
                        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
                        { type: "text", text: "{}" },
                    ],
                    text: "{}",
                };
            }
            default:
                return { isError: true, content: [], text: `Tool execution failed: ${name} is not allowed` };
        }
    }

    public async list(): Promise<string[]> {
        return ["list_boards", "capture_node_screenshot"];
    }

    private static json(value: unknown): WorkflowToolResult {
        return { isError: false, content: [], text: JSON.stringify(value) };
    }
}

/**
 * Browser rendering the test app from `app-src/src/<screen>.css` (no real browser needed).
 */
export class FakeBrowser implements AppScreenshotter, AppScreenshotterFactory {
    public readonly shots: AppShotRequest[] = [];
    public opened = 0;
    public closed = 0;

    constructor(private readonly appSrcDir: string) {}

    public async open(): Promise<AppScreenshotter> {
        this.opened++;
        return this;
    }

    public async capture(request: AppShotRequest): Promise<Buffer> {
        this.shots.push(request);
        const path = new URL(request.url).pathname;
        const screen = path === "/" ? "home" : path.replace(/^\//, "");
        const look = parseCss(readFileSync(join(this.appSrcDir, "src", `${screen}.css`), "utf8"));
        return renderScreen(look, request.width, request.height);
    }

    public async close(): Promise<void> {
        this.closed++;
    }
}

/** Dev server stand-in that is always ready. */
export class FakePreviews implements PreviewAccess {
    public acquired = 0;
    public released = 0;

    constructor(public readonly url = "http://127.0.0.1:5299/") {}

    public async acquire(): Promise<PreviewLease> {
        this.acquired++;
        return { url: this.url, release: () => this.released++ };
    }
}
