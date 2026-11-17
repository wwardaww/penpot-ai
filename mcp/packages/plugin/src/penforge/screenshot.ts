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
     * @param format - raster format
     */
    public async capture(target: string, scale: number, format: ScreenshotFormat): Promise<JsonObject> {
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

    private async resolve(target: string): Promise<Shape> {
        if (target === "selection") {
            const selection: Shape[] = this.penpot.selection ?? [];
            if (selection.length === 0) {
                throw new Error("Nothing is selected");
            }
            return selection[0];
        }
        if (target === "page") {
            const root = this.penpot.root;
            if (!root) {
                throw new Error("No page is open");
            }
            return root;
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
