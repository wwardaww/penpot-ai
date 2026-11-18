/** Token as read from the Penpot file (raw and resolved value, as the Plugin API gives them). */
export interface PenpotToken {
    name: string;
    /** Penpot token type, e.g. `color`, `spacing`, `borderRadius`, `typography` */
    type: string;
    /** value as defined in the token (string, reference or composite) */
    value: unknown;
    /** value after resolving references in the active sets; null when nothing resolves */
    resolved: unknown;
    description: string;
}

/** Token set as read from the Penpot file. */
export interface PenpotTokenSet {
    name: string;
    active: boolean;
    tokens: PenpotToken[];
}

/** Tokens of the open Penpot file, as read by {@link PenpotTokenReader}. */
export interface PenpotTokenSnapshot {
    fileName: string;
    /** sets in the user's order (later active sets win for the same token name) */
    sets: PenpotTokenSet[];
    /** active themes, `group/name` or `name` */
    activeThemes: string[];
}

/** Layer of a shadow token. */
export interface ShadowLayer {
    color: string;
    inset: boolean;
    offsetX: number;
    offsetY: number;
    blur: number;
    spread: number;
}

/** Composite value of a typography token; missing parts stay undefined. */
export interface TypographyValue {
    fontFamily?: string[];
    /** px */
    fontSize?: number;
    fontWeight?: number;
    fontStyle?: "italic";
    /** multiplier of the font size (1.2), or px when `lineHeightPx` */
    lineHeight?: number;
    lineHeightPx?: boolean;
    /** px */
    letterSpacing?: number;
    textCase?: string;
    textDecoration?: string;
}

/** Resolved, typed value of a design token. */
export type TokenValue =
    | { kind: "color"; value: string }
    | { kind: "dimension"; value: number }
    | { kind: "number"; value: number }
    | { kind: "fontFamily"; value: string[] }
    | { kind: "fontWeight"; value: number; italic: boolean }
    | { kind: "string"; value: string }
    | { kind: "shadow"; value: ShadowLayer[] }
    | { kind: "typography"; value: TypographyValue };

/** Theme group of a token in the generated code (`tokens.<category>.<key>`). */
export type TokenCategory =
    | "color"
    | "spacing"
    | "radius"
    | "shadow"
    | "typography"
    | "fontFamily"
    | "fontSize"
    | "fontWeight"
    | "letterSpacing"
    | "size"
    | "dimension"
    | "borderWidth"
    | "opacity"
    | "number"
    | "rotation"
    | "textCase"
    | "textDecoration";

/** Design token resolved for code generation. */
export interface DesignToken {
    /** Penpot name, e.g. `color.primary` */
    name: string;
    /** Penpot token type */
    type: string;
    category: TokenCategory;
    value: TokenValue;
    /** value as defined in Penpot (a reference like `{color.base}` stays visible here) */
    raw: unknown;
    description: string;
    /** set the value comes from */
    set: string;
}

/** Tokens names added, changed or removed since the last export. */
export interface TokenChanges {
    added: string[];
    changed: string[];
    removed: string[];
}

type DtcgNode = Record<string, unknown>;

/**
 * Design tokens of a Penpot file, resolved with its active sets: the source of the generated
 * theme and of the W3C Design Tokens (DTCG) export `design/penpot-tokens.json`.
 *
 * Conversion rules live here, in one place: Penpot type to category and DTCG type, value parsing
 * (numbers in px, font weights as numbers, shadows and typographies as composites), the export
 * and the comparison with a previous export.
 */
export class DesignTokens {
    /** marker of the export, so a later run recognizes its own file */
    public static readonly GENERATOR = "penforge-token-sync";

    private static readonly CATEGORY: Record<string, TokenCategory> = {
        color: "color",
        spacing: "spacing",
        borderRadius: "radius",
        shadow: "shadow",
        typography: "typography",
        fontFamilies: "fontFamily",
        fontSizes: "fontSize",
        fontWeights: "fontWeight",
        letterSpacing: "letterSpacing",
        sizing: "size",
        dimension: "dimension",
        borderWidth: "borderWidth",
        opacity: "opacity",
        number: "number",
        rotation: "rotation",
        textCase: "textCase",
        textDecoration: "textDecoration",
    };

    private static readonly DIMENSION_TYPES = new Set([
        "spacing",
        "borderRadius",
        "fontSizes",
        "letterSpacing",
        "sizing",
        "dimension",
        "borderWidth",
    ]);

    private static readonly NUMBER_TYPES = new Set(["opacity", "number", "rotation"]);

