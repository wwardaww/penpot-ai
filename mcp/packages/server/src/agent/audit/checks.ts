import { AuditCheck } from "./AuditCheck";
import type { AuditConfig } from "./AuditConfig";
import type { AuditFindingDraft } from "./AuditFinding";
import type { DesignTree, SpanSnapshot, TreeNode } from "./DesignTree";
import { Rgb } from "./Rgb";

/**
 * Text vs background contrast (WCAG AA: 4.5:1, or 3:1 for large text).
 *
 * The background is the composite of the flat fills painted below the text's center, over white.
 * Texts over gradients or images are skipped: their background is unknown.
 */
export class ContrastCheck extends AuditCheck {
    public readonly id = "contrast" as const;

    public run(tree: DesignTree): AuditFindingDraft[] {
        const findings: AuditFindingDraft[] = [];
        for (const node of tree.visibleNodes()) {
            const text = node.snapshot.text;
            if (node.type !== "text" || !text || text.content.trim() === "") {
                continue;
            }
            const background = ContrastCheck.background(tree, node);
            if (!background) {
                continue;
            }
            const worst = ContrastCheck.worstSpan(node, background);
            if (!worst) {
                continue;
            }
            const ratio = Math.floor(worst.ratio * 10) / 10;
            const better = ContrastCheck.betterColor(worst.color, background, worst.alpha, worst.required);
            findings.push(
                this.finding(node, {
                    severity: worst.ratio < 3 ? "error" : "warning",
                    title: "Low contrast",
                    message:
                        `${AuditCheck.label(node)} has a contrast of ${ratio}:1 against ${background.hex()}; ` +
                        `text this size needs at least ${worst.required}:1 to be easy to read.`,
                    suggestion: better
                        ? `Use a text color such as ${better.hex()}, or change the background.`
                        : "Change the text or background color so they stand apart more.",
                    data: {
                        ratio: Math.round(worst.ratio * 100) / 100,
                        required: worst.required,
                        textColor: worst.color.hex(),
                        background: background.hex(),
                        fontSize: worst.fontSize,
                        largeText: worst.required === 3,
                        suggestedColor: better ? better.hex() : null,
                    },
                })
            );
        }
        return findings;
    }

    /**
     * Background color behind a node's center, or null if it cannot be known.
     */
    public static background(tree: DesignTree, node: TreeNode): Rgb | null {
        const center = node.bounds().center();
        const layers: { rgb: Rgb; alpha: number }[] = [];
        for (const below of tree.paintedBelow(node)) {
            if (below.type === "text" || !below.isVisible() || !below.bounds().containsPoint(center)) {
                continue;
            }
            const fills = below.snapshot.fills;
            if (!Array.isArray(fills) || fills.length === 0) {
                continue;
            }
            const paint = AuditCheck.solid(fills);
            if (!paint) {
                return null;
            }
            const alpha = paint.opacity * below.effectiveOpacity();
            if (alpha <= 0.01) {
                continue;
            }
            layers.push({ rgb: paint.rgb, alpha });
            if (alpha >= 0.99) {
                break;
            }
        }
        let color = Rgb.WHITE;
        for (const layer of layers.reverse()) {
            color = layer.rgb.over(color, layer.alpha);
        }
        return color;
    }

    private static worstSpan(node: TreeNode, background: Rgb) {
        const text = node.snapshot.text!;
        const typography = text.typography ?? {};
        const spans: SpanSnapshot[] =
            text.spans && text.spans.length > 0
                ? text.spans
                : [{ start: 0, end: text.content.length, text: text.content }];
        let worst: { ratio: number; required: number; color: Rgb; alpha: number; fontSize: number } | null = null;
        for (const span of spans) {
            if (span.text.trim() === "") {
                continue;
            }
            const paint = AuditCheck.solid(Array.isArray(span.fills) ? span.fills : node.snapshot.fills);
            if (!paint) {
                continue;
            }
            const fontSize = AuditCheck.number(span.fontSize) ?? AuditCheck.number(typography.fontSize) ?? 14;
            const weight = AuditCheck.number(span.fontWeight) ?? AuditCheck.number(typography.fontWeight) ?? 400;
            const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
            const required = large ? 3 : 4.5;
            const alpha = paint.opacity * node.effectiveOpacity();
            const ratio = paint.rgb.over(background, alpha).contrast(background);
            if (ratio < required && (!worst || ratio / required < worst.ratio / worst.required)) {
                worst = { ratio, required, color: paint.rgb, alpha, fontSize };
            }
        }
        return worst;
    }

