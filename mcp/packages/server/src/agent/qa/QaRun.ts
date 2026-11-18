import type { WorkflowToolsApi } from "@penpot/mcp-common";
import { BuildLock } from "../build/BuildLock";
import type { WorkspaceManager } from "../workspace/WorkspaceManager";
import { BrowserUnavailableError, type AppScreenshotter, type AppScreenshotterFactory } from "./ChromeScreenshotter";
import { PngImages } from "./PngImages";
import { PreviewUnavailableError, type PreviewAccess, type PreviewLease } from "./PreviewAccess";
import type { QaSettings } from "./QaConfig";
import { QaError, type QaEnv, type QaShot, type QaSkippedScreen, VisualQa } from "./VisualQa";

/** Daemon services the visual QA uses (installed by the daemon, faked in tests). */
export interface VisualQaServices {
    /** the projects' dev servers */
    previews: PreviewAccess;
    /** headless browsers */
    browsers: AppScreenshotterFactory;
    /** project workspaces (the chat tool finds its project there) */
    workspaces: Pick<WorkspaceManager, "get">;
    /** folder of the project folders */
    projectsDir: string;
    /** the daemon's Penpot tools, routed to one session */
    tools: { forSession(sessionId: () => string | undefined): WorkflowToolsApi } | null;
}

/**
 * Holder of the daemon's {@link VisualQaServices}, so that the `visual-qa` workflow and the
 * `penforge_visual_qa` MCP tool (which runs inside the MCP server) reach the same dev servers.
 */
export class VisualQaHost {
    private static current: VisualQaServices | null = null;

    public static install(services: VisualQaServices): void {
        VisualQaHost.current = services;
    }

    /** Removes the services (only when they are still the installed ones). */
    public static uninstall(services: VisualQaServices): void {
        if (VisualQaHost.current === services) {
            VisualQaHost.current = null;
        }
    }

    public static get(): VisualQaServices | null {
        return VisualQaHost.current;
    }
}

/** Screen entry of a QA report (`result` event, `report.json`, chat tool). */
export interface QaScreenReport {
    boardId: string;
    name: string;
    route: string;
    width: number;
    height: number;
    score: number;
    passed: boolean;
    ssim: number;
    /** differing pixels in percent, one decimal */
    pixelDiff: number;
    /** score before the fixes of this run */
    before?: number;
    /** Claude turns used on the screen */
    attempts?: number;
    /** previews as `data:` URLs */
    images?: { design: string; app: string; diff: string };
    /** saved PNGs, relative to the project folder (developer persona) */
    paths?: { design: string; app: string; diff: string };
    /** files changed by the fixes, relative to `app-src/` (developer persona) */
    changedFiles?: string[];
}

/**
 * One QA session: holds the project's build lock, the running app and a headless browser, and
 * releases all three on {@link close}.
 */
export class QaRun {
    /** width of the previews sent to the client */
    public static readonly THUMBNAIL_WIDTH = 360;

    private constructor(
        public readonly qa: VisualQa,
        private readonly lease: PreviewLease,
        private readonly browser: AppScreenshotter,
        private readonly unlock: () => void
    ) {}

    /**
     * Starts a session.
     *
     * @throws QaError `busy`, `not-built`, `no-preview`, `no-browser`
     */
    public static async start(
        env: QaEnv,
        services: Pick<VisualQaServices, "previews" | "browsers">,
        settings: QaSettings,
        runName = VisualQa.newRunName()
    ): Promise<QaRun> {
        const unlock = BuildLock.tryAcquire(env.workspace.root);
        if (!unlock) {
            throw new QaError("A build or another check is running; try again when it is done.", "busy");
        }
        let lease: PreviewLease | undefined;
        try {
            env.progress("preview", {}, "Starting the app");
            lease = await services.previews.acquire(env.workspace.projectId, env.signal);
            VisualQa.checkAborted(env.signal);
            env.progress("browser", {}, "Opening a browser");
            const browser = await services.browsers.open();
            return new QaRun(new VisualQa(env, settings, browser, lease.url, runName), lease, browser, unlock);
        } catch (error) {
            lease?.release();
            unlock();
            if (error instanceof PreviewUnavailableError) {
                throw new QaError(error.message, error.code);
            }
            if (error instanceof BrowserUnavailableError) {
                throw new QaError(error.message, "no-browser");
            }
            throw error;
        }
    }

    /** Ends the session (idempotent). */
    public async close(): Promise<void> {
        try {
            await this.browser.close();
        } finally {
            this.lease.release();
            this.unlock();
        }
    }

    /**
     * Builds the report entry of a screen.
     *
     * @param shot - the final comparison
     * @param options - previews, developer details, the score before fixes
     */
    public async screenReport(
        shot: QaShot,
        options: { images: boolean; developer: boolean; before?: QaShot; attempts?: number; changedFiles?: string[] }
    ): Promise<QaScreenReport> {
        const { screen } = shot;
        const report: QaScreenReport = {
            boardId: screen.boardId,
            name: screen.name,
            route: screen.route,
            width: screen.width,
            height: screen.height,
            score: shot.score,
            passed: shot.passed,
            ssim: Math.round(shot.ssim * 1000) / 1000,
            pixelDiff: Math.round(shot.diffRatio * 1000) / 10,
        };
        if (options.before && options.before !== shot) {
            report.before = options.before.score;
        }
        if (options.attempts !== undefined) {
            report.attempts = options.attempts;
        }
        if (options.images) {
            const [design, app, diff] = await Promise.all([
                PngImages.thumbnail(shot.design, QaRun.THUMBNAIL_WIDTH),
                PngImages.thumbnail(shot.app, QaRun.THUMBNAIL_WIDTH),
                PngImages.thumbnail(shot.diff, QaRun.THUMBNAIL_WIDTH),
            ]);
            report.images = { design, app, diff };
        }
        if (options.developer) {
            report.paths = {
                design: this.qa.projectPath(shot.paths.design),
                app: this.qa.projectPath(shot.paths.app),
                diff: this.qa.projectPath(shot.paths.diff),
            };
            if (options.changedFiles && options.changedFiles.length > 0) {
                report.changedFiles = options.changedFiles;
            }
        }
        return report;
    }

    /** Average score of the screens, rounded (100 when there is none). */
    public static averageScore(shots: { score: number }[]): number {
        if (shots.length === 0) {
            return 100;
        }
        return Math.round(shots.reduce((sum, shot) => sum + shot.score, 0) / shots.length);
    }

    /** Report without the previews (written to `report.json`). */
    public static fileReport<T extends { screens: QaScreenReport[] }>(report: T): T {
        return { ...report, screens: report.screens.map(({ images: _images, ...rest }) => rest) };
    }

    /** Skipped screens as reported. */
    public static skippedReport(skipped: QaSkippedScreen[]): QaSkippedScreen[] {
        return skipped.map(({ boardId, name, route, reason }) => ({ boardId, name, route, reason }));
    }
}