    private static readonly WEIGHTS: Record<string, number> = {
        thin: 100,
        hairline: 100,
        extralight: 200,
        ultralight: 200,
        light: 300,
        regular: 400,
        normal: 400,
        book: 400,
        medium: 500,
        semibold: 600,
        demibold: 600,
        bold: 700,
        extrabold: 800,
        ultrabold: 800,
        heavy: 800,
        black: 900,
    };

    private constructor(
        public readonly fileName: string,
        public readonly tokens: DesignToken[],
        public readonly activeSets: string[],
        public readonly activeThemes: string[],
        /** names of tokens whose value could not be resolved or read */
        public readonly skipped: string[]
    ) {}

    /**
     * Resolves the tokens of a snapshot: only active sets count, and a later active set wins for
     * the same name (Penpot's rule).
     *
     * @param snapshot - the tokens as read from Penpot
     */
    public static fromSnapshot(snapshot: PenpotTokenSnapshot): DesignTokens {
        const byName = new Map<string, DesignToken>();
        const skipped = new Set<string>();
        const activeSets = snapshot.sets.filter((set) => set.active);
        for (const set of activeSets) {
            for (const token of set.tokens) {
                const category = DesignTokens.CATEGORY[token.type];
                const value = category === undefined ? null : DesignTokens.parse(token.type, token.resolved);
                if (category === undefined || value === null) {
                    skipped.add(token.name);
                    continue;
                }
                skipped.delete(token.name);
                byName.set(token.name, {
                    name: token.name,
                    type: token.type,
                    category,
                    value,
                    raw: token.value,
                    description: token.description,
                    set: set.name,
                });
            }
        }
        const tokens = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
        return new DesignTokens(
            snapshot.fileName,
            tokens,
            activeSets.map((set) => set.name),
            snapshot.activeThemes,
            [...skipped].filter((name) => !byName.has(name)).sort()
        );
    }

    /** Tells whether the file has no usable token. */
    public get isEmpty(): boolean {
        return this.tokens.length === 0;
    }

    /**
     * Builds the W3C Design Tokens (DTCG) document: groups follow the token names (`color.primary`
     * → `color` → `primary`), values are the resolved ones, and the Penpot type, set and raw value
     * (with references) sit in `$extensions.penpot`.
     */
    public toDtcg(): DtcgNode {
        const root: DtcgNode = {
            $description: `Design tokens of the Penpot file "${this.fileName}", resolved with its active sets.`,
            $extensions: {
                penforge: {
                    generator: DesignTokens.GENERATOR,
                    activeSets: this.activeSets,
                    activeThemes: this.activeThemes,
                },
            },
        };
        for (const token of this.tokens) {
            const node: DtcgNode = {};
            const type = DesignTokens.dtcgType(token);
            if (type !== null) {
                node.$type = type;
            }
            node.$value = DesignTokens.dtcgValue(token.value);
            if (token.description) {
                node.$description = token.description;
            }
            node.$extensions = {
                penpot: { type: token.type, set: token.set, ...(token.raw !== undefined ? { value: token.raw } : {}) },
            };
            DesignTokens.place(root, token.name.split("."), node);
        }
        return root;
    }

    /**
     * Compares these tokens with a previous DTCG export (by name and resolved value).
     *
     * @param previous - the previous export, or null
     */
    public changesSince(previous: unknown): TokenChanges {
        const before = DesignTokens.flatten(previous);
        const now = new Map(
            this.tokens.map((token) => [token.name, JSON.stringify(DesignTokens.dtcgValue(token.value))])
        );
        const added: string[] = [];
        const changed: string[] = [];
        for (const [name, value] of now) {
            if (!before.has(name)) {
                added.push(name);
            } else if (before.get(name) !== value) {
                changed.push(name);
            }
        }
        const removed = [...before.keys()].filter((name) => !now.has(name));
        return { added, changed, removed: removed.sort() };
    }

    // parsing ---------------------------------------------------------------------------------

