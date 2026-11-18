import sharp from "sharp";
import type { DiffScore } from "./types";

/** Decoded RGBA image. */
export interface RgbaImage {
    width: number;
    height: number;
    /** RGBA bytes, row by row */
    data: Uint8Array;
}

/**
 * Pixel comparison of before/after screenshots of the tidy-up.
 *
 * A pixel counts as different when no pixel within {@link PixelDiff.RADIUS} of the same place in
 * the other image is within {@link PixelDiff.CHANNEL_TOLERANCE} on every channel (checked both
 * ways), so anti-aliasing and sub-pixel moves of a layout do not count.
 */
export class PixelDiff {
    public static readonly CHANNEL_TOLERANCE = 40;
    public static readonly RADIUS = 1;
    /** largest size difference (px per side) still compared; bigger counts as all different */
    public static readonly SIZE_TOLERANCE = 2;

    /** Decodes a base64 PNG/JPEG/WebP into RGBA (transparent pixels over white). */
    public static async decode(base64: string): Promise<RgbaImage> {
        const { data, info } = await sharp(Buffer.from(base64, "base64"))
            .flatten({ background: "#ffffff" })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return {
            width: info.width,
            height: info.height,
            data: new Uint8Array(data.buffer, data.byteOffset, data.length),
        };
    }

    /** Compares two base64 images. */
    public static async compareBase64(before: string, after: string): Promise<DiffScore> {
        const [a, b] = await Promise.all([PixelDiff.decode(before), PixelDiff.decode(after)]);
        return PixelDiff.compare(a, b);
    }

    /**
     * Share of differing pixels. Images whose sizes differ by more than
     * {@link PixelDiff.SIZE_TOLERANCE} score 1; smaller differences compare the common area and
     * count the rest as different.
     */
    public static compare(a: RgbaImage, b: RgbaImage): DiffScore {
        const sameSize = a.width === b.width && a.height === b.height;
        const width = Math.max(a.width, b.width);
        const height = Math.max(a.height, b.height);
        if (
            Math.abs(a.width - b.width) > PixelDiff.SIZE_TOLERANCE ||
            Math.abs(a.height - b.height) > PixelDiff.SIZE_TOLERANCE ||
            width === 0 ||
            height === 0
        ) {
            return { ratio: 1, width, height, sameSize };
        }
        const w = Math.min(a.width, b.width);
        const h = Math.min(a.height, b.height);
        let different = width * height - w * h;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (!PixelDiff.near(a, b, x, y) || !PixelDiff.near(b, a, x, y)) {
                    different++;
                }
            }
        }
        return { ratio: different / (width * height), width, height, sameSize };
    }

    /** True when pixel (x, y) of `a` has a close match around (x, y) in `b`. */
    private static near(a: RgbaImage, b: RgbaImage, x: number, y: number): boolean {
        const ia = (y * a.width + x) * 4;
        const r = PixelDiff.RADIUS;
        for (let dy = -r; dy <= r; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= b.height) {
                continue;
            }
            for (let dx = -r; dx <= r; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= b.width) {
                    continue;
                }
                const ib = (yy * b.width + xx) * 4;
                if (
                    Math.abs(a.data[ia] - b.data[ib]) <= PixelDiff.CHANNEL_TOLERANCE &&
                    Math.abs(a.data[ia + 1] - b.data[ib + 1]) <= PixelDiff.CHANNEL_TOLERANCE &&
                    Math.abs(a.data[ia + 2] - b.data[ib + 2]) <= PixelDiff.CHANNEL_TOLERANCE &&
                    Math.abs(a.data[ia + 3] - b.data[ib + 3]) <= PixelDiff.CHANNEL_TOLERANCE
                ) {
                    return true;
                }
            }
        }
        return false;
    }
}
