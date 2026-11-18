/**
 * RGBA image held in memory: `width * height * 4` bytes, row by row.
 */
export interface RgbaImage {
    width: number;
    height: number;
    data: Uint8Array;
}

/** Rectangle in image pixels. */
export interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Outcome of {@link PixelCompare.compare}. */
export interface PixelComparison {
    /** share of pixels that differ visibly, 0..1 */
    diffRatio: number;
    /** mean structural similarity of the two images' luminance, 0..1 */
    ssim: number;
    /** combined score 0..100: the mean of `ssim` and `1 - diffRatio`, rounded */
    score: number;
    /** differing pixels in red over a faded copy of the design */
    heatmap: RgbaImage;
    /** largest areas with differences, biggest first (at most {@link PixelCompare.MAX_REGIONS}) */
    regions: Region[];
}

/**
 * Pure pixel comparison of a design image with a screenshot of the running app (same size).
 *
 * - Pixel difference: the YIQ colour distance used by pixelmatch (Kotsarenko & Ramos 2009); a
 *   pixel differs when its distance exceeds `threshold` × the largest possible distance.
 * - SSIM: Wang et al. 2004 on luminance, over 8×8 windows (step 4), averaged.
 * - Regions: the image is cut into 16 px cells; cells with differing pixels are merged into
 *   rectangles, so a prompt can point at "the area at 0,120 1440×80".
 */
export class PixelCompare {
    /** largest possible YIQ distance (pixelmatch) */
    private static readonly MAX_DELTA = 35215;
    private static readonly WINDOW = 8;
    private static readonly STEP = 4;
    private static readonly CELL = 16;
    public static readonly MAX_REGIONS = 8;

    /**
     * Compares two images of the same size.
     *
     * @param design - the design board
     * @param app - the app screenshot
     * @param threshold - colour tolerance 0..1 (pixelmatch default 0.1)
     */
    public static compare(design: RgbaImage, app: RgbaImage, threshold = 0.1): PixelComparison {
        if (design.width !== app.width || design.height !== app.height) {
            throw new Error(`Images differ in size: ${design.width}×${design.height} and ${app.width}×${app.height}`);
        }
        const { width, height } = design;
        const total = width * height;
        const limit = PixelCompare.MAX_DELTA * threshold * threshold;
        const heatmap = new Uint8Array(total * 4);
        const differs = new Uint8Array(total);
        let different = 0;
        for (let i = 0; i < total; i++) {
            const o = i * 4;
            const delta = PixelCompare.colorDelta(design.data, app.data, o);
            if (delta > limit) {
                differs[i] = 1;
                different++;
                const strength = Math.min(1, delta / PixelCompare.MAX_DELTA + 0.5);
                heatmap[o] = 255;
                heatmap[o + 1] = Math.round(64 * (1 - strength));
                heatmap[o + 2] = Math.round(64 * (1 - strength));
            } else {
                // faded grey copy of the design, like pixelmatch's `alpha: 0.1`
                const y = PixelCompare.luma(design.data, o);
                const faded = Math.round(255 + (y - 255) * 0.15);
                heatmap[o] = faded;
                heatmap[o + 1] = faded;
                heatmap[o + 2] = faded;
            }
            heatmap[o + 3] = 255;
        }
        const diffRatio = total === 0 ? 0 : different / total;
        const ssim = PixelCompare.ssim(design, app);
        return {
            diffRatio,
            ssim,
            score: PixelCompare.score(ssim, diffRatio),
            heatmap: { width, height, data: heatmap },
            regions: PixelCompare.regions(differs, width, height),
        };
    }

    /**
     * Combined score 0..100 of a comparison.
     *
     * @param ssim - structural similarity 0..1
     * @param diffRatio - share of differing pixels 0..1
     */
    public static score(ssim: number, diffRatio: number): number {
        const value = ((Math.max(0, ssim) + (1 - diffRatio)) / 2) * 100;
        return Math.round(Math.min(100, Math.max(0, value)));
    }