    /**
     * Parses a resolved Plugin API value of a token type.
     *
     * @returns the typed value, or null when it is missing or not usable
     */
    public static parse(type: string, resolved: unknown): TokenValue | null {
        if (resolved === undefined || resolved === null) {
            return null;
        }
        if (type === "color") {
            const color = DesignTokens.color(resolved);
            return color === null ? null : { kind: "color", value: color };
        }
        if (DesignTokens.DIMENSION_TYPES.has(type)) {
            const value = DesignTokens.number(resolved);
            return value === null ? null : { kind: "dimension", value };
        }
        if (DesignTokens.NUMBER_TYPES.has(type)) {
            const value = DesignTokens.number(resolved);
            return value === null ? null : { kind: "number", value };
        }
        if (type === "fontFamilies") {
            const families = DesignTokens.families(resolved);
            return families.length === 0 ? null : { kind: "fontFamily", value: families };
        }
        if (type === "fontWeights") {
            const weight = DesignTokens.weight(resolved);
            return weight === null ? null : { kind: "fontWeight", value: weight.value, italic: weight.italic };
        }
        if (type === "textCase" || type === "textDecoration") {
            return typeof resolved === "string" && resolved.trim() ? { kind: "string", value: resolved.trim() } : null;
        }
        if (type === "shadow") {
            const layers = (Array.isArray(resolved) ? resolved : [resolved])
                .map((layer) => DesignTokens.shadowLayer(layer))
                .filter((layer): layer is ShadowLayer => layer !== null);
            return layers.length === 0 ? null : { kind: "shadow", value: layers };
        }
        if (type === "typography") {
            const typography = DesignTokens.typography(Array.isArray(resolved) ? resolved[0] : resolved);
            return typography === null ? null : { kind: "typography", value: typography };
        }
        return null;
    }

    private static color(raw: unknown): string | null {
        if (typeof raw !== "string" || raw.trim().length === 0) {
            return null;
        }
        const value = raw.trim();
        return /^#[0-9a-f]{3,8}$/i.test(value) ? value.toLowerCase() : value;
    }

    private static number(raw: unknown): number | null {
        if (typeof raw === "number") {
            return Number.isFinite(raw) ? DesignTokens.round(raw) : null;
        }
        if (typeof raw === "string") {
            const match = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(px)?\s*$/i.exec(raw);
            return match ? DesignTokens.round(Number(match[1])) : null;
        }
        return null;
    }

