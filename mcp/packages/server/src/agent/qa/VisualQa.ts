import { randomBytes } from "crypto";
import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import type { AbortSignalLike, WorkflowToolsApi, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { BuildFiles } from "../build/BuildFiles";
import type { AppScreenshotter } from "./ChromeScreenshotter";
import { PixelCompare, type Region } from "./PixelCompare";
import { PngImages } from "./PngImages";
import type { QaSettings } from "./QaConfig";

/** Screen of the app to compare: a built board and its route. */
export interface QaScreen {
    boardId: string;
    name: string;
    route: string;
    pageId: string | null;
    width: number;
    height: number;
    /** screen files, relative to `app-src/` */
    files: string[];
}

/** Screen that could not be compared, and why (code for the client). */
export interface QaSkippedScreen {
    boardId: string;
    name: string;
    route: string | null;
    reason: "board-missing" | "dynamic-route" | "bad-route" | "bad-size" | "limit";
}

/** Comparison of one screen. */
export interface QaShot {
    screen: QaScreen;
    score: number;
    ssim: number;
    diffRatio: number;
    passed: boolean;
    regions: Region[];
    design: Buffer;
    app: Buffer;
    diff: Buffer;
    /** absolute paths of the saved PNGs */
    paths: { design: string; app: string; diff: string };
}

/** Steps reported as `progress {step}` while checking. */
export type QaStep = "preview" | "browser" | "design" | "app" | "compare" | "checkpoint" | "fix" | "save";

/** What the QA needs from its caller (a workflow run or the chat tool). */
export interface QaEnv {
    workspace: WorkflowWorkspaceApi;
    tools: WorkflowToolsApi;
    /** the Penpot file whose boards are compared */
    fileId: string;
    signal?: AbortSignalLike;
    /** progress report; `text` is the English fallback */
    progress(step: QaStep, params: Record<string, unknown>, text: string): void;
}

/** Failure the client can explain; `code` is stable, `message` is English. */
export class QaError extends Error {
    constructor(
        message: string,
        public readonly code:
            "not-built" | "other-file" | "no-screens" | "busy" | "no-preview" | "no-browser" | "design-unavailable"
    ) {
        super(message);
        this.name = "QaError";
    }
}

/**
 * One visual QA run: compares design boards (Penpot export at scale 1) with screenshots of the
 * running app at the boards' sizes, and saves design, app and heatmap PNGs in
 * `.penforge/qa/<run>/`.
 */
export class VisualQa {
    /** runs kept in `.penforge/qa/` */
    public static readonly KEPT_RUNS = 10;
    private readonly designCache = new Map<string, Buffer>();

    /**
     * @param env - workspace, tools and progress of the caller
     * @param settings - project settings
     * @param browser - screenshotter of the app
     * @param appUrl - base URL of the running app (loopback)
     * @param runName - folder name of the run below `.penforge/qa/`
     */
    constructor(
        private readonly env: QaEnv,
        private readonly settings: QaSettings,
        private readonly browser: AppScreenshotter,
        private readonly appUrl: string,
        public readonly runName: string
    ) {}

    /** Folder of the run's files. */
    public get runDir(): string {
        return VisualQa.runDir(this.env.workspace, this.runName);
    }

    /** Score a screen needs to match. */
    public get threshold(): number {
        return this.settings.threshold;
    }

    /** New run folder name: `<yyyymmddThhmmss>-<4 hex>`. */
    public static newRunName(now = new Date()): string {
        const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
        return `${stamp}-${randomBytes(2).toString("hex")}`;
    }

    public static runDir(workspace: WorkflowWorkspaceApi, runName: string): string {
        return workspace.resolve(join(workspace.metaDir, "qa", runName));
    }

    /**
     * Lists the screens of the last build (`.penforge/map.json`) with their current board sizes.
     *
     * @param env - workspace and tools
     * @param boardIds - only these boards (all screens when empty)
     * @returns the screens to compare and the ones that cannot be
     * @throws QaError `not-built`, `other-file`, `no-screens`, `design-unavailable`
     */
    public static async screens(
        env: QaEnv,
        boardIds: string[] = []
    ): Promise<{ screens: QaScreen[]; skipped: QaSkippedScreen[] }> {
        const map = await new BuildFiles(env.workspace).readMap();
        if (!map) {
            throw new QaError("The app has not been built yet.", "not-built");
        }
        if (map.fileId !== env.fileId) {
            throw new QaError("The app was built from another file of this project.", "other-file");
        }
        const wanted = new Set(boardIds);
        const built = Object.entries(map.boards).filter(
            ([id, board]) => board.route !== null && (wanted.size === 0 || wanted.has(id))
        );
        if (built.length === 0) {
            throw new QaError("No screen of the app matches the request.", "no-screens");
        }
        const listing = await env.tools.call("list_boards", {});
        if (listing.isError) {
            throw new QaError(`The design could not be read: ${listing.text}`, "design-unavailable");
        }
        const boards = new Map((VisualQa.parseJson(listing.text) as any[]).map((board) => [String(board.id), board]));
        const screens: QaScreen[] = [];
        const skipped: QaSkippedScreen[] = [];
        for (const [boardId, entry] of built) {
            const board = boards.get(boardId);
            const route = entry.route as string;
            const width = Math.round(Number(board?.width));
            const height = Math.round(Number(board?.height));
            if (!board) {
                skipped.push({ boardId, name: entry.name, route, reason: "board-missing" });
            } else if (!VisualQa.isPlainRoute(route)) {
                skipped.push({ boardId, name: entry.name, route, reason: "bad-route" });
            } else if (route.includes(":")) {
                skipped.push({ boardId, name: entry.name, route, reason: "dynamic-route" });
            } else if (!VisualQa.isViewportSide(width) || !VisualQa.isViewportSide(height)) {
                skipped.push({ boardId, name: entry.name, route, reason: "bad-size" });
            } else {
                screens.push({
                    boardId,
                    name: String(board.name ?? entry.name),
                    route,
                    pageId: board.pageId ? String(board.pageId) : null,
                    width,
                    height,
                    files: entry.files,
                });
            }
        }
        return { screens, skipped };
    }

    /**
     * Compares one screen and saves its PNGs.
     *
     * @param screen - the screen
     * @param suffix - file name suffix ("" for the latest state, e.g. "-before" for the first one)
     */
    public async check(screen: QaScreen, suffix = ""): Promise<QaShot> {
        const design = await this.designShot(screen);
        this.env.progress("app", { name: screen.name }, `Opening ${screen.name} in the app`);
        if (!VisualQa.isPlainRoute(screen.route)) {
            throw new Error(`Not a route of the app: ${screen.route}`);
        }
        const app = await this.browser.capture({
            url: new URL(screen.route, this.appUrl).toString(),
            origin: new URL(this.appUrl).origin,
            width: screen.width,
            height: screen.height,
            settleMs: this.settings.settleMs,
        });
        VisualQa.checkAborted(this.env.signal);
        this.env.progress("compare", { name: screen.name }, `Comparing ${screen.name}`);
        const designImage = PngImages.fit(await PngImages.decode(design), screen.width, screen.height);
        const appImage = PngImages.fit(await PngImages.decode(app), screen.width, screen.height);
        const comparison = PixelCompare.compare(designImage, appImage, this.settings.pixelThreshold);
        const appPng = await PngImages.encode(appImage);
        const diffPng = await PngImages.encode(comparison.heatmap);
        const designPng = await PngImages.encode(designImage);
        const base = join(this.runDir, VisualQa.slug(screen));
        const paths = {
            design: `${base}-design.png`,
            app: `${base}-app${suffix}.png`,
            diff: `${base}-diff${suffix}.png`,
        };
        await mkdir(this.runDir, { recursive: true });
        await Promise.all([
            writeFile(paths.design, designPng),
            writeFile(paths.app, appPng),
            writeFile(paths.diff, diffPng),
        ]);
        return {
            screen,
            score: comparison.score,
            ssim: comparison.ssim,
            diffRatio: comparison.diffRatio,
            passed: comparison.score >= this.settings.threshold,
            regions: comparison.regions,
            design: designPng,
            app: appPng,
            diff: diffPng,
            paths,
        };
    }

    /**
     * Writes a JSON file into the run folder.
     */
    public async writeReport(report: unknown): Promise<string> {
        await mkdir(this.runDir, { recursive: true });
        const file = join(this.runDir, "report.json");
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        return file;
    }

    /** Path relative to the project folder, forward slashes (for reports and prompts). */
    public projectPath(file: string): string {
        return relative(this.env.workspace.root, file).split("\\").join("/");
    }

    /**
     * Deletes the oldest run folders, keeping {@link KEPT_RUNS}.
     */
    public static async prune(workspace: WorkflowWorkspaceApi, keep = VisualQa.KEPT_RUNS): Promise<void> {
        const dir = workspace.resolve(join(workspace.metaDir, "qa"));
        let names: string[];
        try {
            names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
        } catch {
            return;
        }
        const old = names
            .filter((name) => /^\d{8}T\d{6}-[0-9a-f]{4}$/.test(name))
            .sort()
            .slice(0, -keep);
        await Promise.all(old.map((name) => rm(join(dir, name), { recursive: true, force: true }).catch(() => {})));
    }

    /** Design board as PNG at scale 1, captured once per run (the QA never changes the design). */
    private async designShot(screen: QaScreen): Promise<Buffer> {
        const cached = this.designCache.get(screen.boardId);
        if (cached) {
            return cached;
        }
        this.env.progress("design", { name: screen.name }, `Capturing ${screen.name} from the design`);
        const result = await this.env.tools.call("capture_node_screenshot", {
            nodeId: screen.boardId,
            scale: 1,
            format: "png",
        });
        const image = result.content.find((part: any) => part?.type === "image" && typeof part.data === "string") as
            { data: string } | undefined;
        if (result.isError || !image) {
            throw new QaError(
                `The design board ${screen.name} could not be captured: ${result.text}`,
                "design-unavailable"
            );
        }
        VisualQa.checkAborted(this.env.signal);
        const bytes = Buffer.from(image.data, "base64");
        this.designCache.set(screen.boardId, bytes);
        return bytes;
    }

    /** largest board side the QA opens as a viewport */
    public static readonly MAX_VIEWPORT_SIDE = 8000;

    /** A path on the app's own server: `/…`, never `//host` or a URL. */
    public static isPlainRoute(route: string): boolean {
        return /^\/(?![/\\])[^\s\\]*$/.test(route);
    }

    private static isViewportSide(value: number): boolean {
        return Number.isFinite(value) && value >= 1 && value <= VisualQa.MAX_VIEWPORT_SIDE;
    }

    private static slug(screen: QaScreen): string {
        const name = screen.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40);
        return `${name || "screen"}-${screen.boardId.replace(/[^A-Za-z0-9]/g, "").slice(-8)}`;
    }

    private static parseJson(text: string): unknown {
        try {
            const value = JSON.parse(text);
            return Array.isArray(value) ? value : [];
        } catch {
            return [];
        }
    }

    public static checkAborted(signal: AbortSignalLike | undefined): void {
        if (signal?.aborted) {
            throw new Error("cancelled");
        }
    }
}
