import type { Shape } from "@penpot/plugin-types";
import type { NodeLocator } from "./locate.ts";
import type { JsonObject } from "./serialize.ts";

/**
 * Raster formats supported by {@link ScreenshotCapturer}.
 */
export type ScreenshotFormat = "png" | "jpeg" | "webp";

/**
 * Exports a node (or the selection, or the whole page) to a raster image.
 *
 * The image bytes are returned inside a base64 envelope (`{__type: "base64", data}`) that the
 * server decodes, so the result can carry metadata next to the image without the ~10x expansion
 * of serializing a `Uint8Array` as JSON.
 */
export class ScreenshotCapturer {
    /**
     * Fallback wait (ms) for pending changes when the API has no `waitForLayoutUpdate`.
     */
    private static readonly FALLBACK_WAIT_MS = 200;

    /** Longest side of the image of a page. */
    private static readonly MAX_PAGE_PX = 4096;

    /** Most top-level shapes put into the image of a page. */
    private static readonly MAX_PAGE_SHAPES = 60;

    private readonly penpot: any;
    private readonly locator: NodeLocator;

    /**
     * @param penpotApi - the Penpot plugin API object
     * @param locator - the node locator of the same file
     */
    constructor(penpotApi: any, locator: NodeLocator) {
        this.penpot = penpotApi;
        this.locator = locator;
    }

    /**
     * Captures an image.
     *
     * @param target - a node id, `"selection"` (first selected node) or `"page"` (whole current page)
     * @param scale - export scale
     * @param format - raster format; the parts of a page are always PNG
     */
    public async capture(target: string, scale: number, format: ScreenshotFormat): Promise<JsonObject> {
        if (target === "page") {
            return this.capturePage(scale);
        }
        const shape = await this.resolve(target);
        await this.waitForRender(shape);
        const bytes: Uint8Array = await shape.export({ type: format, scale });
        return {
            node: { id: shape.id, name: shape.name, type: shape.type },
            target,
            format,
            scale,
            image: ScreenshotCapturer.base64Envelope(bytes),
        };
    }

    /**
     * Captures every top-level shape of the open page for the server to put together: the root itself
     * has no size, so its export is empty.
     *
     * @param scale - export scale; lowered when the page would become a huge image
     */
    private async capturePage(scale: number): Promise<JsonObject> {
        const root = this.penpot.root;
        if (!root) {
            throw new Error("No page is open");
        }
        const shapes: any[] = [...(root.children ?? [])].filter((shape) => !shape.hidden);
        if (shapes.length === 0) {
            throw new Error("The page is empty: there is nothing to capture");
        }
        if (shapes.length > ScreenshotCapturer.MAX_PAGE_SHAPES) {
            throw new Error(
                `The page has ${shapes.length} top-level shapes, too many for one image; capture its boards by id`
            );
        }
        await this.waitForRender(root);
        const boxes = shapes.map((shape) => shape.bounds);
        const x = Math.min(...boxes.map((box) => box.x));
        const y = Math.min(...boxes.map((box) => box.y));
        const width = Math.max(...boxes.map((box) => box.x + box.width)) - x;
        const height = Math.max(...boxes.map((box) => box.y + box.height)) - y;
        const pageScale = Math.min(scale, ScreenshotCapturer.MAX_PAGE_PX / Math.max(width, height, 1));
        const parts = [];
        for (const [index, shape] of shapes.entries()) {
            const bytes: Uint8Array = await shape.export({ type: "png", scale: pageScale });
            const box = boxes[index];
            parts.push({
                x: (box.x - x) * pageScale,
                y: (box.y - y) * pageScale,
                width: box.width * pageScale,
                height: box.height * pageScale,
                image: ScreenshotCapturer.base64Envelope(bytes),
            });
        }
        return {
            node: { id: root.id, name: this.penpot.currentPage?.name ?? root.name, type: "page" },
            target: "page",
            scale: pageScale,
            width: Math.max(1, Math.round(width * pageScale)),
            height: Math.max(1, Math.round(height * pageScale)),
            // a later child lies above an earlier one
            parts,
        };
    }

    private async resolve(target: string): Promise<Shape> {
        if (target === "selection") {
            const selection: Shape[] = this.penpot.selection ?? [];
            if (selection.length === 0) {
                throw new Error("Nothing is selected");
            }
            return selection[0];
        }
        // exports render through the active page, so open the node's page first
        return (await this.locator.requireOnActivePage(target)).shape;
    }

    /**
     * Waits until pending changes are applied, so the export shows the current state.
     */
    private async waitForRender(shape: Shape): Promise<void> {
        const s = shape as any;
        if (typeof s.waitForLayoutUpdate === "function") {
            await s.waitForLayoutUpdate();
        } else if (typeof this.penpot.waitForLayoutUpdate === "function") {
            await this.penpot.waitForLayoutUpdate();
        } else {
            await new Promise((resolve) => setTimeout(resolve, ScreenshotCapturer.FALLBACK_WAIT_MS));
        }
    }

    /**
     * Wraps bytes in the base64 envelope understood by the server.
     *
     * @param bytes - the raw bytes
     */
    public static base64Envelope(bytes: Uint8Array): { __type: "base64"; data: string } {
        // build the binary string in chunks; spreading a large array would overflow the stack
        const chunkSize = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
        }
        return { __type: "base64", data: btoa(binary) };
    }
}
