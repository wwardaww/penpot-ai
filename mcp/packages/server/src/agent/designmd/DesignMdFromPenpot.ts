import { CssColor, CssValues } from "./CssValues";
import { DesignMdReferences } from "./DesignMdReferences";
import type {
    DesignMdComponent,
    DesignMdDocument,
    DesignMdSection,
    DesignMdTokens,
    DesignMdTypography,
} from "./DesignMdTypes";
import { emptyDesignMdTokens } from "./DesignMdTypes";
import { DesignMdValidator } from "./DesignMdValidator";
import { PenpotImportPlanner } from "./PenpotImportPlan";
import type {
    PenpotSnapshot,
    SnapshotComponent,
    SnapshotFill,
    SnapshotText,
    SnapshotToken,
    SnapshotTypography,
} from "./PenpotScripts";

/**
 * Builder of a DESIGN.md from the design system of a Penpot file (the export direction).
 *
 * Front matter values come from the file: DESIGN.md tokens (token set `DESIGN.md`, else the
 * active sets), library colors and typographies, and the main instances of components. The
 * previous DESIGN.md supplies everything Penpot cannot hold (name, description, prose,
 * `fontFeature`, unknown keys, component specs not built yet), and its spelling of every value the
 * file did not change (`1rem` stays `1rem`), so importing then exporting gives the same text.
 */
export class DesignMdFromPenpot {
    /** components exported when no previous DESIGN.md says which ones matter */
    public static readonly MAX_NEW_COMPONENTS = 50;

    private static readonly EPSILON = 0.01;

    private readonly previous: DesignMdTokens;
    private readonly tokens: DesignMdTokens;
    private readonly colorByLibraryId = new Map<string, string>();
    private readonly notInFile: string[] = [];

    private constructor(
        private readonly snapshot: PenpotSnapshot,
        private readonly previousDocument: DesignMdDocument | null,
        private readonly prune: boolean
    ) {
        this.previous = previousDocument?.tokens ?? emptyDesignMdTokens();
        this.tokens = emptyDesignMdTokens();
    }

    /**
     * Builds the document.
     *
     * @param snapshot - the file's design system
     * @param previous - the current DESIGN.md, if any
     */
    public static build(snapshot: PenpotSnapshot, previous: DesignMdDocument | null): DesignMdDocument {
        return DesignMdFromPenpot.merge(snapshot, previous).document;
    }

    /**
     * Builds the document and reports the values of the previous DESIGN.md that the file does not
     * have (colors, text styles, radius and spacing without a matching token or library entry,
     * component specs without a component).
     *
     * @param snapshot - the file's design system
     * @param previous - the current DESIGN.md, if any
     * @param prune - drop those values instead of keeping them
     * @returns the document and the dotted paths of those values (`colors.brand`)
     */
    public static merge(
        snapshot: PenpotSnapshot,
        previous: DesignMdDocument | null,
        prune: boolean = false
    ): { document: DesignMdDocument; notInFile: string[] } {
        const builder = new DesignMdFromPenpot(snapshot, previous, prune);
        const document = builder.run();
        return { document, notInFile: builder.notInFile };
    }

    /**
     * Turns a Penpot element name (with its group path) into a DESIGN.md token key.
     */
    public static slug(path: string, name: string): string {
        const full = path ? `${path} ${name}` : name;
        return (
            full
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || "token"
        );
    }

    private run(): DesignMdDocument {
        const previous = this.previous;
        this.tokens.version = previous.version ?? "alpha";
        this.tokens.name = previous.name ?? (this.snapshot.fileName || undefined);
        if (previous.description !== undefined) {
            this.tokens.description = previous.description;
        }
        if (previous.omitted !== undefined) {
            this.tokens.omitted = previous.omitted;
        }
        const designTokens = this.designTokens();
        this.exportColors(designTokens);
        this.exportTypography();
        this.exportDimensions("rounded", designTokens);
        this.exportDimensions("spacing", designTokens);
        this.exportComponents();
        this.tokens.extra = { ...previous.extra };
        return {
            tokens: this.tokens,
            preamble: this.previousDocument?.preamble ?? "",
            sections: this.previousDocument ? this.previousDocument.sections.map((s) => ({ ...s })) : this.skeleton(),
        };
    }

    /** Tokens of the `DESIGN.md` set, else of every active set (later sets win). */
    private designTokens(): Map<string, SnapshotToken> {
        const own = this.snapshot.tokenSets.find((set) => set.name === PenpotImportPlanner.TOKEN_SET);
        const sets = own ? [own] : this.snapshot.tokenSets.filter((set) => set.active);
        const tokens = new Map<string, SnapshotToken>();
        for (const set of sets) {
            for (const token of set.tokens) {
                tokens.set(token.name, token);
            }
        }
        return tokens;
    }