    /**
     * Closest text color (towards black or white) that reaches the required contrast.
     */
    private static betterColor(color: Rgb, background: Rgb, alpha: number, required: number): Rgb | null {
        const target =
            Rgb.WHITE.contrast(background) > new Rgb(0, 0, 0).contrast(background) ? Rgb.WHITE : new Rgb(0, 0, 0);
        for (let step = 0.05; step <= 1.0001; step += 0.05) {
            const candidate = target.over(color, step);
            if (candidate.over(background, alpha).contrast(background) >= required) {
                return candidate;
            }
        }
        return null;
    }
}

/**
 * Tap/click targets smaller than the platform minimum (44 px on mobile, 24 px on web).
 *
 * A node is a target when it has prototype interactions or its (component) name says button, link,
 * tab, toggle and the like. Only the outermost target is checked; texts are never targets.
 */
export class TouchTargetCheck extends AuditCheck {
    public readonly id = "touch-target" as const;

    private static readonly TARGET_NAME =
        /\b(button|btn|cta|link|tab|toggle|switch|checkbox|radio|chip|icon[ -]?button|close|menu item|nav item)\b/i;
    private static readonly CONTAINER_NAME = /\b(bar|group|list|tabs|nav|navigation|toolbar|menu|container)\b/i;

    public run(tree: DesignTree, config: AuditConfig): AuditFindingDraft[] {
        const findings: AuditFindingDraft[] = [];
        const visit = (node: TreeNode) => {
            if (!node.isVisible()) {
                return;
            }
            if (TouchTargetCheck.isTarget(node)) {
                const b = node.bounds();
                const min = config.minTouchTarget;
                if (b.width < min || b.height < min) {
                    const size = `${Math.round(b.width)}×${Math.round(b.height)} px`;
                    findings.push(
                        this.finding(node, {
                            severity: Math.min(b.width, b.height) < min * 0.6 ? "error" : "warning",
                            title: "Small tap target",
                            message:
                                `${AuditCheck.label(node)} is ${size}; ` +
                                `${config.platform === "mobile" ? "tap" : "click"} targets should be at least ${min}×${min} px.`,
                            suggestion: `Make it at least ${min}×${min} px, for example with padding around the content.`,
                            data: { width: b.width, height: b.height, minimum: min },
                        })
                    );
                    return;
                }
                if (!TouchTargetCheck.CONTAINER_NAME.test(node.name)) {
                    return;
                }
            }
            node.children.forEach(visit);
        };
        for (const root of tree.roots) {
            root.children.forEach(visit);
        }
        return findings;
    }

    private static isTarget(node: TreeNode): boolean {
        if (node.type === "text") {
            return false;
        }
        if ((node.snapshot.interactions ?? []).length > 0) {
            return true;
        }
        const componentName = node.snapshot.component?.componentName ?? "";
        const name = node.name.replace(/[_/-]+/g, " ");
        return (
            TouchTargetCheck.TARGET_NAME.test(name) ||
            TouchTargetCheck.TARGET_NAME.test(componentName.replace(/[_/-]+/g, " "))
        );
    }
}

/**
 * Layout gaps and paddings off the spacing scale (multiples of the base, 4 px by default), unless a
 * spacing token is applied to them.
 */
export class SpacingCheck extends AuditCheck {
    public readonly id = "spacing" as const;

