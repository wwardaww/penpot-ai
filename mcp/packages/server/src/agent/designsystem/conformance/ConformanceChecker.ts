import { ColorMath } from "../extract/ColorMath";
import {
    OP_ORDER,
    type CheckReport,
    type Finding,
    type Fix,
    type FixOp,
    type MissingItem,
    type RawLayer,
    type RawPaint,
    type SystemCatalog,
    type SystemComponent,
    type SystemTypography,
} from "./types";

/** How strict the check is. */
export interface CheckOptions {
    /**
     * `check`: fix values close to the system and report the rest (after AI writes);
     * `redesign`: map every value to the nearest system value (switching design systems).
     */
    mode: "check" | "redesign";
    /** id of the open file (its own components are "the project's") */
    fileId: string;
    /** local components the user chose to keep ("Don't add") */
    keptComponentIds?: ReadonlySet<string>;
    /** ISO date of new missing items */
    now?: string;
}

/** Color the system offers: a library color, a color token, or both with the same value. */
interface ColorCandidate {
    hex: string;
    colorId: string | null;
    token: string | null;
    label: string;
}

/** Dimension token (radius or spacing). */
interface DimensionToken {
    name: string;
    value: number;
}

/** Spacing properties as tokens name them, with the words used in explanations. */
const SPACING_WORDS: Record<string, string> = {
    rowGap: "gap",
    columnGap: "gap",
    paddingTop: "padding",
    paddingRight: "padding",
    paddingBottom: "padding",
    paddingLeft: "padding",
};

/** Layer names too generic to stand for a component. */
const GENERIC_NAMES = new Set(["board", "group", "rectangle", "container", "frame", "layer", "path", "ellipse"]);

/**
 * Pure conformance check of the layers of a file against its linked design system (W30).
 *
 * Plans fixes for values that are close to a system value (colors by perceived distance, text
 * styles by font and size, radius and spacing by tokens, components by name) and explains each
 * fix in plain words; values far from the system are reported as findings, and the project's own
 * components that the system lacks become missing items. In `redesign` mode every value maps to
 * the nearest system value instead.
 */
export class ConformanceChecker {
    /** Lab distance up to which a raw color is taken for a system color after an AI write. */
    public static readonly COLOR_NEAR = 12;
    /** px difference up to which a radius or spacing is taken for a token. */
    public static readonly DIMENSION_NEAR = 4;
    /** Explained fixes kept in a report text. */
    public static readonly MAX_EXPLAINED = 12;

    private readonly colors: ColorCandidate[];
    private readonly radius: DimensionToken[];
    private readonly spacing: DimensionToken[];
    private readonly shadowTokens: number;
    private readonly componentsByName = new Map<string, SystemComponent>();
    private readonly tokenNames: Set<string>;

    constructor(
        private readonly catalog: SystemCatalog,
        private readonly options: CheckOptions
    ) {
        this.colors = ConformanceChecker.colorCandidates(catalog);
        this.radius = ConformanceChecker.dimensions(catalog, ["borderRadius"]);
        this.spacing = ConformanceChecker.dimensions(catalog, ["spacing", "dimension"]);
        this.shadowTokens = catalog.tokens.filter((token) => token.type === "shadow").length;
        this.tokenNames = new Set(catalog.tokens.map((token) => token.name));
        for (const component of catalog.components) {
            for (const key of [
                ConformanceChecker.normalize(component.name),
                ConformanceChecker.normalize(component.path),
            ]) {
                if (key.length > 0 && !this.componentsByName.has(key)) {
                    this.componentsByName.set(key, component);
                }
            }
        }
    }

