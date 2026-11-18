import type { DesignToken, DesignTokens, TokenCategory } from "./DesignTokens";
import type { ManifestToken } from "./TokenManifest";

/** Token placed in the generated theme: `tokens.<category>.<key>` or `--<prefix>-<cssName>`. */
export interface ThemeEntry {
    token: DesignToken;
    category: TokenCategory;
    /** key in the JS theme object, e.g. `primary500` (may start with a digit: `2xl`) */
    key: string;
    /** name part of the CSS variable, e.g. `primary-500` */
    cssName: string;
    /** the token left Penpot but the code still uses it, so it stays with its last value */
    deprecated: boolean;
}

/**
 * Design tokens arranged for code: one group per category, with stable code-friendly names.
 *
 * Names come from the Penpot token names. A leading segment that repeats the category is dropped
 * (`color.primary` → `tokens.color.primary`, `--color-primary`), the rest becomes a camelCase key
 * and a kebab-case CSS name, accents are folded to ASCII, and clashes get a number. Names given by
 * an earlier sync (the theme manifest) are kept, and a name an earlier token had is never given to
 * another token, so references in the code never move to a different token. The order is the
 * token name order, so the output stays stable between runs.
 */
export class ThemeModel {
    /** Category order of the generated code. */
    public static readonly ORDER: TokenCategory[] = [
        "color",
        "spacing",
        "radius",
        "shadow",
        "typography",
        "fontFamily",
        "fontSize",
        "fontWeight",
        "letterSpacing",
        "size",
        "dimension",
        "borderWidth",
        "opacity",
        "number",
        "rotation",
        "textCase",
        "textDecoration",
    ];

    /** Leading name segments that only repeat the category, compared lower-case without separators. */
    private static readonly ALIASES: Record<TokenCategory, string[]> = {
        color: ["color", "colors", "colour", "colours"],
        spacing: ["spacing", "space", "spaces", "spacings"],
        radius: ["radius", "radii", "borderradius", "rounded", "corner", "corners"],
        shadow: ["shadow", "shadows", "boxshadow", "elevation"],
        typography: ["typography", "typographies", "textstyle", "textstyles"],
        fontFamily: ["font", "fonts", "fontfamily", "fontfamilies", "family"],
        fontSize: ["fontsize", "fontsizes", "size", "sizes"],
        fontWeight: ["fontweight", "fontweights", "weight", "weights"],
        letterSpacing: ["letterspacing", "tracking"],
        size: ["size", "sizes", "sizing"],
        dimension: ["dimension", "dimensions"],
        borderWidth: ["borderwidth", "borderwidths", "border", "stroke"],
        opacity: ["opacity", "opacities"],
        number: ["number", "numbers"],
        rotation: ["rotation", "rotations"],
        textCase: ["textcase", "case"],
        textDecoration: ["textdecoration", "decoration"],
    };

    private constructor(public readonly groups: Map<TokenCategory, ThemeEntry[]>) {}

    /**
     * Arranges tokens for code.
     *
     * @param tokens - the resolved tokens
     */
    public static build(
        tokens: DesignTokens,
        previous: ReadonlyMap<string, ManifestToken> = new Map(),
        kept: ThemeEntry[] = []
    ): ThemeModel {
        const groups = new Map<TokenCategory, ThemeEntry[]>();
        for (const category of ThemeModel.ORDER) {
            const members = tokens.tokens.filter((token) => token.category === category);
            const keptHere = kept.filter((entry) => entry.category === category);
            if (members.length === 0 && keptHere.length === 0) {
                continue;
            }
            // names an earlier sync gave in this category stay reserved for their token
            const earlier = [...previous.entries()].filter(([, entry]) => entry.category === category);
            const keys = new Set(earlier.map(([, entry]) => entry.key));
            const cssNames = new Set(earlier.map(([, entry]) => entry.cssName));
            const entries: ThemeEntry[] = members.map((token) => {
                const before = previous.get(token.name);
                if (before !== undefined && before.category === category) {
                    return { token, category, key: before.key, cssName: before.cssName, deprecated: false };
                }
                const words = ThemeModel.words(token.name, category);
                return {
                    token,
                    category,
                    key: ThemeModel.unique(ThemeModel.camel(words), keys),
                    cssName: ThemeModel.unique(words.join("-"), cssNames, "-"),
                    deprecated: false,
                };
            });
            entries.push(...keptHere);
            entries.sort((a, b) => a.token.name.localeCompare(b.token.name));
            groups.set(category, entries);
        }
        return new ThemeModel(groups);
    }

    /**
     * Entries of tokens an earlier sync wrote that are not in the file any more (removed, renamed,
     * unresolved or of another type now), with their last value, marked deprecated.
     *
     * @param tokens - the current tokens
     * @param previous - the manifest's tokens
     */
    public static removed(tokens: DesignTokens, previous: ReadonlyMap<string, ManifestToken>): ThemeEntry[] {
        const current = new Map(tokens.tokens.map((token) => [token.name, token.category]));
        return [...previous.entries()]
            .filter(([name, entry]) => current.get(name) !== entry.category)
            .map(([name, entry]) => ({
                token: {
                    name,
                    type: entry.type,
                    category: entry.category,
                    value: entry.value,
                    raw: undefined,
                    description: "",
                    set: "",
                },
                category: entry.category,
                key: entry.key,
                cssName: entry.cssName,
                deprecated: true,
            }));
    }

    /** All entries, in output order. */
    public get entries(): ThemeEntry[] {
        return [...this.groups.values()].flat();
    }

    /** Words of a token name for code, without a leading segment that repeats the category. */
    private static words(name: string, category: TokenCategory): string[] {
        const segments = name.split(".").filter((segment) => segment.length > 0);
        const aliases = ThemeModel.ALIASES[category];
        const first = segments[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
        const rest = segments.length > 1 && aliases.includes(first) ? segments.slice(1) : segments;
        const words = rest.flatMap((segment) =>
            segment
                .normalize("NFKD")
                .replace(/[̀-ͯ]/g, "")
                .replace(/ı/g, "i")
                .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((word) => word.length > 0)
        );
        return words.length > 0 ? words : ["token"];
    }

    private static camel(words: string[]): string {
        return words.map((word, index) => (index === 0 ? word : word[0].toUpperCase() + word.slice(1))).join("");
    }

    private static unique(name: string, taken: Set<string>, separator: string = ""): string {
        let candidate = name;
        for (let n = 2; taken.has(candidate); n++) {
            candidate = `${name}${separator}${n}`;
        }
        taken.add(candidate);
        return candidate;
    }
}