    public run(tree: DesignTree, config: AuditConfig): AuditFindingDraft[] {
        const findings: AuditFindingDraft[] = [];
        for (const node of tree.visibleNodes()) {
            const layout = node.snapshot.layout;
            if (!layout || (layout.type !== "flex" && layout.type !== "grid")) {
                continue;
            }
            const tokens = node.tokenProperties();
            const padding = layout.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
            const values: { property: string; token: string; value: number }[] = [
                { property: "row gap", token: "rowgap", value: layout.rowGap ?? 0 },
                { property: "column gap", token: "columngap", value: layout.columnGap ?? 0 },
                { property: "top padding", token: "p1", value: padding.top },
                { property: "right padding", token: "p2", value: padding.right },
                { property: "bottom padding", token: "p3", value: padding.bottom },
                { property: "left padding", token: "p4", value: padding.left },
            ];
            const off = values.filter((v) => v.value > 0 && !tokens.has(v.token) && !config.isOnSpacingScale(v.value));
            if (off.length === 0) {
                continue;
            }
            const distinct = [...new Set(off.map((v) => v.value))];
            const replacements = distinct.map((v) => `${config.nearestSpacing(v)} px instead of ${v} px`).join(", ");
            findings.push(
                this.finding(node, {
                    severity: "info",
                    title: "Off-scale spacing",
                    message:
                        `${AuditCheck.label(node)} uses spacing of ${distinct.map((v) => `${v} px`).join(", ")} ` +
                        `(${off.map((v) => v.property).join(", ")}), which is not on the ${config.spacingBase} px grid.`,
                    suggestion: `Use ${replacements}, or apply a spacing token.`,
                    data: { values: off },
                })
            );
        }
        return findings;
    }
}

/**
 * Flat colors that are almost, but not exactly, the same and come neither from the library nor
 * from a token (for example `#333333` and `#343434`).
 */
export class ColorDuplicateCheck extends AuditCheck {
    public readonly id = "color-duplicate" as const;

    public run(tree: DesignTree, config: AuditConfig): AuditFindingDraft[] {
        const usages = new Map<string, TreeNode[]>();
        const use = (hex: string, node: TreeNode) => {
            const nodes = usages.get(hex) ?? [];
            if (!nodes.includes(node)) {
                nodes.push(node);
            }
            usages.set(hex, nodes);
        };
        for (const node of tree.visibleNodes()) {
            const tokens = node.tokenProperties();
            const fills = node.snapshot.fills;
            if (Array.isArray(fills) && !tokens.has("fill")) {
                for (const fill of fills) {
                    const rgb = fill.colorRef || fill.gradient || fill.image ? null : Rgb.parse(fill.color);
                    if (rgb) {
                        use(rgb.hex(), node);
                    }
                }
            }
            if (!tokens.has("strokecolor")) {
                for (const stroke of node.snapshot.strokes ?? []) {
                    const rgb = stroke.colorRef || stroke.gradient ? null : Rgb.parse(stroke.color);
                    if (rgb) {
                        use(rgb.hex(), node);
                    }
                }
            }
        }
        // most used color of a group is the one to keep
        const ordered = [...usages.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
        const assigned = new Set<string>();
        const findings: AuditFindingDraft[] = [];
        for (const [canonical, canonicalNodes] of ordered) {
            if (assigned.has(canonical)) {
                continue;
            }
            assigned.add(canonical);
            const canonicalRgb = Rgb.parse(canonical)!;
            for (const [variant, nodes] of ordered) {
                if (assigned.has(variant) || canonicalRgb.distance(Rgb.parse(variant)!) >= config.colorDistance) {
                    continue;
                }
                assigned.add(variant);
                findings.push(
                    this.finding(nodes[0], {
                        severity: "info",
                        title: "Near-duplicate color",
                        message:
                            `${variant} on ${AuditCheck.label(nodes[0])}${nodes.length > 1 ? ` and ${nodes.length - 1} more layers` : ""} ` +
                            `is almost the same as ${canonical} (used ${canonicalNodes.length} times); the difference is hard to see.`,
                        suggestion: `Use ${canonical} instead, ideally from a shared library color or token.`,
                        relatedNodeIds: nodes.slice(1).map((n) => n.id),
                        data: { color: variant, canonical, uses: nodes.length },
                    })
                );
            }
        }
        return findings;
    }
}

/**
 * Font sizes outside the type scale, one finding per board and size, unless a font-size or
 * typography token is applied.
 */
export class TypeScaleCheck extends AuditCheck {
    public readonly id = "type-scale" as const;

