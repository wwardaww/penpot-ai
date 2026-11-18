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

/** Token left out because its name or value cannot go into code safely. */
export interface RefusedToken {
    name: string;
    /** `name`: a reserved name segment; `value`: a value that is not a plain value of its type */
    reason: "name" | "value";
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
        /** names of tokens whose value could not be resolved */
        public readonly skipped: string[],
        /** tokens refused because their name or value is not safe to write into code */
        public readonly refused: RefusedToken[]
    ) {}

    /** Name segments that would reach object prototypes in the export or the code. */
    private static readonly RESERVED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

    private static readonly TEXT_CASES = new Set(["none", "uppercase", "lowercase", "capitalize"]);
    private static readonly TEXT_DECORATIONS = new Set([
        "none",
        "underline",
        "line-through",
        "strike-through",
        "overline",
    ]);
    private static readonly MAX_NUMBER = 1_000_000;

    /**
     * Resolves the tokens of a snapshot: only active sets count, and a later active set wins for
     * the same name (Penpot's rule).
     *
     * @param snapshot - the tokens as read from Penpot
     */
    public static fromSnapshot(snapshot: PenpotTokenSnapshot): DesignTokens {
        const byName = new Map<string, DesignToken>();
        const skipped = new Set<string>();
        const refused = new Map<string, RefusedToken>();
        const activeSets = snapshot.sets.filter((set) => set.active);
        for (const set of activeSets) {
            for (const token of set.tokens) {
                if (!DesignTokens.safeName(token.name)) {
                    refused.set(token.name, { name: token.name, reason: "name" });
                    continue;
                }
                const category = Object.hasOwn(DesignTokens.CATEGORY, token.type)
                    ? DesignTokens.CATEGORY[token.type]
                    : undefined;
                const value = category === undefined ? null : DesignTokens.parse(token.type, token.resolved);
                if (value === "invalid") {
                    byName.delete(token.name);
                    skipped.delete(token.name);
                    refused.set(token.name, { name: token.name, reason: "value" });
                    continue;
                }
                if (category === undefined || value === null) {
                    skipped.add(token.name);
                    continue;
                }
                skipped.delete(token.name);
                refused.delete(token.name);
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
            [...skipped].filter((name) => !byName.has(name)).sort(),
            [...refused.values()].sort((a, b) => a.name.localeCompare(b.name))
        );
    }

    /** Tells whether a token name can become an export group path and a code name. */
    private static safeName(name: string): boolean {
        return (
            name.length > 0 &&
            name.length <= 200 &&
            !/[\u0000-\u001f\u007f\u2028\u2029]/.test(name) &&
            name.split(".").every((s) => DesignTokens.safeSegment(s))
        );
    }

    /** Name segment that is neither empty, nor a prototype key, nor a DTCG `$` key. */
    private static safeSegment(segment: string): boolean {
        return segment.length > 0 && !segment.startsWith("$") && !DesignTokens.RESERVED_SEGMENTS.has(segment);
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
        const root: DtcgNode = Object.assign(Object.create(null) as DtcgNode, {
            $description: `Design tokens of the Penpot file "${this.fileName}", resolved with its active sets.`,
            $extensions: {
                penforge: {
                    generator: DesignTokens.GENERATOR,
                    activeSets: this.activeSets,
                    activeThemes: this.activeThemes,
                },
            },
        });
        for (const token of this.tokens) {
            const node = Object.create(null) as DtcgNode;
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
     * Parses a resolved Plugin API value of a token type. Only plain values of the type pass
     * (colours as hex, `rgb()`/`hsl()` or a colour keyword; finite numbers; enum keywords; font
     * family names without quotes or punctuation), because the value is written into CSS and JS.
     *
     * @returns the typed value, `invalid` for a value that is not a plain value of its type, or
     *   null when it is missing or the type is unknown
     */
    public static parse(type: string, resolved: unknown): TokenValue | "invalid" | null {
        if (resolved === undefined || resolved === null) {
            return null;
        }
        if (!Object.hasOwn(DesignTokens.CATEGORY, type)) {
            return null;
        }
        return DesignTokens.parseValue(type, resolved) ?? "invalid";
    }

    private static parseValue(type: string, resolved: unknown): TokenValue | null {
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
            return families === null ? null : { kind: "fontFamily", value: families };
        }
        if (type === "fontWeights") {
            const weight = DesignTokens.weight(resolved);
            return weight === null ? null : { kind: "fontWeight", value: weight.value, italic: weight.italic };
        }
        if (type === "textCase" || type === "textDecoration") {
            const value = DesignTokens.keyword(type, resolved);
            return value === null ? null : { kind: "string", value };
        }
        if (type === "shadow") {
            const layers = (Array.isArray(resolved) ? resolved : [resolved]).map((layer) =>
                DesignTokens.shadowLayer(layer)
            );
            return layers.length === 0 || layers.some((layer) => layer === null)
                ? null
                : { kind: "shadow", value: layers as ShadowLayer[] };
        }
        if (type === "typography") {
            const typography = DesignTokens.typography(Array.isArray(resolved) ? resolved[0] : resolved);
            return typography === null ? null : { kind: "typography", value: typography };
        }
        return null;
    }

    /**
     * Checks a typed value read back from a file (the theme manifest) with the same rules as
     * {@link parse}, so a stored value never brings anything else into the code.
     *
     * @returns the value, or null when it is not a valid typed value
     */
    public static checkValue(raw: unknown): TokenValue | null {
        if (typeof raw !== "object" || raw === null) {
            return null;
        }
        const v = raw as Record<string, unknown>;
        switch (v.kind) {
            case "color": {
                const color = DesignTokens.color(v.value);
                return color === null ? null : { kind: "color", value: color };
            }
            case "dimension":
            case "number": {
                const value = typeof v.value === "number" ? DesignTokens.number(v.value) : null;
                return value === null ? null : { kind: v.kind, value };
            }
            case "fontFamily": {
                const families = Array.isArray(v.value) ? DesignTokens.families(v.value) : null;
                return families === null ? null : { kind: "fontFamily", value: families };
            }
            case "fontWeight": {
                const weight = typeof v.value === "number" ? DesignTokens.weight(v.value) : null;
                return weight === null ? null : { kind: "fontWeight", value: weight.value, italic: v.italic === true };
            }
            case "string": {
                const value =
                    DesignTokens.keyword("textCase", v.value) ?? DesignTokens.keyword("textDecoration", v.value);
                return value === null ? null : { kind: "string", value };
            }
            case "shadow": {
                const layers = Array.isArray(v.value) ? v.value.map((layer) => DesignTokens.shadowLayer(layer)) : [];
                return layers.length === 0 || layers.some((layer) => layer === null)
                    ? null
                    : { kind: "shadow", value: layers as ShadowLayer[] };
            }
            case "typography": {
                const t = typeof v.value === "object" && v.value !== null ? (v.value as Record<string, unknown>) : null;
                if (t === null) {
                    return null;
                }
                const typography = DesignTokens.typography({
                    fontFamilies: t.fontFamily,
                    fontSizes: t.fontSize,
                    fontWeights:
                        t.fontWeight === undefined
                            ? undefined
                            : `${t.fontWeight}${t.fontStyle === "italic" ? " italic" : ""}`,
                    lineHeight:
                        t.lineHeight === undefined
                            ? undefined
                            : t.lineHeightPx === true
                              ? `${t.lineHeight}px`
                              : t.lineHeight,
                    letterSpacing: t.letterSpacing,
                    textCase: t.textCase,
                    textDecoration: t.textDecoration,
                });
                return typography === null ? null : { kind: "typography", value: typography };
            }
            default:
                return null;
        }
    }

    /** Colour as hex, `rgb()`/`rgba()`/`hsl()`/`hsla()` with numbers only, or a colour keyword. */
    private static color(raw: unknown): string | null {
        if (typeof raw !== "string") {
            return null;
        }
        const value = raw.trim();
        if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
            return value.toLowerCase();
        }
        if (/^(?:rgba?|hsla?)\(\s*[-+0-9.%\s,/]+\)$/i.test(value) || /^[a-z]{3,30}$/i.test(value)) {
            return value.toLowerCase();
        }
        return null;
    }

    private static number(raw: unknown): number | null {
        let value: number | null = null;
        if (typeof raw === "number") {
            value = raw;
        } else if (typeof raw === "string") {
            const match = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(px)?\s*$/i.exec(raw);
            value = match ? Number(match[1]) : null;
        }
        return value !== null && Number.isFinite(value) && Math.abs(value) <= DesignTokens.MAX_NUMBER
            ? DesignTokens.round(value)
            : null;
    }

    /** Font family names; null when one holds quotes, punctuation or control characters. */
    private static families(raw: unknown): string[] | null {
        const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
        const families = list
            .map((family) =>
                String(family)
                    .trim()
                    .replace(/^["']|["']$/g, "")
                    .trim()
            )
            .filter((family) => family.length > 0);
        return families.length > 0 && families.every((family) => /^[\p{L}\p{N} ._-]{1,80}$/u.test(family))
            ? families
            : null;
    }

    /** Text case or decoration keyword. */
    private static keyword(type: "textCase" | "textDecoration", raw: unknown): string | null {
        if (typeof raw !== "string") {
            return null;
        }
        const value = raw.trim().toLowerCase();
        const allowed = type === "textCase" ? DesignTokens.TEXT_CASES : DesignTokens.TEXT_DECORATIONS;
        return allowed.has(value) ? value : null;
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
        const familySource = source.fontFamilies ?? source.fontFamily;
        if (familySource !== undefined && familySource !== null && familySource !== "") {
            const families = DesignTokens.families(familySource);
            if (families === null) {
                return null;
            }
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
            const raw = source[key];
            if (raw === undefined || raw === null || raw === "") {
                continue;
            }
            const value = DesignTokens.keyword(key, raw);
            if (value === null) {
                return null;
            }
            if (value !== "none") {
                result[key] = value;
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
        if (!path.every((segment) => DesignTokens.safeSegment(segment))) {
            return;
        }
        // groups have no prototype, so no name segment can reach `Object.prototype`
        const group = (): DtcgNode => Object.create(null) as DtcgNode;
        const own = (node: DtcgNode, key: string) => (Object.hasOwn(node, key) ? node[key] : undefined);
        let current = root;
        for (const segment of path.slice(0, -1)) {
            let next = own(current, segment) as DtcgNode | undefined;
            if (next === undefined || typeof next !== "object" || next === null) {
                next = group();
                current[segment] = next;
            } else if (Object.hasOwn(next, "$value")) {
                const wrapper = group();
                wrapper.$root = next;
                current[segment] = wrapper;
                next = wrapper;
            }
            current = next;
        }
        const last = path[path.length - 1];
        const existing = own(current, last) as DtcgNode | undefined;
        if (
            existing !== undefined &&
            typeof existing === "object" &&
            existing !== null &&
            !Object.hasOwn(existing, "$value")
        ) {
            existing.$root = token;
        } else {
            current[last] = token;
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