    private exportColors(designTokens: Map<string, SnapshotToken>): void {
        const prefix = `${PenpotImportPlanner.TOKEN_PREFIX.colors}.`;
        const found: Record<string, string> = {};
        for (const token of designTokens.values()) {
            if (token.type === "color" && token.name.startsWith(prefix) && typeof token.value === "string") {
                found[token.name.slice(prefix.length)] = this.aliasOrLiteral(token.value, "colors");
            }
        }
        for (const color of this.snapshot.colors) {
            if (color.color === null) {
                continue;
            }
            const key = color.path ? DesignMdFromPenpot.slug(color.path, color.name) : color.name;
            this.colorByLibraryId.set(color.id, key);
            if (!(key in found)) {
                found[key] = CssColor.format({ hex: color.color, opacity: color.opacity });
            }
        }
        this.tokens.colors = this.ordered("colors", found, this.previous.colors, (name, value, old) =>
            this.sameColor(value, old, found) ? old : value
        );
    }

    private exportTypography(): void {
        const found: Record<string, DesignMdTypography> = {};
        for (const typography of this.snapshot.typographies) {
            const key = typography.path ? DesignMdFromPenpot.slug(typography.path, typography.name) : typography.name;
            found[key] = this.typography(typography, this.previous.typography[key]);
        }
        this.tokens.typography = this.ordered("typography", found, this.previous.typography, (_name, value) => value);
    }

    private typography(source: SnapshotTypography, previous: DesignMdTypography | undefined): DesignMdTypography {
        const old = previous ?? {};
        const fontSizePx = Number(source.fontSize) || 14;
        const weight = Number(source.fontWeight) || 400;
        const lineHeight = Number(source.lineHeight) || 1.2;
        const letterSpacing = Number(source.letterSpacing) || 0;
        const oldSizePx = CssValues.toPx(old.fontSize);
        const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < DesignMdFromPenpot.EPSILON;
        const result: DesignMdTypography = {};
        result.fontFamily =
            typeof old.fontFamily === "string" && old.fontFamily.toLowerCase() === source.fontFamily.toLowerCase()
                ? old.fontFamily
                : source.fontFamily;
        result.fontSize = near(oldSizePx, fontSizePx) ? old.fontSize : CssValues.formatPx(fontSizePx);
        result.fontWeight = near(CssValues.parseNumber(old.fontWeight), weight) ? old.fontWeight : weight;
        result.lineHeight = near(CssValues.lineHeightMultiplier(old.lineHeight, fontSizePx), lineHeight)
            ? old.lineHeight
            : CssValues.round(lineHeight);
        if (old.letterSpacing !== undefined && near(CssValues.toPx(old.letterSpacing, fontSizePx), letterSpacing)) {
            result.letterSpacing = old.letterSpacing;
        } else if (Math.abs(letterSpacing) >= DesignMdFromPenpot.EPSILON) {
            result.letterSpacing = CssValues.formatPx(letterSpacing);
        }
        for (const [property, value] of Object.entries(old)) {
            if (!(property in result) && property !== "letterSpacing") {
                result[property] = value;
            }
        }
        return result;
    }

    private exportDimensions(group: "rounded" | "spacing", designTokens: Map<string, SnapshotToken>): void {
        const prefix = `${PenpotImportPlanner.TOKEN_PREFIX[group]}.`;
        const types = group === "rounded" ? ["borderRadius"] : ["spacing", "dimension", "sizing", "number"];
        const found: Record<string, string | number> = {};
        for (const token of designTokens.values()) {
            if (!types.includes(token.type) || !token.name.startsWith(prefix)) {
                continue;
            }
            const raw = typeof token.value === "number" ? String(token.value) : token.value;
            if (typeof raw !== "string") {
                continue;
            }
            const name = token.name.slice(prefix.length);
            const alias = this.alias(raw, group);
            if (alias !== null) {
                found[name] = alias;
            } else if (token.type === "number") {
                found[name] = CssValues.parseNumber(raw) ?? raw;
            } else {
                const px = CssValues.toPx(raw);
                found[name] = px === null ? raw : CssValues.formatPx(px);
            }
        }
        const current = this.tokens[group];
        Object.assign(
            current,
            this.ordered(group, found, this.previous[group], (_name, value, old) => {
                if (DesignMdReferences.parse(value) !== null || DesignMdReferences.parse(old) !== null) {
                    return value === old ? old : value;
                }
                const a = CssValues.toPx(value);
                const b = CssValues.toPx(old);
                return a !== null && b !== null && Math.abs(a - b) < DesignMdFromPenpot.EPSILON ? old : value;
            })
        );
    }