    public run(tree: DesignTree, config: AuditConfig): AuditFindingDraft[] {
        const findings: AuditFindingDraft[] = [];
        for (const root of tree.roots) {
            const bySize = new Map<number, TreeNode[]>();
            for (const node of root.walk()) {
                const text = node.snapshot.text;
                if (node.type !== "text" || !text || !node.isVisible()) {
                    continue;
                }
                const tokens = node.tokenProperties();
                if (tokens.has("fontsize") || tokens.has("typography")) {
                    continue;
                }
                for (const size of TypeScaleCheck.sizes(node)) {
                    if (!config.isOnTypeScale(size)) {
                        const nodes = bySize.get(size) ?? [];
                        if (!nodes.includes(node)) {
                            nodes.push(node);
                        }
                        bySize.set(size, nodes);
                    }
                }
            }
            for (const [size, nodes] of bySize) {
                findings.push(
                    this.finding(nodes[0], {
                        severity: "info",
                        title: "Off-scale font size",
                        message:
                            `Font size ${size} px (${AuditCheck.label(nodes[0])}` +
                            `${nodes.length > 1 ? ` and ${nodes.length - 1} more` : ""}) is not on the type scale.`,
                        suggestion: `Use ${config.nearestTypeSize(size)} px, or a text style from the library.`,
                        relatedNodeIds: nodes.slice(1).map((n) => n.id),
                        data: { fontSize: size, nearest: config.nearestTypeSize(size), uses: nodes.length },
                    })
                );
            }
        }
        return findings;
    }

    private static sizes(node: TreeNode): number[] {
        const text = node.snapshot.text!;
        const sizes = (text.spans ?? [])
            .map((span) => AuditCheck.number(span.fontSize))
            .filter((size): size is number => size !== null);
        const shapeSize = AuditCheck.number(text.typography?.fontSize);
        if (sizes.length === 0 && shapeSize !== null) {
            sizes.push(shapeSize);
        }
        return [...new Set(sizes.map((s) => Math.round(s * 100) / 100))];
    }
}

/**
 * Layers that keep a default name (`Rectangle 12`, `Group 3`, `Board`); one finding per board.
 */
export class DefaultNameCheck extends AuditCheck {
    public readonly id = "default-name" as const;

    private static readonly DEFAULT_NAME =
        /^(rectangle|ellipse|board|frame|group|path|vector|image|line|polygon|star|union|difference|intersection|exclude|exclusion|flatten|bool|component|layer|shape|mask|curve)( ?\d+)?$/i;

    /**
     * Tells whether a layer name is a default one.
     *
     * @param name - the layer name
     */
    public static isDefaultName(name: string): boolean {
        return DefaultNameCheck.DEFAULT_NAME.test(name.trim());
    }

    public run(tree: DesignTree): AuditFindingDraft[] {
        const findings: AuditFindingDraft[] = [];
        for (const root of tree.roots) {
            const named = [...root.walk()].filter(
                (node) => node.isVisible() && DefaultNameCheck.isDefaultName(node.name)
            );
            if (named.length === 0) {
                continue;
            }
            const examples = [...new Set(named.map((n) => `"${n.name}"`))].slice(0, 3).join(", ");
            findings.push(
                this.finding(root, {
                    severity: "info",
                    title: "Default layer names",
                    message: `${named.length} ${named.length === 1 ? "layer has" : "layers have"} a default name, such as ${examples}.`,
                    suggestion: "Give layers names that say what they are (Auto-name can do it for you).",
                    relatedNodeIds: named.map((n) => n.id),
                    data: { count: named.length },
                })
            );
        }
        return findings;
    }
}

/**
 * Component copies that lost their main component, and plain layers that look like an unlinked
 * copy of a component used in the same design.
 */
export class DetachedInstanceCheck extends AuditCheck {
    public readonly id = "detached-instance" as const;

