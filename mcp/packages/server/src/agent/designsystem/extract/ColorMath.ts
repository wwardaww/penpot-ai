/** Hue families used to name colors that have no name yet. */
const HUES: { name: string; until: number }[] = [
    { name: "red", until: 15 },
    { name: "orange", until: 40 },
    { name: "yellow", until: 65 },
    { name: "green", until: 160 },
    { name: "teal", until: 195 },
    { name: "blue", until: 245 },
    { name: "indigo", until: 265 },
    { name: "purple", until: 300 },
    { name: "pink", until: 345 },
    { name: "red", until: 361 },
];

/**
 * Color helpers of the inventory: parsing, perceived distance (CIE76 in Lab) to find colors that
 * are almost the same, and plain names (`neutral-700`, `blue-500`) for colors the file never
 * named.
 */
export class ColorMath {
    /** Lab distance under which two colors count as the same to the eye. */
    public static readonly NEAR = 4;

    /** Lowercase `#rrggbb` of a hex color (`#abc`, `#aabbcc`, `#aabbccdd`), or null. */
    public static normalize(value: unknown): string | null {
        if (typeof value !== "string") {
            return null;
        }
        const text = value.trim().toLowerCase();
        const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
        if (short) {
            return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
        }
        const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text);
        return long ? `#${long[1]}` : null;
    }

    /** RGB channels 0–255 of a `#rrggbb` color. */
    public static rgb(hex: string): [number, number, number] {
        const value = parseInt(hex.slice(1, 7), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    }

    /** Perceived distance of two colors (CIE76 ΔE in Lab). */
    public static distance(a: string, b: string): number {
        const [l1, a1, b1] = ColorMath.lab(a);
        const [l2, a2, b2] = ColorMath.lab(b);
        return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
    }

    /** Hue (0–360), saturation and lightness (0–1) of a color. */
    public static hsl(hex: string): { h: number; s: number; l: number } {
        const [r, g, b] = ColorMath.rgb(hex).map((c) => c / 255);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const d = max - min;
        if (d === 0) {
            return { h: 0, s: 0, l };
        }
        const s = d / (1 - Math.abs(2 * l - 1));
        let h: number;
        if (max === r) {
            h = ((g - b) / d) % 6;
        } else if (max === g) {
            h = (b - r) / d + 2;
        } else {
            h = (r - g) / d + 4;
        }
        h *= 60;
        return { h: h < 0 ? h + 360 : h, s, l };
    }

    /** Whether a color reads as gray (white, black and tinted grays such as `#111827` included). */
    public static isNeutral(hex: string): boolean {
        const [r, g, b] = ColorMath.rgb(hex);
        return (Math.max(r, g, b) - Math.min(r, g, b)) / 255 < 0.1;
    }

    /**
     * Plain name of a color without one: `white`, `black`, `neutral-<step>` or `<hue>-<step>`,
     * the step following the usual 50–900 scale (lighter = lower).
     */
    public static plainName(hex: string): string {
        if (hex === "#ffffff") {
            return "white";
        }
        if (hex === "#000000") {
            return "black";
        }
        const { h, l } = ColorMath.hsl(hex);
        const step = ColorMath.step(l);
        if (ColorMath.isNeutral(hex)) {
            return `neutral-${step}`;
        }
        const hue = HUES.find((entry) => h < entry.until)?.name ?? "red";
        return `${hue}-${step}`;
    }

    private static step(lightness: number): number {
        const raw = Math.round((1 - lightness) * 10) * 100;
        if (raw <= 0) {
            return 50;
        }
        return Math.min(900, raw);
    }

    private static lab(hex: string): [number, number, number] {
        const linear = ColorMath.rgb(hex).map((c) => {
            const v = c / 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        const [r, g, b] = linear;
        const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
        const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
        const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
        const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        const fx = f(x);
        const fy = f(y);
        const fz = f(z);
        return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    }
}
