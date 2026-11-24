import type { TokenManifestData } from "../tokens/TokenManifest";
import { ThemeBlock } from "../tokens/ThemeBlock";
import type { SourceFile } from "../tokens/SourceFiles";
import type { Finding } from "./ConformanceReport";

/** Design token with the code that names it. */
interface NamedToken {
    name: string;
    /** how code refers to it, for the fix turn */
    reference: string;
}

/**
 * Lint for hard-coded design values: colors, sizes and fonts written into the app's code although
 * a design token has that value (or, with a linked design system, although no token has that color).
 *
 * Reads the tokens from the generated theme (`.penforge/token-theme.json`, W21); the theme file
 * itself is not checked. Only values the design system names are findings, so layout numbers stay free.
 */
export class DesignValueLint {
    private static readonly SIZE_PROPS: { pattern: RegExp; categories: string[]; kind: string }[] = [
        {
            kind: "font size",
            categories: ["fontSize"],
            pattern: /\b(?:font-size|fontSize)\s*:\s*["'`]?(\d+(?:\.\d+)?)(?:px)?\b/g,
        },
        {
            kind: "radius",
            categories: ["radius"],
            pattern: /\b(?:border-radius|borderRadius)\s*:\s*["'`]?(\d+(?:\.\d+)?)(?:px)?\b/g,
        },
        {
            kind: "spacing",
            categories: ["spacing"],
            pattern:
                /\b(?:padding|margin|gap|row-gap|column-gap|rowGap|columnGap|(?:padding|margin)-?(?:top|right|bottom|left|inline|block|Top|Right|Bottom|Left|Horizontal|Vertical))\s*:\s*["'`]?(\d+(?:\.\d+)?)(?:px)?\b/g,
        },
        {
            kind: "radius",
            categories: ["radius"],
            pattern: /\brounded(?:-[a-z]+)?-\[(\d+(?:\.\d+)?)px\]/g,
        },
        {
            kind: "font size",
            categories: ["fontSize"],
            pattern: /\btext-\[(\d+(?:\.\d+)?)px\]/g,
        },
        {
            kind: "spacing",
            categories: ["spacing"],
            pattern: /\b(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y)-\[(\d+(?:\.\d+)?)px\]/g,
        },
    ];
    private static readonly COLOR =
        /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])|\brgba?\(\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*[, ]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)/g;
    private static readonly FONT = /\b(?:font-family|fontFamily)\s*:\s*["'`]?([A-Za-z][\w -]*)/g;

    private readonly colors = new Map<string, NamedToken>();
    /** `category:value` */
    private readonly sizes = new Map<string, NamedToken>();
    private readonly fonts = new Map<string, NamedToken>();

    /**
     * @param theme - the generated theme of the app
     * @param bound - whether the project uses a design system (colors outside it are findings)
     */
    constructor(
        private readonly theme: TokenManifestData,
        private readonly bound: boolean
    ) {
        for (const [name, token] of theme.tokens) {
            const reference =
                theme.format === "css" || theme.format === "tailwind"
                    ? `var(--${token.cssName})`
                    : `${theme.objectName}.${token.category}.${token.key}`;
            const named = { name, reference };
            const value = token.value;
            if (value.kind === "color") {
                const color = DesignValueLint.color(value.value);
                if (color !== null) {
                    DesignValueLint.keep(this.colors, color, named);
                }
            } else if (value.kind === "dimension" || value.kind === "number") {
                DesignValueLint.keep(this.sizes, `${token.category}:${value.value}`, named);
            } else if (value.kind === "fontFamily" && value.value.length > 0) {
                DesignValueLint.keep(this.fonts, value.value[0].toLowerCase(), named);
            } else if (value.kind === "typography") {
                if (value.value.fontSize !== undefined) {
                    DesignValueLint.keep(this.sizes, `fontSize:${value.value.fontSize}`, named);
                }
                if (value.value.fontFamily !== undefined && value.value.fontFamily.length > 0) {
                    DesignValueLint.keep(this.fonts, value.value.fontFamily[0].toLowerCase(), named);
                }
            }
        }
    }

    /**
     * Checks files.
     *
     * @param files - style and code files of the app
     * @param skip - files not checked (the generated motion file)
     */
    public check(files: readonly SourceFile[], skip: ReadonlySet<string>): Finding[] {
        const findings = new Map<string, Finding>();
        for (const file of files) {
            if (skip.has(file.file) || file.file === this.theme.file || DesignValueLint.isConfig(file.file)) {
                continue;
            }
            const text = DesignValueLint.withoutComments(DesignValueLint.withoutBlock(file.text));
            text.split("\n").forEach((line, index) => {
                for (const finding of this.line(file.file, index + 1, line)) {
                    if (!findings.has(finding.id)) {
                        findings.set(finding.id, finding);
                    }
                }
            });
        }
        return [...findings.values()];
    }

    private line(file: string, line: number, text: string): Finding[] {
        // links to anchors, theme-color metas and ids are no design values
        if (/theme-color|https?:\/\/\S+#|href\s*=\s*["'{`]+#|url\(#/.test(text)) {
            return [];
        }
        const findings: Finding[] = [];
        for (const match of text.matchAll(DesignValueLint.COLOR)) {
            const color = DesignValueLint.color(match[0]);
            if (color === null) {
                continue;
            }
            const token = this.colors.get(color);
            if (token !== undefined) {
                findings.push(this.finding("hardcoded-color", file, line, match[0], token));
            } else if (this.bound && this.colors.size > 0 && !DesignValueLint.isNeutral(color)) {
                findings.push(this.finding("off-system-color", file, line, match[0], null));
            }
        }
        for (const { pattern, categories, kind } of DesignValueLint.SIZE_PROPS) {
            for (const match of text.matchAll(pattern)) {
                const value = Number(match[1]);
                const token = categories
                    .map((category) => this.sizes.get(`${category}:${value}`))
                    .find((found) => found !== undefined);
                if (token !== undefined && value !== 0) {
                    findings.push(this.finding("hardcoded-size", file, line, `${kind} ${match[1]}px`, token));
                }
            }
        }
        for (const match of text.matchAll(DesignValueLint.FONT)) {
            const token = this.fonts.get(match[1].trim().toLowerCase());
            if (token !== undefined) {
                findings.push(this.finding("hardcoded-font", file, line, match[1].trim(), token));
            }
        }
        return findings;
    }

    private finding(
        code: "hardcoded-color" | "off-system-color" | "hardcoded-size" | "hardcoded-font",
        file: string,
        line: number,
        value: string,
        token: NamedToken | null
    ): Finding {
        return {
            id: `${code}:${file}:${value.toLowerCase().replace(/\s+/g, "")}`,
            code,
            check: "values",
            boardId: null,
            screen: null,
            file,
            line,
            params: { value, file, line, ...(token ? { token: token.name } : {}) },
            text: token
                ? `${file}:${line} repeats ${value}; use the design token ${token.name} (\`${token.reference}\`)`
                : `${file}:${line} uses the color ${value}, which the design system does not have; use a token of the theme`,
        };
    }

    /** First token of a value wins: theme order is the design's order. */
    private static keep(map: Map<string, NamedToken>, key: string, token: NamedToken): void {
        if (!map.has(key)) {
            map.set(key, token);
        }
    }

    /** `#rrggbb` or `#rrggbbaa` of a CSS color, lower case; null for anything else. */
    public static color(value: string): string | null {
        const text = value.trim().toLowerCase();
        const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
        if (hex !== undefined) {
            const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
            if (full.length !== 6 && full.length !== 8) {
                return null;
            }
            return `#${full.length === 8 && full.endsWith("ff") ? full.slice(0, 6) : full}`;
        }
        const parts = /^rgba?\(([^)]*)\)$/
            .exec(text)?.[1]
            .split(/[\s,/]+/)
            .filter((part) => part.length > 0);
        if (
            parts === undefined ||
            parts.length < 3 ||
            parts.some((part) => part.endsWith("%") && parts.indexOf(part) < 3)
        ) {
            return null;
        }
        const channel = (part: string) =>
            Math.max(0, Math.min(255, Math.round(Number(part))))
                .toString(16)
                .padStart(2, "0");
        const alpha =
            parts[3] === undefined
                ? 1
                : parts[3].endsWith("%")
                  ? Number(parts[3].slice(0, -1)) / 100
                  : Number(parts[3]);
        if ([...parts.slice(0, 3).map(Number), alpha].some((number) => Number.isNaN(number))) {
            return null;
        }
        const suffix = alpha >= 1 ? "" : channel(String(alpha * 255));
        return `#${parts.slice(0, 3).map(channel).join("")}${suffix}`;
    }

    /** Black, white and translucent colors: shadows, scrims and text on photos. */
    private static isNeutral(color: string): boolean {
        return color === "#000000" || color === "#ffffff" || color.length === 9;
    }

    private static isConfig(file: string): boolean {
        return /(^|\/)(?:[\w.-]+\.config\.(?:ts|js|mjs|cjs)|[\w.-]+\.d\.ts)$/.test(file);
    }

    private static withoutBlock(text: string): string {
        try {
            return ThemeBlock.has(text) ? ThemeBlock.strip(text) : text;
        } catch {
            return text;
        }
    }

    /** Text with comments blanked out, lines kept. */
    private static withoutComments(text: string): string {
        return text
            .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
            .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "))
            .replace(/(^|[\s;{}(,])\/\/[^\n]*/g, "$1");
    }
}