    public run(tree: DesignTree): AuditFindingDraft[] {
        const componentNames = new Map<string, string>();
        for (const node of tree.nodes()) {
            const component = node.snapshot.component;
            if (component?.isInstance) {
                for (const name of [component.componentName, node.name]) {
                    if (name) {
                        componentNames.set(name.trim().toLowerCase(), name.trim());
                    }
                }
            }
        }
        const findings: AuditFindingDraft[] = [];
        for (const node of tree.visibleNodes()) {
            const component = node.snapshot.component;
            if (component?.isInstance && !component.isMainInstance && !component.componentId) {
                findings.push(
                    this.finding(node, {
                        severity: "warning",
                        title: "Broken component copy",
                        message: `${AuditCheck.label(node)} is a component copy whose main component is missing.`,
                        suggestion: "Swap it for a component from the library, or detach it on purpose.",
                    })
                );
                continue;
            }
            const match = componentNames.get(node.name.trim().toLowerCase());
            if (
                !component &&
                node.parent !== null &&
                (node.type === "board" || node.type === "group") &&
                node.children.length > 0 &&
                match
            ) {
                findings.push(
                    this.finding(node, {
                        severity: "info",
                        title: "Detached component",
                        message: `${AuditCheck.label(node)} looks like a copy of the "${match}" component that is no longer linked to it.`,
                        suggestion: `Replace it with an instance of "${match}" so library changes reach it.`,
                        data: { component: match },
                    })
                );
            }
        }
        return findings;
    }
}

/**
 * Text that does not fit: cut off by a clipping board, or (fixed-size text boxes) longer than the
 * box, estimated from the font size and an average character width.
 */
export class TextOverflowCheck extends AuditCheck {
    public readonly id = "text-overflow" as const;

    /** average character width as a share of the font size */
    private static readonly CHAR_WIDTH = 0.52;

    public run(tree: DesignTree): AuditFindingDraft[] {
        const findings: AuditFindingDraft[] = [];
        for (const node of tree.visibleNodes()) {
            const text = node.snapshot.text;
            if (node.type !== "text" || !text || text.content.trim() === "") {
                continue;
            }
            const clipper = node
                .ancestors()
                .find((a) => a.snapshot.layout?.clipContent === true && a.bounds().overflowedBy(node.bounds(), 1));
            if (clipper) {
                findings.push(
                    this.finding(node, {
                        severity: "warning",
                        title: "Text cut off",
                        message: `${AuditCheck.label(node)} sticks out of "${clipper.name}", which hides what overflows.`,
                        suggestion: "Move or shrink the text, or make the board larger.",
                        data: { clippedBy: clipper.id },
                    })
                );
                continue;
            }
            if (text.growType !== "fixed") {
                continue;
            }
            const estimate = TextOverflowCheck.estimate(node);
            if (estimate && estimate.needed > estimate.available * 1.2 + 2) {
                findings.push(
                    this.finding(node, {
                        severity: "warning",
                        title: "Text may overflow",
                        message:
                            `${AuditCheck.label(node)} needs about ${estimate.lines} lines, ` +
                            `but its fixed-size box fits about ${Math.max(1, estimate.fits)}.`,
                        suggestion: "Set the text box to auto height, make it taller, or shorten the text.",
                        data: estimate,
                    })
                );
            }
        }
        return findings;
    }

    private static estimate(node: TreeNode) {
        const text = node.snapshot.text!;
        const b = node.bounds();
        if (b.width <= 0 || b.height <= 0) {
            return null;
        }
        const spanSizes = (text.spans ?? [])
            .map((span) => AuditCheck.number(span.fontSize))
            .filter((size): size is number => size !== null);
        const fontSize = Math.max(...spanSizes, AuditCheck.number(text.typography?.fontSize) ?? 0) || 14;
        let lineHeight = AuditCheck.number(text.typography?.lineHeight) ?? 1.2;
        if (lineHeight > 4) {
            // a value in px
            lineHeight = lineHeight / fontSize;
        }
        const perLine = Math.max(1, Math.floor(b.width / (fontSize * TextOverflowCheck.CHAR_WIDTH)));
        const lines = text.content
            .split("\n")
            .reduce((sum, paragraph) => sum + Math.max(1, Math.ceil(paragraph.length / perLine)), 0);
        const linePx = fontSize * lineHeight;
        return {
            lines,
            fits: Math.floor(b.height / linePx),
            needed: Math.round(lines * linePx),
            available: Math.round(b.height),
        };
    }
}
