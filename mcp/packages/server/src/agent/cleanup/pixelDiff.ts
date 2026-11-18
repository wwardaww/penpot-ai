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
 * ways), so anti-aliasing and sub-pixel moves of a layout do not count. Screenshots are taken at
 * 1 screenshot px per design px, so the radius is one design pixel.
 *
 * Besides the share of differing pixels over the whole image, the share in the worst
 * {@link PixelDiff.TILE} x {@link PixelDiff.TILE} tile is reported: a layer that moved a few
 * pixels on a tall board changes little of the whole image but much of its tiles.
 */
export class PixelDiff {
    public static readonly CHANNEL_TOLERANCE = 24;
    public static readonly RADIUS = 1;
    /** largest size difference (px per side) still compared; bigger counts as all different */
    public static readonly SIZE_TOLERANCE = 1;
    public static readonly TILE = 32;
    /** most differing pixels one tile may have for a step to pass */
    public static readonly TILE_LIMIT = 0.03;

    /** True when a step whose screenshots scored `score` keeps the look. */
    public static passes(score: DiffScore, threshold: number): boolean {
        return score.ratio <= threshold && score.maxTile <= PixelDiff.TILE_LIMIT;
    }

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
            return { ratio: 1, maxTile: 1, width, height, sameSize };
        }
        const w = Math.min(a.width, b.width);
        const h = Math.min(a.height, b.height);
        const t = PixelDiff.TILE;
        const columns = Math.ceil(width / t);
        const tiles = new Uint32Array(columns * Math.ceil(height / t));
        let different = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (x >= w || y >= h) {
                    // the strip one image has more: counted in the share, not in the tiles
                    different++;
                } else if (!PixelDiff.near(a, b, x, y) || !PixelDiff.near(b, a, x, y)) {
                    different++;
                    tiles[Math.floor(y / t) * columns + Math.floor(x / t)]++;
                }
            }
        }
        let maxTile = 0;
        for (let i = 0; i < tiles.length; i++) {
            const tx = i % columns;
            const ty = Math.floor(i / columns);
            const area = (Math.min(width, (tx + 1) * t) - tx * t) * (Math.min(height, (ty + 1) * t) - ty * t);
            // edge slivers are too small to judge
            if (area >= (t * t) / 4) {
                maxTile = Math.max(maxTile, tiles[i] / area);
            }
        }
        return { ratio: different / (width * height), maxTile, width, height, sameSize };
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
