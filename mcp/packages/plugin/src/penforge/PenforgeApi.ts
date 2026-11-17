import { NodeLocator } from "./locate.ts";
import { LocalTokenResolver, NodeMutator } from "./mutate.ts";
import { NodeSerializer } from "./serialize.ts";
import type { JsonObject } from "./serialize.ts";
import { CommentService } from "./comments.ts";
import { PrototypeReader } from "./prototype.ts";
import { ScreenshotCapturer } from "./screenshot.ts";
import type { ScreenshotFormat } from "./screenshot.ts";

/**
 * Plugin-side entry points of the Penforge typed MCP tools.
 *
 * Exposed to `execute_code` as `penpotUtils.penforge`. Each server tool calls exactly one method
 * with a single JSON parameter object and returns its result unchanged. All methods read the
 * global `penpot` API at call time.
 */
export class PenforgeApi {
    private static api(): any {
        return penpot;
    }

    private static locator(): NodeLocator {
        return new NodeLocator(PenforgeApi.api());
    }

    /**
     * Returns the property snapshot of a node.
     *
     * @param params - `nodeId` and optional `depth` (levels serialized in full, default 1)
     */
    public static getNodeProperties(params: { nodeId: string; depth?: number }): JsonObject {
        const located = PenforgeApi.locator().require(params.nodeId);
        return {
            pageId: located.page.id,
            ...NodeSerializer.serializeNode(located.shape, params.depth ?? 1),
        };
    }

    /**
     * Captures a raster image of a node, the selection or the page.
     *
     * @param params - `target` (node id, "selection" or "page"), `scale`, `format`
     */
    public static captureNodeScreenshot(params: {
        target: string;
        scale?: number;
        format?: ScreenshotFormat;
    }): Promise<JsonObject> {
        const capturer = new ScreenshotCapturer(PenforgeApi.api(), PenforgeApi.locator());
        return capturer.capture(params.target, params.scale ?? 2, params.format ?? "png");
    }

    /**
     * Applies whitelisted mutations to a node in one undo step and returns the new snapshot.
     *
     * @param params - `nodeId` and `mutations`
     */
    public static async updateDesignNode(params: {
        nodeId: string;
        mutations: Record<string, unknown>;
    }): Promise<JsonObject> {
        // reject bad input before touching the page or the undo stack
        NodeMutator.validate(params.mutations);
        const p = PenforgeApi.api();
        const located = await PenforgeApi.locator().requireOnActivePage(params.nodeId);
        const mutator = new NodeMutator(new LocalTokenResolver(p));
        const history = p.history;
        const blockId = history && typeof history.undoBlockBegin === "function" ? history.undoBlockBegin() : undefined;
        let applied: string[];
        try {
            applied = mutator.apply(located.shape, params.mutations as Record<string, any>);
        } finally {
            if (blockId !== undefined) {
                history.undoBlockFinish(blockId);
            }
        }
        const shape: any = located.shape;
        if (typeof shape.waitForLayoutUpdate === "function") {
            await shape.waitForLayoutUpdate();
        }
        const fresh = located.page.getShapeById(params.nodeId) ?? located.shape;
        return {
            applied,
            undoGrouped: blockId !== undefined,
            node: { pageId: located.page.id, ...NodeSerializer.serializeNode(fresh, 1) },
        };
    }

    /**
     * Lists canvas comment threads.
     *
     * @param params - optional `pageId`, `status` ("unresolved" or "all")
     */
    public static listCanvasComments(params: {
        pageId?: string;
        status?: "unresolved" | "all";
    }): Promise<JsonObject[]> {
        const service = new CommentService(PenforgeApi.api(), PenforgeApi.locator());
        return service.list(params.pageId, params.status ?? "unresolved");
    }

    /**
     * Resolves a comment thread, optionally replying with a note first.
     *
     * @param params - `threadId` and optional `resolutionNote`
     */
    public static resolveCanvasComment(params: { threadId: string; resolutionNote?: string }): Promise<JsonObject> {
        const service = new CommentService(PenforgeApi.api(), PenforgeApi.locator());
        return service.resolve(params.threadId, params.resolutionNote);
    }

    /**
     * Lists the top-level boards of one page or of all pages.
     *
     * @param params - optional `pageId`
     */
    public static listBoards(params: { pageId?: string }): JsonObject[] {
        const locator = PenforgeApi.locator();
        const pages = params.pageId ? [locator.page(params.pageId)] : locator.pages();
        return new PrototypeReader().listBoards(pages);
    }

    /**
     * Returns pages, flows, boards and board-to-board navigation edges of the file.
     */
    public static getPrototypeGraph(): JsonObject {
        return new PrototypeReader().graph(PenforgeApi.locator().pages());
    }

    /**
     * Generates HTML markup and CSS for a node.
     *
     * @param params - `nodeId`
     */
    public static async generateCodeHints(params: { nodeId: string }): Promise<JsonObject> {
        const p = PenforgeApi.api();
        // code generation reads the active page
        const located = await PenforgeApi.locator().requireOnActivePage(params.nodeId);
        const shapes = [located.shape];
        const html = p.generateMarkup(shapes, { type: "html" });
        const css = p.generateStyle(shapes, { type: "css", withPrelude: true, includeChildren: true });
        let fontFaces: string | null = null;
        if (typeof p.generateFontFaces === "function") {
            fontFaces = await p.generateFontFaces(shapes);
        }
        return {
            nodeId: located.shape.id,
            name: located.shape.name,
            type: located.shape.type,
            pageId: located.page.id,
            html,
            css,
            fontFaces,
        };
    }
}