    /**
     * Checks the scanned layers.
     *
     * @param layers - layers of the scan script
     * @param truncated - the scan stopped at its limit
     */
    public check(layers: RawLayer[], truncated = false): CheckReport {
        const byId = new Map(layers.map((layer) => [layer.id, layer]));
        const kept = this.options.keptComponentIds ?? new Set<string>();
        const replaced = new Set<string>();
        const fixes: Fix[] = [];
        const findings: Finding[] = [];
        const missing = new Map<string, MissingItem>();

        // components first: a replaced layer takes its children along
        for (const layer of layers) {
            if (ConformanceChecker.hasAncestorIn(layer, byId, replaced)) {
                continue;
            }
            const outcome = this.checkComponent(layer, kept, missing);
            if (outcome.fix) {
                fixes.push(outcome.fix);
                if (outcome.fix.ops.some((op) => op.op === "replace")) {
                    replaced.add(layer.id);
                }
            }
            if (outcome.finding) {
                findings.push(outcome.finding);
            }
        }

        for (const layer of layers) {
            if (
                layer.insideCopy ||
                replaced.has(layer.id) ||
                ConformanceChecker.hasAncestorIn(layer, byId, replaced) ||
                layer.insideMains.some((id) => kept.has(id)) ||
                (layer.component?.main === true && kept.has(layer.component.id))
            ) {
                continue;
            }
            this.checkPaints(layer, "fill", layer.fills, fixes, findings);
            this.checkPaints(layer, "stroke", layer.strokes, fixes, findings);
            this.checkText(layer, fixes, findings);
            this.checkRadius(layer, fixes, findings);
            this.checkSpacing(layer, fixes, findings);
            this.checkShadows(layer, findings);
        }
        return { fixes, findings, missing: [...missing.values()], scanned: layers.length, truncated };
    }

    /** Fix ops of a report in the order the fix script must run them. */
    public static ops(fixes: Fix[]): FixOp[] {
        return fixes.flatMap((fix) => fix.ops).sort((a, b) => OP_ORDER[a.op] - OP_ORDER[b.op]);
    }

    /**
     * One summary of what was fixed, in plain words: the explained fixes (at most
     * {@link MAX_EXPLAINED}), how many values were only linked, and what is left.
     */
    public static summary(report: Pick<CheckReport, "fixes" | "findings">): string {
        const explained = report.fixes.filter((fix) => !fix.quiet);
        const linked = report.fixes.length - explained.length;
        const lines: string[] = [];
        if (explained.length > 0) {
            lines.push("I matched the design to the design system:");
            for (const fix of explained.slice(0, ConformanceChecker.MAX_EXPLAINED)) {
                lines.push(`- ${fix.text}`);
            }
            if (explained.length > ConformanceChecker.MAX_EXPLAINED) {
                lines.push(`- …and ${explained.length - ConformanceChecker.MAX_EXPLAINED} more changes like these.`);
            }
        }
        if (linked > 0) {
            lines.push(`${linked} value${linked === 1 ? "" : "s"} already matched and now use the system's styles.`);
        }
        if (report.findings.length > 0) {
            lines.push(
                `${report.findings.length} thing${report.findings.length === 1 ? "" : "s"} still differ from the system:`
            );
            for (const finding of report.findings.slice(0, ConformanceChecker.MAX_EXPLAINED)) {
                lines.push(`- ${finding.text}`);
            }
        }
        return lines.length > 0 ? lines.join("\n") : "The design follows the design system.";
    }