    /**
     * Mean SSIM of the luminance of two same-size images.
     */
    public static ssim(a: RgbaImage, b: RgbaImage): number {
        const { width, height } = a;
        const la = PixelCompare.lumaPlane(a);
        const lb = PixelCompare.lumaPlane(b);
        const size = Math.min(PixelCompare.WINDOW, width, height);
        if (size === 0) {
            return 1;
        }
        const c1 = (0.01 * 255) ** 2;
        const c2 = (0.03 * 255) ** 2;
        const n = size * size;
        let sum = 0;
        let windows = 0;
        const step = Math.max(1, Math.min(PixelCompare.STEP, size));
        for (let y = 0; y + size <= height; y += step) {
            for (let x = 0; x + size <= width; x += step) {
                let sa = 0;
                let sb = 0;
                let saa = 0;
                let sbb = 0;
                let sab = 0;
                for (let dy = 0; dy < size; dy++) {
                    let p = (y + dy) * width + x;
                    for (let dx = 0; dx < size; dx++, p++) {
                        const va = la[p];
                        const vb = lb[p];
                        sa += va;
                        sb += vb;
                        saa += va * va;
                        sbb += vb * vb;
                        sab += va * vb;
                    }
                }
                const ma = sa / n;
                const mb = sb / n;
                const va = saa / n - ma * ma;
                const vb = sbb / n - mb * mb;
                const cov = sab / n - ma * mb;
                sum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
                windows++;
            }
        }
        return windows === 0 ? 1 : sum / windows;
    }

    /** Squared YIQ distance of the pixels at byte offset `o`, both blended on white. */
    private static colorDelta(a: Uint8Array, b: Uint8Array, o: number): number {
        const [r1, g1, b1] = PixelCompare.onWhite(a, o);
        const [r2, g2, b2] = PixelCompare.onWhite(b, o);
        const y = PixelCompare.rgb2y(r1, g1, b1) - PixelCompare.rgb2y(r2, g2, b2);
        const i = PixelCompare.rgb2i(r1, g1, b1) - PixelCompare.rgb2i(r2, g2, b2);
        const q = PixelCompare.rgb2q(r1, g1, b1) - PixelCompare.rgb2q(r2, g2, b2);
        return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
    }

    private static onWhite(data: Uint8Array, o: number): [number, number, number] {
        const alpha = data[o + 3] / 255;
        return [255 + (data[o] - 255) * alpha, 255 + (data[o + 1] - 255) * alpha, 255 + (data[o + 2] - 255) * alpha];
    }

    private static luma(data: Uint8Array, o: number): number {
        const [r, g, b] = PixelCompare.onWhite(data, o);
        return PixelCompare.rgb2y(r, g, b);
    }

    private static lumaPlane(image: RgbaImage): Float32Array {
        const plane = new Float32Array(image.width * image.height);
        for (let i = 0; i < plane.length; i++) {
            plane[i] = PixelCompare.luma(image.data, i * 4);
        }
        return plane;
    }

    private static rgb2y(r: number, g: number, b: number): number {
        return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
    }

    private static rgb2i(r: number, g: number, b: number): number {
        return r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
    }

    private static rgb2q(r: number, g: number, b: number): number {
        return r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
    }

    /**
     * Merges the 16 px cells that hold differing pixels into rectangles (row runs joined with the
     * run below when they span the same columns), biggest first.
     */
    private static regions(differs: Uint8Array, width: number, height: number): Region[] {
        const cell = PixelCompare.CELL;
        const cols = Math.ceil(width / cell);
        const rows = Math.ceil(height / cell);
        const marked = new Uint8Array(cols * rows);
        for (let y = 0; y < height; y++) {
            const row = Math.floor(y / cell) * cols;
            for (let x = 0; x < width; x++) {
                if (differs[y * width + x]) {
                    marked[row + Math.floor(x / cell)] = 1;
                }
            }
        }
        // runs of marked cells per row, then grown downwards while the next row has the same run
        const open = new Map<string, { col: number; row: number; cols: number; rows: number }>();
        const done: { col: number; row: number; cols: number; rows: number }[] = [];
        for (let r = 0; r < rows; r++) {
            const seen = new Set<string>();
            let c = 0;
            while (c < cols) {
                if (!marked[r * cols + c]) {
                    c++;
                    continue;
                }
                const start = c;
                while (c < cols && marked[r * cols + c]) {
                    c++;
                }
                const key = `${start}:${c - start}`;
                seen.add(key);
                const current = open.get(key);
                if (current) {
                    current.rows++;
                } else {
                    open.set(key, { col: start, row: r, cols: c - start, rows: 1 });
                }
            }
            for (const [key, rect] of [...open.entries()]) {
                if (!seen.has(key)) {
                    done.push(rect);
                    open.delete(key);
                }
            }
        }
        done.push(...open.values());
        return done
            .map((rect) => {
                const x = rect.col * cell;
                const y = rect.row * cell;
                return {
                    x,
                    y,
                    width: Math.min(width, (rect.col + rect.cols) * cell) - x,
                    height: Math.min(height, (rect.row + rect.rows) * cell) - y,
                };
            })
            .sort((a, b) => b.width * b.height - a.width * a.height)
            .slice(0, PixelCompare.MAX_REGIONS);
    }
}