    private exportComponents(): void {
        const previous = this.previous.components;
        const live = this.snapshot.components;
        const tagged = live.filter((component) => component.key.length > 0);
        const byKey = new Map<string, SnapshotComponent>();
        for (const component of tagged) {
            byKey.set(component.key, component);
        }
        for (const component of live) {
            const key = DesignMdFromPenpot.slug(component.path, component.name);
            if (!byKey.has(key) && (key in previous || component.name in previous)) {
                byKey.set(component.name in previous ? component.name : key, component);
            }
        }
        if (Object.keys(previous).length === 0 && tagged.length === 0) {
            for (const component of live.slice(0, DesignMdFromPenpot.MAX_NEW_COMPONENTS)) {
                byKey.set(DesignMdFromPenpot.slug(component.path, component.name), component);
            }
        }
        const found: Record<string, DesignMdComponent> = {};
        for (const [key, component] of byKey) {
            found[key] = this.component(component, previous[key]);
        }
        // specs not built yet stay, unless pruned
        this.tokens.components = this.ordered("components", found, previous, (_name, value) => value);
    }

    private component(source: SnapshotComponent, previous: DesignMdComponent | undefined): DesignMdComponent {
        const old = previous ?? {};
        const main = source.main;
        if (main === null) {
            return { ...old };
        }
        const derived: DesignMdComponent = {};
        const background = this.colorValue(main.fill, main.tokens.fill);
        if (background !== null) {
            derived.backgroundColor = background;
        }
        if (main.text !== null) {
            const textColor = this.colorValue(main.text.fill, main.text.tokens.fill);
            if (textColor !== null) {
                derived.textColor = textColor;
            }
            const typography = this.typographyReference(main.text);
            if (typography !== null) {
                derived.typography = typography;
            }
        }
        const radiusToken = main.tokens.borderRadiusTopLeft;
        const rounded = this.dimensionValue(main.radius, radiusToken, "rounded");
        if (main.radius > 0 || radiusToken) {
            derived.rounded = rounded;
        }
        if (main.padding !== null && main.padding.some((value) => value > 0)) {
            derived.padding = this.paddingValue(main.padding, main.tokens);
        }
        derived.height = CssValues.formatPx(main.height);
        derived.width = CssValues.formatPx(main.width);

        // A known spec keeps its property list (values follow the file); a new one gets the usual set.
        const result: DesignMdComponent = {};
        const keys = previous
            ? Object.keys(old)
            : ["backgroundColor", "textColor", "typography", "rounded", "padding", "height"];
        for (const key of keys) {
            const value = derived[key];
            const before = old[key];
            if (value === undefined) {
                if (before !== undefined) {
                    result[key] = before;
                }
                continue;
            }
            result[key] = before !== undefined && this.sameComponentValue(key, value, before) ? before : value;
        }
        return result;
    }

    private colorValue(fill: SnapshotFill | null, tokenName: string | undefined): string | null {
        const prefix = `${PenpotImportPlanner.TOKEN_PREFIX.colors}.`;
        if (tokenName && tokenName.startsWith(prefix) && tokenName.slice(prefix.length) in this.tokens.colors) {
            return DesignMdReferences.format("colors", tokenName.slice(prefix.length));
        }
        if (fill === null) {
            return null;
        }
        const libraryKey = fill.refId ? this.colorByLibraryId.get(fill.refId) : undefined;
        if (libraryKey !== undefined && libraryKey in this.tokens.colors) {
            return DesignMdReferences.format("colors", libraryKey);
        }
        return CssColor.format({ hex: fill.color, opacity: fill.opacity });
    }

    private typographyReference(text: SnapshotText): string | null {
        for (const typography of this.snapshot.typographies) {
            const same =
                typography.fontFamily.toLowerCase() === text.fontFamily.toLowerCase() &&
                Number(typography.fontSize) === Number(text.fontSize) &&
                String(typography.fontWeight) === String(text.fontWeight) &&
                Math.abs(Number(typography.lineHeight) - Number(text.lineHeight)) < DesignMdFromPenpot.EPSILON &&
                Math.abs(Number(typography.letterSpacing || 0) - Number(text.letterSpacing || 0)) <
                    DesignMdFromPenpot.EPSILON;
            if (same) {
                const key = typography.path
                    ? DesignMdFromPenpot.slug(typography.path, typography.name)
                    : typography.name;
                return DesignMdReferences.format("typography", key);
            }
        }
        return null;
    }