    private static families(raw: unknown): string[] {
        const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
        return list
            .map((family) =>
                String(family)
                    .trim()
                    .replace(/^["']|["']$/g, "")
                    .trim()
            )
            .filter((family) => family.length > 0);
    }

    private static weight(raw: unknown): { value: number; italic: boolean } | null {
        if (typeof raw === "number") {
            return raw >= 1 && raw <= 1000 ? { value: Math.round(raw), italic: false } : null;
        }
        if (typeof raw !== "string") {
            return null;
        }
        const text = raw.trim().toLowerCase();
        const italic = /italic|oblique/.test(text);
        const numeric = /\d{3}/.exec(text);
        if (numeric) {
            return { value: Number(numeric[0]), italic };
        }
        const word = text.replace(/italic|oblique/g, "").replace(/[^a-z]/g, "");
        const value = DesignTokens.WEIGHTS[word === "" && italic ? "regular" : word];
        return value === undefined ? null : { value, italic };
    }

    private static shadowLayer(raw: unknown): ShadowLayer | null {
        if (typeof raw !== "object" || raw === null) {
            return null;
        }
        const layer = raw as Record<string, unknown>;
        const color = DesignTokens.color(layer.color);
        if (color === null) {
            return null;
        }
        const num = (value: unknown) => DesignTokens.number(value) ?? 0;
        return {
            color,
            inset: layer.inset === true || layer.inset === "true",
            offsetX: num(layer.offsetX),
            offsetY: num(layer.offsetY),
            blur: num(layer.blur),
            spread: num(layer.spread),
        };
    }

    private static typography(raw: unknown): TypographyValue | null {
        if (typeof raw !== "object" || raw === null) {
            return null;
        }
        const source = raw as Record<string, unknown>;
        const result: TypographyValue = {};
        const families = DesignTokens.families(source.fontFamilies ?? source.fontFamily);
        if (families.length > 0) {
            result.fontFamily = families;
        }
        const size = DesignTokens.number(source.fontSizes ?? source.fontSize);
        if (size !== null) {
            result.fontSize = size;
        }
        const weight = DesignTokens.weight(source.fontWeights ?? source.fontWeight);
        if (weight !== null) {
            result.fontWeight = weight.value;
            if (weight.italic) {
                result.fontStyle = "italic";
            }
        }
        const lineHeight = DesignTokens.lineHeight(source.lineHeight);
        if (lineHeight !== null) {
            result.lineHeight = lineHeight.value;
            if (lineHeight.px) {
                result.lineHeightPx = true;
            }
        }
        const spacing = DesignTokens.number(source.letterSpacing);
        if (spacing !== null) {
            result.letterSpacing = spacing;
        }
        for (const key of ["textCase", "textDecoration"] as const) {
            const value = source[key];
            if (typeof value === "string" && value.trim() && value.trim() !== "none") {
                result[key] = value.trim();
            }
        }
        return Object.keys(result).length === 0 ? null : result;
    }

    /** Line height: `120%` and numbers up to 4 are multipliers, larger numbers and `24px` are px. */
    private static lineHeight(raw: unknown): { value: number; px: boolean } | null {
        if (typeof raw === "string" && /%\s*$/.test(raw)) {
            const percent = DesignTokens.number(raw.replace("%", ""));
            return percent === null ? null : { value: DesignTokens.round(percent / 100), px: false };
        }
        const px = typeof raw === "string" && /px\s*$/i.test(raw);
        const value = DesignTokens.number(raw);
        if (value === null || value <= 0) {
            return null;
        }
        return { value, px: px || value > 4 };
    }

    private static round(value: number): number {
        return Math.round(value * 10000) / 10000;
    }

    // DTCG ------------------------------------------------------------------------------------

    private static dtcgType(token: DesignToken): string | null {
        switch (token.value.kind) {
            case "color":
                return "color";
            case "dimension":
                return "dimension";
            case "number":
                return "number";
            case "fontFamily":
                return "fontFamily";
            case "fontWeight":
                return "fontWeight";
            case "shadow":
                return "shadow";
            case "typography":
                return "typography";
            case "string":
                return null;
        }
    }

    private static dtcgValue(value: TokenValue): unknown {
        const px = (n: number) => `${n}px`;
        switch (value.kind) {
            case "color":
            case "number":
            case "string":
                return value.value;
            case "dimension":
                return px(value.value);
            case "fontFamily":
                return value.value;
            case "fontWeight":
                return value.value;
            case "shadow": {
                const layers = value.value.map((layer) => ({
                    color: layer.color,
                    offsetX: px(layer.offsetX),
                    offsetY: px(layer.offsetY),
                    blur: px(layer.blur),
                    spread: px(layer.spread),
                    ...(layer.inset ? { inset: true } : {}),
                }));
                return layers.length === 1 ? layers[0] : layers;
            }
            case "typography": {
                const t = value.value;
                const result: Record<string, unknown> = {};
                if (t.fontFamily) {
                    result.fontFamily = t.fontFamily;
                }
                if (t.fontSize !== undefined) {
                    result.fontSize = px(t.fontSize);
                }
                if (t.fontWeight !== undefined) {
                    result.fontWeight = t.fontWeight;
                }
                if (t.lineHeight !== undefined) {
                    result.lineHeight = t.lineHeightPx ? px(t.lineHeight) : t.lineHeight;
                }
                if (t.letterSpacing !== undefined) {
                    result.letterSpacing = px(t.letterSpacing);
                }
                if (t.fontStyle) {
                    result.fontStyle = t.fontStyle;
                }
                if (t.textCase) {
                    result.textCase = t.textCase;
                }
                if (t.textDecoration) {
                    result.textDecoration = t.textDecoration;
                }
                return result;
            }
        }
    }

    /** Puts a token at its group path; a name that is both a token and a group uses `$root`. */
    private static place(root: DtcgNode, path: string[], token: DtcgNode): void {
        let group = root;
        for (const segment of path.slice(0, -1)) {
            let next = group[segment] as DtcgNode | undefined;
            if (next === undefined || typeof next !== "object") {
                next = {};
                group[segment] = next;
            } else if ("$value" in next) {
                next = { $root: next };
                group[segment] = next;
            }
            group = next;
        }
        const last = path[path.length - 1];
        const existing = group[last] as DtcgNode | undefined;
        if (existing !== undefined && typeof existing === "object" && !("$value" in existing)) {
            existing.$root = token;
        } else {
            group[last] = token;
        }
    }

    /** Flattens a DTCG document to token name → JSON of its value. */
    private static flatten(document: unknown): Map<string, string> {
        const result = new Map<string, string>();
        const walk = (node: unknown, path: string[]) => {
            if (typeof node !== "object" || node === null || Array.isArray(node)) {
                return;
            }
            const entries = node as Record<string, unknown>;
            if ("$value" in entries) {
                result.set(path.join("."), JSON.stringify(entries.$value));
                return;
            }
            for (const [key, child] of Object.entries(entries)) {
                if (key === "$root") {
                    walk(child, path);
                } else if (!key.startsWith("$")) {
                    walk(child, [...path, key]);
                }
            }
        };
        walk(document, []);
        return result;
    }
}
