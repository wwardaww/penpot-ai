/**
 * Opaque sRGB color with the math the audit needs: WCAG contrast, alpha blending and perceptual
 * distance.
 */
export class Rgb {
    /** White, the assumed canvas color behind everything. */
    public static readonly WHITE = new Rgb(255, 255, 255);

    private static readonly HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

    /**
     * @param r - red, 0-255
     * @param g - green, 0-255
     * @param b - blue, 0-255
     */
    constructor(
        public readonly r: number,
        public readonly g: number,
        public readonly b: number
    ) {}

    /**
     * Parses `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored).
     *
     * @param value - the hex string
     * @returns the color, or null if the value is not a hex color
     */
    public static parse(value: unknown): Rgb | null {
        if (typeof value !== "string") {
            return null;
        }
        const match = Rgb.HEX_PATTERN.exec(value.trim());
        if (!match) {
            return null;
        }
        let hex = match[1];
        if (hex.length === 3) {
            hex = hex
                .split("")
                .map((c) => c + c)
                .join("");
        }
        return new Rgb(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
    }

    /** Upper-case `#RRGGBB`. */
    public hex(): string {
        const part = (v: number) => Math.round(v).toString(16).padStart(2, "0");
        return `#${part(this.r)}${part(this.g)}${part(this.b)}`.toUpperCase();
    }

    /**
     * Paints this color with an opacity over a background.
     *
     * @param background - the color below
     * @param alpha - opacity of this color, 0-1
     */
    public over(background: Rgb, alpha: number): Rgb {
        const a = Math.max(0, Math.min(1, alpha));
        const mix = (top: number, bottom: number) => top * a + bottom * (1 - a);
        return new Rgb(mix(this.r, background.r), mix(this.g, background.g), mix(this.b, background.b));
    }

    /** WCAG relative luminance. */
    public luminance(): number {
        const channel = (v: number) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(this.r) + 0.7152 * channel(this.g) + 0.0722 * channel(this.b);
    }

    /**
     * WCAG contrast ratio between two colors (1 to 21).
     *
     * @param other - the other color
     */
    public contrast(other: Rgb): number {
        const a = this.luminance();
        const b = other.luminance();
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }

    /**
     * Perceptual distance (CIE76 delta E in Lab); below ~2.3 most people see no difference.
     *
     * @param other - the other color
     */
    public distance(other: Rgb): number {
        const [l1, a1, b1] = this.lab();
        const [l2, a2, b2] = other.lab();
        return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
    }

    private lab(): [number, number, number] {
        const linear = (v: number) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        const r = linear(this.r);
        const g = linear(this.g);
        const b = linear(this.b);
        // D65 reference white
        const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
        const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
        const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
        const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
        const fx = f(x);
        const fy = f(y);
        const fz = f(z);
        return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    }
}
