import type { ShadowLayer, TokenCategory, TokenValue, TypographyValue } from "./DesignTokens";
import type { ThemeEntry, ThemeModel } from "./ThemeModel";

/**
 * Format of the generated theme block, chosen per stack family:
 * - `react-native`: JS/TS object, numbers for sizes (React Native / Expo styles)
 * - `js-web`: JS/TS object, CSS strings for sizes (CSS-in-JS, inline styles, Tailwind v3 config)
 * - `css`: CSS custom properties on `:root`
 * - `tailwind`: Tailwind CSS v4 `@theme` variables (they become utilities like `bg-primary`)
 */
export type ThemeFormat = "react-native" | "js-web" | "css" | "tailwind";

/** Module syntax of a JS/TS theme file. */
export type ModuleKind = "ts" | "esm" | "cjs";

/** Comment syntax of the file the block lives in. */
export type CommentStyle = "line" | "block";

/**
 * Generator of the theme block for one format: the block body and the reference code uses for
 * each token. Deterministic (no Claude): the same tokens always give the same text.
 */
export abstract class ThemeGenerator {
    public static readonly FORMATS: ThemeFormat[] = ["react-native", "js-web", "css", "tailwind"];

    /** comment syntax of the marker lines */
    public abstract readonly comment: CommentStyle;

    /**
     * Gets the generator of a format.
     *
     * @param format - the theme format
     * @param module - module syntax (JS formats only)
     * @param quote - string quote of the file (JS formats only)
     */
    public static create(format: ThemeFormat, module: ModuleKind = "ts", quote: "'" | '"' = "'"): ThemeGenerator {
        switch (format) {
            case "react-native":
            case "js-web":
                return new JsThemeGenerator(format, module, quote);
            case "css":
                return new CssThemeGenerator();
            case "tailwind":
                return new TailwindThemeGenerator();
        }
    }

    /** Renders the block body (without the marker lines). */
    public abstract render(model: ThemeModel): string[];

    /** Gets how code refers to a token, e.g. `tokens.color.primary` or `var(--color-primary)`. */
    public abstract reference(entry: ThemeEntry): string;

    /** Gets the patterns that find a use of a token in source code (outside the block). */
    public abstract usagePatterns(entry: ThemeEntry): RegExp[];

    protected static escape(text: string): string {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    protected static shadowCss(layers: ShadowLayer[]): string {
        return layers
            .map((layer) =>
                [
                    layer.inset ? "inset" : null,
                    ThemeGenerator.px(layer.offsetX),
                    ThemeGenerator.px(layer.offsetY),
                    ThemeGenerator.px(layer.blur),
                    ThemeGenerator.px(layer.spread),
                    layer.color,
                ]
                    .filter((part) => part !== null)
                    .join(" ")
            )
            .join(", ");
    }

    protected static familyCss(families: string[]): string {
        return families
            .map((family) => (/^[a-z-]+$/i.test(family) ? family : `"${family.replace(/"/g, "")}"`))
            .join(", ");
    }

    protected static px(value: number): string {
        return value === 0 ? "0px" : `${value}px`;
    }
}

/**
 * JS/TS theme object `tokens` (`export const tokens = {…} as const;`), for React Native
 * (numbers, one font family name, string font weights, px line heights) or the web (CSS strings).
 */
class JsThemeGenerator extends ThemeGenerator {
    public readonly comment: CommentStyle = "line";

    constructor(
        private readonly format: "react-native" | "js-web",
        private readonly module: ModuleKind,
        private readonly quote: "'" | '"'
    ) {
        super();
    }

    public render(model: ThemeModel): string[] {
        const lines = [`${this.module === "cjs" ? "const" : "export const"} tokens = {`];
        for (const [category, entries] of model.groups) {
            lines.push(`  ${category}: {`);
            for (const entry of entries) {
                lines.push(`    ${this.key(entry.key)}: ${this.value(entry.token.value)},`);
            }
            lines.push("  },");
        }
        lines.push(this.module === "ts" ? "} as const;" : "};");
        return lines;
    }

    public reference(entry: ThemeEntry): string {
        return JsThemeGenerator.IDENTIFIER.test(entry.key)
            ? `tokens.${entry.category}.${entry.key}`
            : `tokens.${entry.category}[${this.string(entry.key)}]`;
    }

    public usagePatterns(entry: ThemeEntry): RegExp[] {
        const key = ThemeGenerator.escape(entry.key);
        return [new RegExp(`tokens\\.${entry.category}(?:\\.${key}(?![\\w$])|\\[\\s*["'\`]?${key}["'\`]?\\s*\\])`)];
    }

    private static readonly IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

    private key(key: string): string {
        return JsThemeGenerator.IDENTIFIER.test(key) ? key : this.string(key);
    }