    /** Lowercase name without path, punctuation runs or extra spaces (`Buttons / Primary` → `primary`). */
    public static normalize(name: string): string {
        const last =
            String(name ?? "")
                .split("/")
                .pop() ?? "";
        return last
            .toLowerCase()
            .replace(/[_\-.]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    /** Missing item id of a name: `<kind>:<normalized name>`. */
    public static missingId(kind: string, name: string): string {
        return `${kind}:${ConformanceChecker.normalize(name).replace(/ /g, "-") || "item"}`;
    }

    // --- components

    private checkComponent(
        layer: RawLayer,
        kept: ReadonlySet<string>,
        missing: Map<string, MissingItem>
    ): { fix?: Fix; finding?: Finding } {
        const link = layer.component;
        const libraryId = this.catalog.libraryId;
        if (layer.insideCopy && !(link?.copy && !link.main)) {
            return {};
        }
        if (link && (link.copy || link.main)) {
            if (link.libraryId === libraryId || kept.has(link.id)) {
                return {};
            }
            const twin = this.twinOf(link.name) ?? this.twinOf(link.path);
            const own = link.libraryId === null || link.libraryId === this.options.fileId;
            if (twin) {
                if (link.main && !link.copy) {
                    if (layer.topLevel) {
                        return {};
                    }
                    return {
                        fix: this.fix(
                            layer,
                            "component",
                            { name: twin.name },
                            `"${layer.name}" was the project's own "${link.name}"; the system has the component ` +
                                `"${twin.name}", so I used it.`,
                            [{ op: "replace", layerId: layer.id, componentId: twin.id }]
                        ),
                    };
                }
                return {
                    fix: this.fix(
                        layer,
                        "swap",
                        { name: twin.name, from: link.name },
                        own
                            ? `"${layer.name}" used the project's own "${link.name}"; the system has "${twin.name}", so I used that.`
                            : `"${layer.name}" used "${link.name}" from another library; the system has "${twin.name}", so I used that.`,
                        [{ op: "swap", layerId: layer.id, componentId: twin.id }]
                    ),
                };
            }
            if (own && this.options.mode === "check") {
                const id = ConformanceChecker.missingId("component", link.name);
                const item = missing.get(id) ?? {
                    id,
                    kind: "component" as const,
                    name: link.name,
                    reason: `The design system has no "${link.name}" component, so the project's own one is used.`,
                    componentId: link.id,
                    layerIds: [],
                    status: "open" as const,
                    source: "check" as const,
                    reportedAt: this.options.now ?? new Date().toISOString(),
                };
                item.layerIds = [...(item.layerIds ?? []), layer.id].slice(0, 50);
                missing.set(id, item);
                return {};
            }
            if (link.copy || !layer.topLevel) {
                return {
                    finding: this.finding(
                        layer,
                        own ? "local-component" : "foreign-component",
                        { name: link.name },
                        `"${layer.name}" uses "${link.name}", which the design system does not have.`
                    ),
                };
            }
            return {};
        }
        // a layer drawn by hand that has the name of a system component
        if (
            !layer.topLevel &&
            !layer.insideCopy &&
            layer.childCount > 0 &&
            (layer.type === "board" || layer.type === "group")
        ) {
            const key = ConformanceChecker.normalize(layer.name);
            const twin = key.length >= 3 && !GENERIC_NAMES.has(key) ? this.componentsByName.get(key) : undefined;
            if (twin) {
                return {
                    fix: this.fix(
                        layer,
                        "component",
                        { name: twin.name },
                        `"${layer.name}" was drawn by hand; the system has the component "${twin.name}", so I used it.`,
                        [{ op: "replace", layerId: layer.id, componentId: twin.id }]
                    ),
                };
            }
        }
        return {};
    }

    private twinOf(name: string): SystemComponent | undefined {
        const key = ConformanceChecker.normalize(name);
        return key.length > 0 ? this.componentsByName.get(key) : undefined;
    }

    // --- colors

    private checkPaints(
        layer: RawLayer,
        kind: "fill" | "stroke",
        paints: RawPaint[],
        fixes: Fix[],
        findings: Finding[]
    ): void {
        const tokenProperty = kind === "fill" ? "fill" : "strokeColor";
        const bound = layer.tokens[tokenProperty];
        if (bound && this.tokenNames.has(bound)) {
            return;
        }
        for (const paint of paints) {
            if (paint.opacity === 0 || paint.refFile === this.catalog.libraryId) {
                continue;
            }
            const hex = ColorMath.normalize(paint.hex);
            if (!hex || this.colors.length === 0) {
                continue;
            }
            const best = this.nearestColor(hex);
            if (!best) {
                continue;
            }
            const op: FixOp = {
                op: kind,
                layerId: layer.id,
                index: paint.index,
                colorId: best.candidate.colorId,
                token: best.candidate.token,
                hex: best.candidate.hex,
            };
            const what = kind === "fill" ? "" : " border";
            if (best.distance < 0.5) {
                fixes.push(
                    this.fix(
                        layer,
                        "color-linked",
                        { name: best.candidate.label, to: best.candidate.hex },
                        `"${layer.name}"${what} now uses ${best.candidate.label}.`,
                        [op],
                        true
                    )
                );
            } else if (this.options.mode === "redesign" || best.distance <= ConformanceChecker.COLOR_NEAR) {
                fixes.push(
                    this.fix(
                        layer,
                        "color",
                        { from: hex, to: best.candidate.hex, name: best.candidate.label },
                        `"${layer.name}"${what} used ${hex}; the system has ${best.candidate.label} ${best.candidate.hex}, ` +
                            "so I used that.",
                        [op]
                    )
                );
            } else {
                findings.push(
                    this.finding(
                        layer,
                        "off-color",
                        { from: hex, to: best.candidate.hex, name: best.candidate.label },
                        `"${layer.name}"${what} uses ${hex}, which is far from every system color ` +
                            `(closest: ${best.candidate.label} ${best.candidate.hex}).`
                    )
                );
            }
        }
    }

    private nearestColor(hex: string): { candidate: ColorCandidate; distance: number } | null {
        let best: { candidate: ColorCandidate; distance: number } | null = null;
        for (const candidate of this.colors) {
            const distance = candidate.hex === hex ? 0 : ColorMath.distance(hex, candidate.hex);
            if (!best || distance < best.distance) {
                best = { candidate, distance };
            }
        }
        return best;
    }

    // --- text

    private checkText(layer: RawLayer, fixes: Fix[], findings: Finding[]): void {
        const text = layer.text;
        const typographies = this.catalog.typographies;
        if (!text || text.fontSize === null || typographies.length === 0 || layer.tokens.typography) {
            return;
        }
        const family = text.fontFamily.toLowerCase();
        const exact = typographies.find(
            (t) =>
                t.fontFamily.toLowerCase() === family &&
                t.fontSize === text.fontSize &&
                String(t.fontWeight) === String(text.fontWeight)
        );
        if (exact) {
            return;
        }
        const size = text.fontSize;
        let best: { typography: SystemTypography; score: number } | null = null;
        for (const typography of typographies) {
            const score =
                Math.abs(typography.fontSize - size) +
                (String(typography.fontWeight) === String(text.fontWeight) ? 0 : 1.5) +
                (typography.fontFamily.toLowerCase() === family ? 0 : 0.5);
            if (!best || score < best.score) {
                best = { typography, score };
            }
        }
        if (!best) {
            return;
        }
        const t = best.typography;
        const from = `${text.fontFamily} ${size} / ${text.fontWeight}`;
        const to = `${t.fontFamily} ${t.fontSize} / ${t.fontWeight}`;
        const near = Math.abs(t.fontSize - size) <= Math.max(2, size * 0.2);
        if (this.options.mode === "redesign" || near) {
            fixes.push(
                this.fix(
                    layer,
                    "typography",
                    { from, to, name: t.name },
                    `"${layer.name}" used ${from}; the system's text style "${t.name}" is ${to}, so I used that.`,
                    [{ op: "typography", layerId: layer.id, typographyId: t.id }]
                )
            );
        } else {
            findings.push(
                this.finding(
                    layer,
                    "off-typography",
                    { from, to, name: t.name },
                    `"${layer.name}" uses ${from}, which no system text style is close to (closest: "${t.name}").`
                )
            );
        }
    }

    // --- radius, spacing, shadows

    private checkRadius(layer: RawLayer, fixes: Fix[], findings: Finding[]): void {
        if (
            layer.radius === null ||
            layer.radius <= 0 ||
            this.radius.length === 0 ||
            Object.keys(layer.tokens).some((key) => key.startsWith("borderRadius"))
        ) {
            return;
        }
        this.dimensionFix(layer, "radius", layer.radius, this.radius, ["borderRadius"], "radius", fixes, findings);
    }

    private checkSpacing(layer: RawLayer, fixes: Fix[], findings: Finding[]): void {
        if (!layer.spacing || this.spacing.length === 0) {
            return;
        }
        // one fix per value: four equal paddings are one change
        const byValue = new Map<number, string[]>();
        for (const [property, value] of Object.entries(layer.spacing)) {
            if (!(property in SPACING_WORDS) || !(value > 0) || layer.tokens[property]) {
                continue;
            }
            byValue.set(value, [...(byValue.get(value) ?? []), property]);
        }
        for (const [value, properties] of byValue) {
            const word = properties.every((p) => SPACING_WORDS[p] === "gap") ? "gap" : "spacing";
            this.dimensionFix(layer, "spacing", value, this.spacing, properties, word, fixes, findings);
        }
    }

    private dimensionFix(
        layer: RawLayer,
        code: "radius" | "spacing",
        value: number,
        tokens: DimensionToken[],
        properties: string[],
        word: string,
        fixes: Fix[],
        findings: Finding[]
    ): void {
        let best: DimensionToken | null = null;
        for (const token of tokens) {
            if (!best || Math.abs(token.value - value) < Math.abs(best.value - value)) {
                best = token;
            }
        }
        if (!best) {
            return;
        }
        const op: FixOp = { op: "token", layerId: layer.id, token: best.name, properties, value: best.value };
        const diff = Math.abs(best.value - value);
        if (diff === 0) {
            fixes.push(
                this.fix(
                    layer,
                    "token-linked",
                    { name: best.name, to: best.value },
                    `"${layer.name}" now uses ${best.name}.`,
                    [op],
                    true
                )
            );
        } else if (this.options.mode === "redesign" || diff <= ConformanceChecker.DIMENSION_NEAR) {
            fixes.push(
                this.fix(
                    layer,
                    code,
                    { from: value, to: best.value, name: best.name },
                    `"${layer.name}" had ${word} ${value}; the system has ${best.name} = ${best.value}, so I used that.`,
                    [op]
                )
            );
        } else {
            findings.push(
                this.finding(
                    layer,
                    code === "radius" ? "off-radius" : "off-spacing",
                    { from: value, to: best.value, name: best.name },
                    `"${layer.name}" has ${word} ${value}, far from the system's values (closest: ${best.name} = ${best.value}).`
                )
            );
        }
    }

    private checkShadows(layer: RawLayer, findings: Finding[]): void {
        if (layer.shadows > 0 && this.shadowTokens > 0 && !layer.tokens.shadow) {
            findings.push(
                this.finding(
                    layer,
                    "off-shadow",
                    {},
                    `"${layer.name}" has a shadow that is not one of the system's shadows.`
                )
            );
        }
    }

    // --- helpers

    private fix(
        layer: RawLayer,
        code: Fix["code"],
        params: Fix["params"],
        text: string,
        ops: FixOp[],
        quiet = false
    ): Fix {
        return {
            code,
            pageId: layer.pageId,
            layerId: layer.id,
            layerName: layer.name,
            boardName: layer.boardName,
            params: { layer: layer.name, board: layer.boardName, ...params },
            text,
            ops,
            quiet,
        };
    }

    private finding(layer: RawLayer, code: Finding["code"], params: Finding["params"], text: string): Finding {
        return {
            code,
            pageId: layer.pageId,
            layerId: layer.id,
            layerName: layer.name,
            boardName: layer.boardName,
            params: { layer: layer.name, board: layer.boardName, ...params },
            text,
        };
    }

    private static hasAncestorIn(layer: RawLayer, byId: Map<string, RawLayer>, ids: Set<string>): boolean {
        if (ids.size === 0) {
            return false;
        }
        let parentId = layer.parentId;
        let guard = 0;
        while (parentId && guard++ < 200) {
            if (ids.has(parentId)) {
                return true;
            }
            parentId = byId.get(parentId)?.parentId ?? null;
        }
        return false;
    }

    private static colorCandidates(catalog: SystemCatalog): ColorCandidate[] {
        const byHex = new Map<string, ColorCandidate>();
        for (const color of catalog.colors) {
            const hex = ColorMath.normalize(color.hex);
            if (!hex || color.opacity === 0 || byHex.has(hex)) {
                continue;
            }
            byHex.set(hex, {
                hex,
                colorId: color.id,
                token: null,
                label: color.path ? `${color.path}/${color.name}` : color.name,
            });
        }
        for (const token of catalog.tokens) {
            if (token.type !== "color") {
                continue;
            }
            const hex = ColorMath.normalize(token.value);
            if (!hex) {
                continue;
            }
            const existing = byHex.get(hex);
            if (existing) {
                if (!existing.token) {
                    existing.token = token.name;
                    existing.label = token.name;
                }
            } else {
                byHex.set(hex, { hex, colorId: null, token: token.name, label: token.name });
            }
        }
        return [...byHex.values()];
    }

    private static dimensions(catalog: SystemCatalog, types: string[]): DimensionToken[] {
        return catalog.tokens
            .filter((token) => types.includes(token.type))
            .map((token) => ({
                name: token.name,
                value: typeof token.value === "number" ? token.value : parseFloat(String(token.value)),
            }))
            .filter((token) => Number.isFinite(token.value));
    }
}
