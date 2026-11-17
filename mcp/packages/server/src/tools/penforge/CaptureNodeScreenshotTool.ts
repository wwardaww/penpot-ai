import { z } from "zod";
import sharp from "sharp";
import { Tool } from "../../Tool";
import { ImageContent, TextContent, ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { FileUtils } from "../../utils/FileUtils";
import { PenforgePluginTool } from "./PenforgePluginTool";

/**
 * Raster formats of {@link CaptureNodeScreenshotTool}.
 */
type ScreenshotFormat = "png" | "jpeg" | "webp";

/**
 * Arguments of {@link CaptureNodeScreenshotTool}.
 */
export class CaptureNodeScreenshotArgs {
    static schema = {
        nodeId: z
            .string()
            .min(1, "nodeId cannot be empty")
            .max(128)
            .describe(
                "Id of the node to capture, or 'selection' (first selected node) or 'page' (whole current page)."
            ),
        scale: z.number().min(0.25).max(4).default(2).describe("Export scale (default 2)."),
        format: z.enum(["png", "jpeg", "webp"]).default("png").describe("Image format (default png)."),
        padding: z
            .number()
            .int()
            .min(0)
            .max(512)
            .optional()
            .describe("Empty margin in output pixels added around the image (transparent; white for jpeg)."),
        savePath: z.string().min(1).optional().describe("Optional absolute file path; the image is also saved there."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    nodeId!: string;

    scale: number = 2;

    format: ScreenshotFormat = "png";

    padding?: number;

    savePath?: string;

    sessionId?: string;
}

/**
 * Result of the plugin-side capture.
 */
interface PluginCapture {
    node: { id: string; name: string; type: string };
    image: object;
}

/**
 * Captures a raster image of a node, the selection or the whole page.
 */
export class CaptureNodeScreenshotTool extends PenforgePluginTool<CaptureNodeScreenshotArgs> {
    private static readonly MIME_TYPES: Record<ScreenshotFormat, string> = {
        png: "image/png",
        jpeg: "image/jpeg",
        webp: "image/webp",
    };

    constructor(mcpServer: PenpotMcpServer) {
        let schema: any = CaptureNodeScreenshotArgs.schema;
        if (!mcpServer.isFileSystemAccessEnabled()) {
            schema = { ...schema };
            delete schema.savePath;
        }
        super(mcpServer, schema);
    }

    public getToolName(): string {
        return "capture_node_screenshot";
    }

    public getToolDescription(): string {
        let description =
            "Renders a node (or 'selection' / 'page') to an image you can see, after pending changes are " +
            "applied. Returns the image plus a JSON line `{node, format, scale, width, height, savedPath}`.";
        if (this.mcpServer.isFileSystemAccessEnabled()) {
            description += " Pass `savePath` to also write the image to disk.";
        }
        return description;
    }

    protected async executeCore(args: CaptureNodeScreenshotArgs): Promise<ToolResponse> {
        const format: ScreenshotFormat = args.format ?? "png";
        const scale = args.scale ?? 2;
        if (args.savePath) {
            if (!this.mcpServer.isFileSystemAccessEnabled()) {
                throw new Error("File system access is not enabled on the MCP server!");
            }
            FileUtils.checkPathIsAbsolute(args.savePath);
        }
        const capture = await this.callPlugin<PluginCapture>(
            "captureNodeScreenshot",
            { target: args.nodeId, scale, format },
            args.sessionId
        );
        const image = await CaptureNodeScreenshotTool.finish(
            ImageContent.byteData(capture.image),
            format,
            args.padding ?? 0
        );
        if (args.savePath) {
            FileUtils.writeBinaryFile(args.savePath, image.bytes);
        }
        const meta = {
            node: capture.node,
            format,
            scale,
            width: image.width,
            height: image.height,
            savedPath: args.savePath ?? null,
        };
        return new ToolResponse([
            new ImageContent(Buffer.from(image.bytes).toString("base64"), CaptureNodeScreenshotTool.MIME_TYPES[format]),
            new TextContent(JSON.stringify(meta)),
        ]);
    }

    /**
     * Adds padding and makes sure the bytes are in the requested format.
     *
     * @param bytes - the exported image
     * @param format - the requested format
     * @param padding - margin in pixels
     */
    public static async finish(
        bytes: Uint8Array,
        format: ScreenshotFormat,
        padding: number
    ): Promise<{ bytes: Uint8Array; width: number | null; height: number | null }> {
        const metadata = await sharp(bytes).metadata();
        if (padding === 0 && metadata.format === format) {
            return { bytes, width: metadata.width ?? null, height: metadata.height ?? null };
        }
        let image = sharp(bytes);
        if (padding > 0) {
            const background =
                format === "jpeg" ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 };
            image = image.extend({ top: padding, bottom: padding, left: padding, right: padding, background });
        }
        const { data, info } = await image.toFormat(format).toBuffer({ resolveWithObject: true });
        return { bytes: new Uint8Array(data), width: info.width, height: info.height };
    }
}
