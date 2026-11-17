/** Solid color as Penpot stores it: `#rrggbb` (lower case) plus opacity. */
export interface SolidColor {
    hex: string;
    opacity: number;
}

/**
 * Parser of the CSS color syntaxes Penpot can store as a solid color.
 *
 * Supports hex (3, 4, 6 and 8 digits), `rgb()`/`rgba()`, `hsl()`/`hsla()` and the basic named
 * colors. Other syntaxes (e.g. `oklch()`) are valid CSS but have no exact solid equivalent here.
 */
export class CssColor {
    private static readonly NAMED: Record<string, string> = {
        black: "#000000",
        white: "#ffffff",
        red: "#ff0000",
        green: "#008000",
        blue: "#0000ff",
        yellow: "#ffff00",
        cyan: "#00ffff",
        magenta: "#ff00ff",
        gray: "#808080",
        grey: "#808080",
        silver: "#c0c0c0",
        orange: "#ffa500",
        purple: "#800080",
        navy: "#000080",
        teal: "#008080",
    };

    private static readonly FUNCTION_PATTERN = /^(rgba?|hsla?)\(\s*([^)]*)\)$/i;

    /**
     * Parses a CSS color.
     *
     * @param value - the CSS color text
     * @returns the solid color, or null if the syntax is not supported
     */
    public static parse(value: string): SolidColor | null {
        const text = value.trim().toLowerCase();
        if (text === "transparent") {
            return { hex: "#000000", opacity: 0 };
        }
        if (CssColor.NAMED[text]) {
            return { hex: CssColor.NAMED[text], opacity: 1 };
        }
        if (text.startsWith("#")) {
            return CssColor.parseHex(text.slice(1));
        }
        const match = CssColor.FUNCTION_PATTERN.exec(text);
        if (!match) {
            return null;
        }
        const parts = match[2]
            .replace(/\s*\/\s*/, ",")
            .split(/\s*,\s*|\s+/)
            .filter((part) => part.length > 0);
        if (parts.length < 3 || parts.length > 4) {
            return null;
        }
        const alpha = parts.length === 4 ? CssColor.parseAlpha(parts[3]) : 1;
        if (alpha === null) {
            return null;
        }
        const channels = match[1].startsWith("rgb")
            ? CssColor.rgbChannels(parts.slice(0, 3))
            : CssColor.hslChannels(parts.slice(0, 3));
        if (channels === null) {
            return null;
        }
        return { hex: CssColor.toHex(channels), opacity: alpha };
    }

    /**
     * Checks whether two CSS colors denote the same solid color.
     */
    public static equivalent(a: string, b: string): boolean {
        const left = CssColor.parse(a);
        const right = CssColor.parse(b);
        if (left === null || right === null) {
            return a.trim().toLowerCase() === b.trim().toLowerCase();
        }
        return left.hex === right.hex && Math.abs(left.opacity - right.opacity) < 0.005;
    }

    /**
     * Formats a solid color as CSS: `#RRGGBB` when opaque, else `#RRGGBBAA`.
     */
    public static format(color: SolidColor): string {
        const hex = color.hex.toUpperCase();
        if (color.opacity >= 1) {
            return hex;
        }
        const alpha = Math.round(Math.max(0, color.opacity) * 255)
            .toString(16)
            .padStart(2, "0")
            .toUpperCase();
        return `${hex}${alpha}`;
    }

    private static parseHex(digits: string): SolidColor | null {
        if (!/^[0-9a-f]+$/.test(digits)) {
            return null;
        }
        let full = digits;
        if (digits.length === 3 || digits.length === 4) {
            full = [...digits].map((digit) => digit + digit).join("");
        }
        if (full.length !== 6 && full.length !== 8) {
            return null;
        }
        const opacity = full.length === 8 ? CssValues.round(parseInt(full.slice(6, 8), 16) / 255, 3) : 1;
        return { hex: `#${full.slice(0, 6)}`, opacity };
    }

    private static parseAlpha(text: string): number | null {
        const value = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
        return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
    }

    private static rgbChannels(parts: string[]): number[] | null {
        const channels = parts.map((part) =>
            part.endsWith("%") ? (Number(part.slice(0, -1)) * 255) / 100 : Number(part)
        );
        return channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)
            ? channels
            : null;
    }

    private static hslChannels(parts: string[]): number[] | null {
        const hue = Number(parts[0].replace(/deg$/, ""));
        const saturation = Number(parts[1].replace(/%$/, "")) / 100;
        const lightness = Number(parts[2].replace(/%$/, "")) / 100;
        if (![hue, saturation, lightness].every(Number.isFinite)) {
            return null;
        }
        const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
        const sector = (((hue % 360) + 360) % 360) / 60;
        const second = chroma * (1 - Math.abs((sector % 2) - 1));
        const [r, g, b] =
            sector < 1
                ? [chroma, second, 0]
                : sector < 2
                  ? [second, chroma, 0]
                  : sector < 3
                    ? [0, chroma, second]
                    : sector < 4
                      ? [0, second, chroma]
                      : sector < 5
                        ? [second, 0, chroma]
                        : [chroma, 0, second];
        const offset = lightness - chroma / 2;
        return [r, g, b].map((channel) => (channel + offset) * 255);
    }

    private static toHex(channels: number[]): string {
        return (
            "#" +
            channels
                .map((channel) =>
                    Math.round(Math.min(255, Math.max(0, channel)))
                        .toString(16)
                        .padStart(2, "0")
                )
                .join("")
        );
    }
}