    private dimensionValue(px: number, tokenName: string | undefined, group: "rounded" | "spacing"): string {
        const prefix = `${PenpotImportPlanner.TOKEN_PREFIX[group]}.`;
        if (tokenName && tokenName.startsWith(prefix) && tokenName.slice(prefix.length) in this.tokens[group]) {
            return DesignMdReferences.format(group, tokenName.slice(prefix.length));
        }
        return CssValues.formatPx(px);
    }

    private paddingValue(padding: number[], tokens: Record<string, string>): string {
        const [top, right, bottom, left] = padding;
        const tokenNames = [tokens.paddingTop, tokens.paddingRight, tokens.paddingBottom, tokens.paddingLeft];
        if (tokenNames.every((name) => name !== undefined && name === tokenNames[0])) {
            return this.dimensionValue(top, tokenNames[0], "spacing");
        }
        const px = (value: number) => CssValues.formatPx(value);
        if (top === right && right === bottom && bottom === left) {
            return px(top);
        }
        if (top === bottom && right === left) {
            return `${px(top)} ${px(right)}`;
        }
        return `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`;
    }

    private sameComponentValue(key: string, value: string | number, before: string | number): boolean {
        if (value === before) {
            return true;
        }
        const references = new DesignMdReferences(this.tokens);
        const a = references.resolve(value);
        const b = references.resolve(before);
        if (!a.ok || !b.ok) {
            return false;
        }
        if (key === "backgroundColor" || key === "textColor") {
            return typeof a.value === "string" && typeof b.value === "string" && CssColor.equivalent(a.value, b.value);
        }
        if (key === "typography") {
            return JSON.stringify(a.value) === JSON.stringify(b.value);
        }
        const left = String(a.value)
            .trim()
            .split(/\s+/)
            .map((part) => CssValues.toPx(part));
        const right = String(b.value)
            .trim()
            .split(/\s+/)
            .map((part) => CssValues.toPx(part));
        return DesignMdFromPenpot.sameBox(left, right);
    }

    /** Compares CSS box shorthands (1 to 4 values) by their expanded form. */
    private static sameBox(left: (number | null)[], right: (number | null)[]): boolean {
        const expand = (values: (number | null)[]) => {
            const [t, r = t, b = t, l = r] = values;
            return [t, r, b, l];
        };
        const a = expand(left);
        const b = expand(right);
        return a.every((value, index) => value !== null && b[index] !== null && Math.abs(value - b[index]!) < 0.01);
    }

    private sameColor(value: string, old: string, colors: Record<string, string>): boolean {
        if (value === old) {
            return true;
        }
        const references = new DesignMdReferences({ ...this.tokens, colors });
        if (DesignMdReferences.parse(value) !== null || DesignMdReferences.parse(old) !== null) {
            return false;
        }
        const a = references.resolve(value, "colors");
        return a.ok && typeof a.value === "string" && CssColor.equivalent(a.value, old);
    }

    private aliasOrLiteral(value: string, group: "colors"): string {
        return this.alias(value, group) ?? value;
    }

    /** Turns a Penpot alias (`{color.primary}`) into a DESIGN.md reference, or null. */
    private alias(value: string, group: "colors" | "rounded" | "spacing"): string | null {
        const match = /^\{([^{}]+)\}$/.exec(value.trim());
        const prefix = `${PenpotImportPlanner.TOKEN_PREFIX[group]}.`;
        if (!match || !match[1].startsWith(prefix)) {
            return null;
        }
        return DesignMdReferences.format(group, match[1].slice(prefix.length));
    }

    /**
     * Orders found values: keys of the previous document first (in its order), then new keys in
     * file order; `pick` chooses between a found value and the previous one. Previous keys the
     * file lacks are kept (copied) and listed in {@link notInFile}, or dropped when pruning.
     */
    private ordered<T>(
        group: string,
        found: Record<string, T>,
        previous: Record<string, T>,
        pick: (name: string, value: T, old: T) => T
    ): Record<string, T> {
        const result: Record<string, T> = {};
        for (const [name, old] of Object.entries(previous)) {
            if (name in found) {
                result[name] = pick(name, found[name], old);
            } else {
                this.notInFile.push(`${group}.${name}`);
                if (!this.prune) {
                    result[name] = typeof old === "object" && old !== null ? ({ ...old } as T) : old;
                }
            }
        }
        for (const [name, value] of Object.entries(found)) {
            if (!(name in result)) {
                result[name] = value;
            }
        }
        return result;
    }

    /** Sections of a DESIGN.md written for the first time. */
    private skeleton(): DesignMdSection[] {
        const headings = ["Overview", "Colors", "Typography", "Layout", "Shapes", "Components", "Do's and Don'ts"];
        return headings
            .filter((heading) => DesignMdValidator.sectionIndex(heading) >= 0)
            .map((heading) => ({ heading, body: "" }));
    }
}