    private string(text: string): string {
        const escaped = text.replace(/\\/g, "\\\\").replace(new RegExp(this.quote, "g"), `\\${this.quote}`);
        return `${this.quote}${escaped}${this.quote}`;
    }

    private value(value: TokenValue): string {
        const native = this.format === "react-native";
        switch (value.kind) {
            case "color":
            case "string":
                return this.string(value.value);
            case "dimension":
                return native ? String(value.value) : this.string(ThemeGenerator.px(value.value));
            case "number":
                return String(value.value);
            case "fontFamily":
                return this.string(native ? value.value[0] : ThemeGenerator.familyCss(value.value));
            case "fontWeight":
                return native ? this.string(String(value.value)) : String(value.value);
            case "shadow":
                return this.string(ThemeGenerator.shadowCss(value.value));
            case "typography":
                return this.typography(value.value);
        }
    }

    private typography(t: TypographyValue): string {
        const native = this.format === "react-native";
        const parts: string[] = [];
        if (t.fontFamily) {
            parts.push(`fontFamily: ${this.string(native ? t.fontFamily[0] : ThemeGenerator.familyCss(t.fontFamily))}`);
        }
        if (t.fontSize !== undefined) {
            parts.push(`fontSize: ${native ? t.fontSize : this.string(ThemeGenerator.px(t.fontSize))}`);
        }
        if (t.fontWeight !== undefined) {
            parts.push(`fontWeight: ${native ? this.string(String(t.fontWeight)) : t.fontWeight}`);
        }
        if (t.fontStyle) {
            parts.push(`fontStyle: ${this.string(t.fontStyle)}`);
        }
        if (t.lineHeight !== undefined) {
            if (native) {
                // React Native wants line heights in px
                const px =
                    t.lineHeightPx || t.fontSize === undefined ? t.lineHeight : Math.round(t.fontSize * t.lineHeight);
                parts.push(`lineHeight: ${px}`);
            } else {
                parts.push(
                    `lineHeight: ${t.lineHeightPx ? this.string(ThemeGenerator.px(t.lineHeight)) : t.lineHeight}`
                );
            }
        }
        if (t.letterSpacing !== undefined) {
            parts.push(`letterSpacing: ${native ? t.letterSpacing : this.string(ThemeGenerator.px(t.letterSpacing))}`);
        }
        if (t.textCase) {
            parts.push(`textTransform: ${this.string(t.textCase)}`);
        }
        if (t.textDecoration) {
            const decoration = t.textDecoration === "strike-through" ? "line-through" : t.textDecoration;
            parts.push(`${native ? "textDecorationLine" : "textDecoration"}: ${this.string(decoration)}`);
        }
        return `{ ${parts.join(", ")} }`;
    }
}

/** CSS custom properties on `:root`; typographies become one variable per property. */
class CssThemeGenerator extends ThemeGenerator {
    public readonly comment: CommentStyle = "block";

    /** Variable name prefix per category (Tailwind v4 names, so both CSS formats read alike). */
    public static readonly PREFIX: Record<TokenCategory, string> = {
        color: "color",
        spacing: "spacing",
        radius: "radius",
        shadow: "shadow",
        typography: "typography",
        fontFamily: "font",
        fontSize: "text",
        fontWeight: "font-weight",
        letterSpacing: "tracking",
        size: "size",
        dimension: "dimension",
        borderWidth: "border-width",
        opacity: "opacity",
        number: "number",
        rotation: "rotation",
        textCase: "text-case",
        textDecoration: "text-decoration",
    };

    public render(model: ThemeModel): string[] {
        return [":root {", ...model.entries.flatMap((entry) => this.declarations(entry)).map((l) => `  ${l}`), "}"];
    }

    public reference(entry: ThemeEntry): string {
        return entry.category === "typography" ? `var(--${this.name(entry)}-font-size)` : `var(--${this.name(entry)})`;
    }

    public usagePatterns(entry: ThemeEntry): RegExp[] {
        return [new RegExp(`--${ThemeGenerator.escape(this.name(entry))}(?![\\w-])`)];
    }

    protected name(entry: ThemeEntry): string {
        return `${CssThemeGenerator.PREFIX[entry.category]}-${entry.cssName}`;
    }

    /** Declarations of one token, without indentation. */
    protected declarations(entry: ThemeEntry): string[] {
        const name = this.name(entry);
        const value = entry.token.value;
        if (value.kind === "typography") {
            return CssThemeGenerator.typography(value.value).map(([property, css]) => `--${name}-${property}: ${css};`);
        }
        return [`--${name}: ${CssThemeGenerator.css(value)};`];
    }