/** Dimension: a number with a CSS unit. */
export interface Dimension {
    value: number;
    unit: "px" | "rem" | "em";
}

/**
 * Parser and converter of CSS dimensions and plain numbers.
 */
export class CssValues {
    /** root font size used to convert `rem` (and `em` without a font size) to px */
    public static readonly ROOT_FONT_PX = 16;

    private static readonly DIMENSION_PATTERN = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)$/;

    /**
     * Parses a dimension such as `16px`, `1.5rem` or `-0.5px`.
     *
     * @returns the dimension, or null if the text is not one
     */
    public static parseDimension(value: unknown): Dimension | null {
        if (typeof value !== "string") {
            return null;
        }
        const match = CssValues.DIMENSION_PATTERN.exec(value.trim());
        if (!match) {
            return null;
        }
        return { value: Number(match[1]), unit: match[2] as Dimension["unit"] };
    }

    /**
     * Parses a plain number (a YAML number or a numeric string).
     *
     * @returns the number, or null
     */
    public static parseNumber(value: unknown): number | null {
        if (typeof value === "number") {
            return Number.isFinite(value) ? value : null;
        }
        if (typeof value === "string" && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) {
            return Number(value.trim());
        }
        return null;
    }

    /**
     * Converts a dimension to px.
     *
     * @param value - the dimension text, or a number taken as px
     * @param emBasePx - px size of `1em` (the font size for letter spacing)
     * @returns the px value, or null if the value is not a dimension or number
     */
    public static toPx(value: unknown, emBasePx: number = CssValues.ROOT_FONT_PX): number | null {
        const number = CssValues.parseNumber(value);
        if (number !== null) {
            return number;
        }
        const dimension = CssValues.parseDimension(value);
        if (dimension === null) {
            return null;
        }
        switch (dimension.unit) {
            case "px":
                return dimension.value;
            case "rem":
                return dimension.value * CssValues.ROOT_FONT_PX;
            case "em":
                return dimension.value * emBasePx;
        }
    }

    /**
     * Converts a line height to a unitless multiplier of the font size.
     *
     * @param value - unitless number or dimension
     * @param fontSizePx - the font size in px
     */
    public static lineHeightMultiplier(value: unknown, fontSizePx: number): number | null {
        const number = CssValues.parseNumber(value);
        if (number !== null) {
            return number;
        }
        const px = CssValues.toPx(value, fontSizePx);
        return px === null || fontSizePx <= 0 ? null : px / fontSizePx;
    }

    /**
     * Rounds a number to a number of decimals.
     */
    public static round(value: number, decimals: number = 4): number {
        const factor = 10 ** decimals;
        return Math.round(value * factor) / factor;
    }

    /**
     * Formats a number without trailing zeros (`16`, `1.5`, `-0.25`).
     */
    public static formatNumber(value: number, decimals: number = 4): string {
        const rounded = CssValues.round(value, decimals);
        return Object.is(rounded, -0) ? "0" : String(rounded);
    }

    /**
     * Formats a px value as a dimension (`16px`).
     */
    public static formatPx(value: number): string {
        return `${CssValues.formatNumber(value)}px`;
    }
}
