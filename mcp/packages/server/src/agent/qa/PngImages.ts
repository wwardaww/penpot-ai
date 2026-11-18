import sharp from "sharp";
import type { RgbaImage } from "./PixelCompare";

/**
 * PNG helpers of the visual QA, built on sharp (already a dependency of the MCP server).
 */
export class PngImages {
    /** white background used wherever an image has no pixels */
    private static readonly WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

    /**
     * Decodes an image into RGBA pixels, flattened on white.
     *
     * @param bytes - PNG (or any format sharp reads)
     */
    public static async decode(bytes: Buffer | Uint8Array): Promise<RgbaImage> {
        const { data, info } = await sharp(bytes)
            .flatten({ background: PngImages.WHITE })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return { width: info.width, height: info.height, data: new Uint8Array(data) };
    }

    /**
     * Brings an image to an exact size without scaling: extra pixels at the right and bottom are cut
     * off, missing ones are filled with white (a page shorter than its board).
     */
    public static fit(image: RgbaImage, width: number, height: number): RgbaImage {
        if (image.width === width && image.height === height) {
            return image;
        }
        const data = new Uint8Array(width * height * 4).fill(255);
        const rows = Math.min(height, image.height);
        const bytes = Math.min(width, image.width) * 4;
        for (let y = 0; y < rows; y++) {
            const from = y * image.width * 4;
            data.set(image.data.subarray(from, from + bytes), y * width * 4);
        }
        return { width, height, data };
    }

    /**
     * Encodes RGBA pixels as PNG.
     */
    public static encode(image: RgbaImage): Promise<Buffer> {
        return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
            raw: { width: image.width, height: image.height, channels: 4 },
        })
            .png()
            .toBuffer();
    }

    /**
     * Makes a small PNG preview as a `data:` URL (for the report UI).
     *
     * @param png - the full image
     * @param maxWidth - largest width of the preview
     */
    public static async thumbnail(png: Buffer, maxWidth: number): Promise<string> {
        const small = await sharp(png)
            .resize({ width: maxWidth, withoutEnlargement: true })
            .png({ compressionLevel: 9, palette: true })
            .toBuffer();
        return `data:image/png;base64,${small.toString("base64")}`;
    }
}