    protected static css(value: Exclude<TokenValue, { kind: "typography" }>): string {
        switch (value.kind) {
            case "color":
            case "string":
                return value.value;
            case "dimension":
                return ThemeGenerator.px(value.value);
            case "number":
                return String(value.value);
            case "fontFamily":
                return ThemeGenerator.familyCss(value.value);
            case "fontWeight":
                return String(value.value);
            case "shadow":
                return ThemeGenerator.shadowCss(value.value);
        }
    }

    /** CSS properties of a typography, as `[property, value]`. */
    protected static typography(t: TypographyValue): [string, string][] {
        const result: [string, string][] = [];
        if (t.fontFamily) {
            result.push(["font-family", ThemeGenerator.familyCss(t.fontFamily)]);
        }
        if (t.fontSize !== undefined) {
            result.push(["font-size", ThemeGenerator.px(t.fontSize)]);
        }
        if (t.fontWeight !== undefined) {
            result.push(["font-weight", String(t.fontWeight)]);
        }
        if (t.fontStyle) {
            result.push(["font-style", t.fontStyle]);
        }
        if (t.lineHeight !== undefined) {
            result.push(["line-height", t.lineHeightPx ? ThemeGenerator.px(t.lineHeight) : String(t.lineHeight)]);
        }
        if (t.letterSpacing !== undefined) {
            result.push(["letter-spacing", ThemeGenerator.px(t.letterSpacing)]);
        }
        if (t.textCase) {
            result.push(["text-transform", t.textCase]);
        }
        if (t.textDecoration) {
            result.push(["text-decoration", t.textDecoration === "strike-through" ? "line-through" : t.textDecoration]);
        }
        return result;
    }
}

/**
 * Tailwind CSS v4 theme: `@theme` variables in Tailwind's namespaces (`--color-*`, `--spacing-*`,
 * `--radius-*`, `--shadow-*`, `--font-*`, `--text-*` with `--line-height` etc. modifiers,
 * `--font-weight-*`, `--tracking-*`), so tokens become utilities (`bg-primary`, `p-md`). Tokens
 * without a Tailwind namespace go to `:root`.
 */
class TailwindThemeGenerator extends CssThemeGenerator {
    private static readonly THEME_CATEGORIES = new Set<TokenCategory>([
        "color",
        "spacing",
        "radius",
        "shadow",
        "typography",
        "fontFamily",
        "fontSize",
        "fontWeight",
        "letterSpacing",
    ]);

    public render(model: ThemeModel): string[] {
        const entries = model.entries;
        const theme = entries.filter((entry) => TailwindThemeGenerator.THEME_CATEGORIES.has(entry.category));
        const rest = entries.filter((entry) => !TailwindThemeGenerator.THEME_CATEGORIES.has(entry.category));
        const lines: string[] = [];
        if (theme.length > 0) {
            lines.push("@theme {", ...theme.flatMap((entry) => this.declarations(entry)).map((l) => `  ${l}`), "}");
        }
        if (rest.length > 0) {
            lines.push(":root {", ...rest.flatMap((entry) => this.declarations(entry)).map((l) => `  ${l}`), "}");
        }
        return lines;
    }

    public reference(entry: ThemeEntry): string {
        return `var(--${this.name(entry)})`;
    }

    public usagePatterns(entry: ThemeEntry): RegExp[] {
        const name = ThemeGenerator.escape(this.name(entry));
        const patterns = [new RegExp(`--${name}(?![\\w-])`)];
        if (TailwindThemeGenerator.THEME_CATEGORIES.has(entry.category)) {
            // utilities such as `bg-primary`, `p-md`, `rounded-card`, `text-title`
            patterns.push(new RegExp(`[a-z]-${ThemeGenerator.escape(entry.cssName)}(?![\\w-])`));
        }
        return patterns;
    }

    protected name(entry: ThemeEntry): string {
        return entry.category === "typography" ? `text-${entry.cssName}` : super.name(entry);
    }

    protected declarations(entry: ThemeEntry): string[] {
        const value = entry.token.value;
        if (value.kind !== "typography") {
            return super.declarations(entry);
        }
        // `--text-<name>` is the font size; the other properties are Tailwind's `--` modifiers
        const name = this.name(entry);
        const modifiers: Record<string, string> = {
            "line-height": "line-height",
            "letter-spacing": "letter-spacing",
            "font-weight": "font-weight",
        };
        const lines: string[] = [];
        for (const [property, css] of CssThemeGenerator.typography(value.value)) {
            if (property === "font-size") {
                lines.unshift(`--${name}: ${css};`);
            } else if (modifiers[property]) {
                lines.push(`--${name}--${modifiers[property]}: ${css};`);
            } else if (property === "font-family") {
                lines.push(`--font-${entry.cssName}: ${css};`);
            }
        }
        return lines;
    }
}
