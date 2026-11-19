import { readdir, readFile, stat, writeFile } from "fs/promises";
import { join, relative } from "path";
import sharp from "sharp";
import type { WorkflowContext } from "@penpot/mcp-common";
import { createLogger } from "../../logger";

/** Thumbnail source found for an app. */
export interface ThumbnailSource {
    /** absolute file */
    file: string;
    /** file relative to the project folder, forward slashes */
    relativePath: string;
    mtimeMs: number;
}

/**
 * Thumbnail of a built app on the dashboard.
 *
 * Two sources: `.penforge/thumbnail.png`, a screenshot of the start board saved after each build
 * ({@link saveAfterBuild}), and the newest visual QA app screenshot (W18,
 * `.penforge/qa/<run>/<screen>-app.png`). The newer one wins. The client gets a small PNG as a
 * `data:` URL; results are cached per file and modification time.
 */
export class AppThumbnail {
    /** Name of the build-time screenshot below `.penforge/`. */
    public static readonly FILE = "thumbnail.png";
    /** Width of the saved screenshot (twice the card width, for sharp screens). */
    public static readonly SAVED_WIDTH = 960;
    /** Width of the image sent to the client. */
    public static readonly CARD_WIDTH = 480;

    private static readonly QA_RUN = /^\d{8}T\d{6}-[0-9a-f]{4}$/;
    private static readonly QA_APP_SHOT = /-app\.png$/;
    /** larger files are not read */
    private static readonly MAX_SOURCE_BYTES = 20 * 1024 * 1024;

    private readonly logger = createLogger("AppThumbnail");
    private readonly cache = new Map<string, { mtimeMs: number; dataUrl: string }>();

    /**
     * Finds the thumbnail source of a project.
     *
     * @param projectRoot - the project folder
     * @returns the newest source, or null when there is none
     */
    public static async locate(projectRoot: string): Promise<ThumbnailSource | null> {
        const metaDir = join(projectRoot, ".penforge");
        const candidates = [join(metaDir, AppThumbnail.FILE)];
        const qaShot = await AppThumbnail.newestQaShot(join(metaDir, "qa"));
        if (qaShot) {
            candidates.push(qaShot);
        }
        let best: ThumbnailSource | null = null;
        for (const file of candidates) {
            const info = await stat(file).catch(() => null);
            if (!info?.isFile() || info.size > AppThumbnail.MAX_SOURCE_BYTES) {
                continue;
            }
            if (!best || info.mtimeMs > best.mtimeMs) {
                best = {
                    file,
                    relativePath: relative(projectRoot, file).split("\\").join("/"),
                    mtimeMs: info.mtimeMs,
                };
            }
        }
        return best;
    }

    /**
     * Gets the card image of a source.
     *
     * @param source - the source
     * @returns a PNG `data:` URL, or null when the file is no readable image
     */
    public async dataUrl(source: ThumbnailSource): Promise<string | null> {
        const cached = this.cache.get(source.file);
        if (cached && cached.mtimeMs === source.mtimeMs) {
            return cached.dataUrl;
        }
        try {
            const small = await sharp(await readFile(source.file))
                .resize({ width: AppThumbnail.CARD_WIDTH, withoutEnlargement: true })
                .png({ compressionLevel: 9, palette: true })
                .toBuffer();
            const dataUrl = `data:image/png;base64,${small.toString("base64")}`;
            this.cache.set(source.file, { mtimeMs: source.mtimeMs, dataUrl });
            return dataUrl;
        } catch (error) {
            this.logger.warn(
                "Unreadable thumbnail %s: %s",
                source.file,
                error instanceof Error ? error.message : error
            );
            return null;
        }
    }

    /**
     * Saves a screenshot of the app's start board as `.penforge/thumbnail.png` after a build.
     *
     * The start board is the starting board of the first prototype flow that is a built screen,
     * else the screen on route `/`, else the first built screen. Never throws: a thumbnail is
     * not worth failing a build.
     *
     * @param ctx - the build run's context
     * @returns whether a thumbnail was saved
     */
    public static async saveAfterBuild(ctx: WorkflowContext): Promise<boolean> {
        const logger = createLogger("AppThumbnail");
        try {
            const boardId = await AppThumbnail.startBoard(ctx);
            if (boardId === null) {
                return false;
            }
            const result = await ctx.tools.call("capture_node_screenshot", {
                nodeId: boardId,
                scale: 1,
                format: "png",
            });
            const image = result.isError
                ? undefined
                : (result.content.find(
                      (part) =>
                          typeof part === "object" &&
                          part !== null &&
                          (part as { type?: unknown }).type === "image" &&
                          typeof (part as { data?: unknown }).data === "string"
                  ) as { data: string } | undefined);
            if (!image) {
                logger.info("No start board screenshot for the thumbnail: %s", result.text.slice(0, 200));
                return false;
            }
            const png = await sharp(Buffer.from(image.data, "base64"))
                .resize({ width: AppThumbnail.SAVED_WIDTH, withoutEnlargement: true })
                .png()
                .toBuffer();
            const file = ctx.workspace.resolve(join(ctx.workspace.metaDir, AppThumbnail.FILE));
            await writeFile(file, png);
            return true;
        } catch (error) {
            logger.warn("Could not save the app thumbnail: %s", error instanceof Error ? error.message : error);
            return false;
        }
    }

    private static async startBoard(ctx: WorkflowContext): Promise<string | null> {
        const map = await ctx.workspace.readJson<{ boards?: Record<string, { route?: string | null }> } | null>(
            "map.json",
            null
        );
        const screens = Object.entries(map?.boards ?? {})
            .filter(([, board]) => typeof board?.route === "string")
            .map(([id, board]) => ({ id, route: board.route as string }));
        if (screens.length === 0) {
            return null;
        }
        const graph = await ctx.tools.call("get_prototype_graph", {}).catch(() => null);
        if (graph && !graph.isError) {
            try {
                const flows = (JSON.parse(graph.text) as { flows?: { startingBoardId?: unknown }[] }).flows ?? [];
                for (const flow of flows) {
                    const start = screens.find((screen) => screen.id === flow.startingBoardId);
                    if (start) {
                        return start.id;
                    }
                }
            } catch {
                // not JSON: fall back to the routes
            }
        }
        return (screens.find((screen) => screen.route === "/") ?? screens[0]).id;
    }

    private static async newestQaShot(qaDir: string): Promise<string | null> {
        const runs = await readdir(qaDir, { withFileTypes: true }).catch(() => []);
        const names = runs
            .filter((entry) => entry.isDirectory() && AppThumbnail.QA_RUN.test(entry.name))
            .map((entry) => entry.name)
            .sort()
            .reverse();
        for (const run of names) {
            const files = (await readdir(join(qaDir, run)).catch(() => [] as string[]))
                .filter((name) => AppThumbnail.QA_APP_SHOT.test(name))
                .sort();
            if (files.length > 0) {
                return join(qaDir, run, files[0]);
            }
        }
        return null;
    }
}
