import { createHash } from "crypto";
import { DesignMdFromPenpot } from "../../designmd/DesignMdFromPenpot";
import { ColorMath } from "./ColorMath";
import type {
    ExtractDetails,
    ExtractPlan,
    PlannedColorToken,
    PlannedComponent,
    PlannedTextStyle,
    PlannedValueToken,
    Proposal,
    ProposalKind,
    RawComponent,
    RawGroup,
    RawInventory,
} from "./ExtractModel";

/** Limits of the proposal list, so that it stays readable. */
export const PLAN_LIMITS = {
    colors: 48,
    textStyles: 12,
    spacing: 12,
    radius: 8,
    shadows: 6,
    components: 20,
    icons: 200,
    /** minimum uses of a raw spacing, radius, shadow or text style to become a token */
    minUses: 2,
} as const;

/** Layer names that say nothing (Penpot's defaults). */
const GENERIC_NAME =
    /^(component|board|group|rectangle|frame|copy|ellipse|path|vector|union|text|image|item)(\s*\d+)?$/i;

const ROLE_NAMES = ["primary", "secondary", "accent"];
const SHADOW_NAMES = ["sm", "md", "lg", "xl", "2xl", "3xl"];

/** A proposal and the details it stands for. */
interface Built {
    plan: ExtractPlan;
    details: ExtractDetails;
}

/**
 * Turns the inventory of a copied project file into ONE proposal list (W36): near-duplicate
 * colors to merge, values to turn into tokens (names after W22/W29: `color.*`, `spacing.*`,
 * `radius.*`, `shadow.*`; text styles bring `font-size.*`, `font-weight.*`, `font-family.*`),
 * repeated layer groups to turn into components (one variant per look), components to rename or
 * group, icons to collect and unused library items to drop. Deterministic: the same inventory
 * gives the same list and the same `planId`.
 */
export class ExtractPlanner {
    private readonly proposals: Proposal[] = [];
    private readonly details: ExtractDetails = {
        colors: [],
        merges: [],
        textStyles: [],
        tokens: [],
        components: [],
        renames: [],
        groups: [],
        icons: { proposalId: "icons", shapes: [], componentIds: [] },
        unused: [],
    };
    /** token names already in the file or planned */
    private readonly takenTokens = new Set<string>();

    private constructor(private readonly inventory: RawInventory) {
        for (const set of inventory.tokenSets) {
            for (const token of set.tokens) {
                this.takenTokens.add(token.name);
            }
        }
    }

    /**
     * Builds the proposal list and the details of an inventory.
     *
     * @param inventory - what the inventory script read
     */
    public static build(inventory: RawInventory): Built {
        const planner = new ExtractPlanner(inventory);
        planner.planColors();
        planner.planTextStyles();
        planner.planValueTokens();
        planner.planComponents();
        planner.planRenames();
        planner.planIcons();
        planner.planUnused();
        return { plan: planner.result(), details: planner.details };
    }

    /**
     * The details limited to the accepted proposals.
     *
     * @param details - the details of a plan
     * @param skip - ids of the proposals the user unchecked
     */
    public static accepted(details: ExtractDetails, skip: Iterable<string>): ExtractDetails {
        const skipped = new Set(skip);
        const on = (entry: { proposalId: string }) => !skipped.has(entry.proposalId);
        const colors: PlannedColorToken[] = details.colors.filter((color) => !skipped.has(colorProposalId(color.hex)));
        const merges = details.merges.filter((merge) => !skipped.has(colorProposalId(merge.keep)));
        // a merge the user unchecked: the other values become tokens of their own
        for (const merge of merges) {
            if (skipped.has(merge.proposalId)) {
                for (const drop of merge.drop) {
                    colors.push({
                        hex: drop.hex,
                        opacity: 1,
                        token: drop.altToken,
                        libraryColorId: drop.libraryColorId,
                    });
                }
            }
        }
        return {
            colors,
            merges: merges.filter(on),
            textStyles: details.textStyles.filter(on),
            tokens: details.tokens.filter(on),
            components: details.components.filter(on),
            renames: details.renames.filter(on),
            groups: details.groups.filter(on),
            icons: skipped.has(details.icons.proposalId)
                ? { proposalId: details.icons.proposalId, shapes: [], componentIds: [] }
                : details.icons,
            unused: details.unused.filter(on),
        };
    }

    /** Hash of a proposal list. */
    public static planId(proposals: Proposal[]): string {
        const text = JSON.stringify(proposals.map((proposal) => [proposal.id, proposal.params]));
        return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
    }

    private result(): ExtractPlan {
        const inventory = this.inventory;
        const rawColors = new Set([...Object.keys(inventory.values.fills), ...Object.keys(inventory.values.strokes)]);
        return {
            planId: ExtractPlanner.planId(this.proposals),
            stats: {
                pages: inventory.pages.length,
                screens: inventory.pages.reduce((sum, page) => sum + page.screens, 0),
                components: inventory.components.length,
                colors: inventory.colors.length,
                typographies: inventory.typographies.length,
                tokens: inventory.tokenSets.reduce((sum, set) => sum + set.tokens.length, 0),
                rawColors: rawColors.size,
                truncated: inventory.truncated,
            },
            proposals: this.proposals,
        };
    }

    private add(id: string, kind: ProposalKind, code: string, params: Record<string, unknown>, text: string): void {
        this.proposals.push({ id, kind, code, params, text });
    }

    private uniqueToken(base: string): string {
        let name = base;
        for (let n = 2; this.takenTokens.has(name); n++) {
            name = `${base}-${n}`;
        }
        this.takenTokens.add(name);
        return name;
    }

    // --- colors

    private planColors(): void {
        const counts = new Map<string, number>();
        const bump = (hex: string | null, n: number) => {
            if (hex) {
                counts.set(hex, (counts.get(hex) ?? 0) + n);
            }
        };
        for (const [hex, n] of Object.entries(this.inventory.values.fills)) {
            bump(ColorMath.normalize(hex), n);
        }
        for (const [hex, n] of Object.entries(this.inventory.values.strokes)) {
            bump(ColorMath.normalize(hex), n);
        }
        const library = new Map<string, { id: string; name: string; path: string; opacity: number }[]>();
        for (const color of this.inventory.colors) {
            const hex = ColorMath.normalize(color.hex);
            if (!hex || (color.uses === 0 && !counts.has(hex))) {
                continue;
            }
            library.set(hex, [...(library.get(hex) ?? []), color]);
            if (!counts.has(hex)) {
                counts.set(hex, color.uses);
            }
        }
        const existing = new Map<string, string>();
        for (const set of this.inventory.tokenSets) {
            for (const token of set.tokens) {
                const hex = token.type === "color" ? ColorMath.normalize(token.value) : null;
                if (hex && !existing.has(hex)) {
                    existing.set(hex, token.name);
                }
            }
        }

        const ordered = [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, PLAN_LIMITS.colors);
        const clusters: { keep: string; count: number; drop: { hex: string; count: number }[] }[] = [];
        const assigned = new Set<string>();
        for (const [hex, count] of ordered) {
            if (assigned.has(hex)) {
                continue;
            }
            assigned.add(hex);
            const cluster = { keep: hex, count, drop: [] as { hex: string; count: number }[] };
            for (const [other, otherCount] of ordered) {
                if (!assigned.has(other) && ColorMath.distance(hex, other) <= ColorMath.NEAR) {
                    assigned.add(other);
                    cluster.drop.push({ hex: other, count: otherCount });
                }
            }
            clusters.push(cluster);
        }

        // names: existing tokens, then library names, then roles and plain names
        const names = new Map<string, string>();
        for (const cluster of clusters) {
            const token = existing.get(cluster.keep);
            if (token) {
                names.set(cluster.keep, token);
                this.takenTokens.add(token);
            }
        }
        for (const cluster of clusters) {
            const entry = library.get(cluster.keep)?.[0];
            if (!names.has(cluster.keep) && entry) {
                names.set(cluster.keep, this.uniqueToken(`color.${DesignMdFromPenpot.slug(entry.path, entry.name)}`));
            }
        }
        const roles = ROLE_NAMES.filter((role) => !this.takenTokens.has(`color.${role}`));
        for (const cluster of clusters) {
            if (names.has(cluster.keep)) {
                continue;
            }
            const role = !ColorMath.isNeutral(cluster.keep) ? roles.shift() : undefined;
            names.set(cluster.keep, this.uniqueToken(`color.${role ?? ColorMath.plainName(cluster.keep)}`));
        }

        for (const cluster of clusters) {
            const token = names.get(cluster.keep)!;
            const libraryColor = library.get(cluster.keep)?.[0] ?? null;
            const isExisting = existing.get(cluster.keep) === token;
            if (!isExisting) {
                this.details.colors.push({
                    hex: cluster.keep,
                    opacity: libraryColor?.opacity ?? 1,
                    token,
                    libraryColorId: libraryColor?.id ?? null,
                });
                const params = { hex: cluster.keep, token, count: cluster.count, library: libraryColor?.name ?? null };
                this.add(
                    colorProposalId(cluster.keep),
                    "color-token",
                    libraryColor ? "color-token-library" : "color-token",
                    params,
                    libraryColor
                        ? `The color "${libraryColor.name}" (${cluster.keep}) becomes the token ${token}.`
                        : `${cluster.keep} is used ${cluster.count} times; I will make it the token ${token}.`
                );
            }
            if (cluster.drop.length > 0) {
                const id = `merge:${cluster.keep}`;
                const drop = cluster.drop.map((entry, index) => ({
                    hex: entry.hex,
                    altToken: `${token}-alt${index === 0 ? "" : `-${index + 1}`}`,
                    libraryColorId: library.get(entry.hex)?.[0]?.id ?? null,
                }));
                this.details.merges.push({ proposalId: id, keep: cluster.keep, drop });
                const all = [cluster.keep, ...cluster.drop.map((entry) => entry.hex)];
                this.add(
                    id,
                    "merge-colors",
                    "merge-colors",
                    { count: all.length, colors: all, keep: cluster.keep, token },
                    `${all.length} colors are almost the same (${all.join(", ")}); I will keep one, ${token}.`
                );
            }
        }
    }

    // --- text styles

    private planTextStyles(): void {
        const byKey = new Map<string, PlannedTextStyle & { count: number; best: number }>();
        for (const font of this.inventory.values.fonts) {
            const key = `${font.fontFamily.toLowerCase()}|${font.fontSize}|${font.fontWeight}`;
            const current = byKey.get(key);
            if (!current) {
                byKey.set(key, { ...font, name: "", count: font.count, best: font.count });
            } else {
                current.count += font.count;
                if (font.count > current.best) {
                    current.best = font.count;
                    current.lineHeight = font.lineHeight;
                    current.letterSpacing = font.letterSpacing;
                }
            }
        }
        const known = new Set(
            this.inventory.typographies.map((t) => `${t.fontFamily.toLowerCase()}|${t.fontSize}|${t.fontWeight}`)
        );
        const styles = [...byKey.entries()]
            .filter(([key, style]) => !known.has(key) && style.count >= PLAN_LIMITS.minUses)
            .map(([, style]) => style)
            .sort((a, b) => b.count - a.count || Number(b.fontSize) - Number(a.fontSize))
            .slice(0, PLAN_LIMITS.textStyles)
            .sort(
                (a, b) =>
                    Number(b.fontSize) - Number(a.fontSize) ||
                    Number(b.fontWeight) - Number(a.fontWeight) ||
                    a.fontFamily.localeCompare(b.fontFamily)
            );
        const taken = new Set(this.inventory.typographies.map((t) => t.name.toLowerCase()));
        const counters: Record<string, number> = {};
        for (const style of styles) {
            const size = Number(style.fontSize) || 14;
            const bold = Number(style.fontWeight) >= 600;
            let base: string;
            if (size >= 24) {
                counters.heading = (counters.heading ?? 0) + 1;
                base = `Heading ${counters.heading}`;
            } else if (size >= 17) {
                counters.title = (counters.title ?? 0) + 1;
                base = `Title ${counters.title}`;
            } else if (size >= 14) {
                base = bold ? "Body Strong" : "Body";
            } else {
                base = bold ? "Caption Strong" : "Caption";
            }
            let name = base;
            for (let n = 2; taken.has(name.toLowerCase()); n++) {
                name = `${base} ${n}`;
            }
            taken.add(name.toLowerCase());
            const planned: PlannedTextStyle = {
                name,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                letterSpacing: style.letterSpacing,
            };
            const id = `text:${style.fontFamily.toLowerCase()}|${style.fontSize}|${style.fontWeight}`;
            this.details.textStyles.push({ proposalId: id, style: planned });
            this.add(
                id,
                "text-style",
                "text-style",
                {
                    name,
                    fontFamily: style.fontFamily,
                    fontSize: style.fontSize,
                    fontWeight: style.fontWeight,
                    count: style.count,
                },
                `Text in ${style.fontFamily} ${style.fontSize} px (weight ${style.fontWeight}) is used ${style.count} times; I will make it the text style "${name}".`
            );
        }
    }

    // --- spacing, radius, shadows

    private planValueTokens(): void {
        const existing = (type: string) =>
            new Set(
                this.inventory.tokenSets.flatMap((set) =>
                    set.tokens.filter((token) => token.type === type).map((token) => String(token.value))
                )
            );
        const pick = (values: Record<string, number>, limit: number, skip: Set<string>) =>
            Object.entries(values)
                .map(([value, count]) => ({ value: Number(value), count }))
                .filter(
                    (entry) => Number.isFinite(entry.value) && entry.value > 0 && entry.count >= PLAN_LIMITS.minUses
                )
                .filter((entry) => !skip.has(String(entry.value)))
                .sort((a, b) => b.count - a.count || a.value - b.value)
                .slice(0, limit)
                .sort((a, b) => a.value - b.value);

        for (const entry of pick(this.inventory.values.spacing, PLAN_LIMITS.spacing, existing("spacing"))) {
            const name = this.uniqueToken(`spacing.${numberKey(entry.value)}`);
            this.valueToken("spacing", name, entry.value, entry.count, String(entry.value), "space");
        }
        for (const entry of pick(this.inventory.values.radius, PLAN_LIMITS.radius, existing("borderRadius"))) {
            const name = this.uniqueToken(entry.value >= 999 ? "radius.full" : `radius.${numberKey(entry.value)}`);
            this.valueToken("borderRadius", name, entry.value, entry.count, String(entry.value), "radius");
        }
        const shadows = this.inventory.values.shadows
            .filter((shadow) => shadow.count >= PLAN_LIMITS.minUses)
            .sort((a, b) => b.count - a.count)
            .slice(0, PLAN_LIMITS.shadows)
            .sort((a, b) => a.blur - b.blur || a.offsetY - b.offsetY);
        shadows.forEach((shadow, index) => {
            const name = this.uniqueToken(`shadow.${SHADOW_NAMES[index] ?? index + 1}`);
            const key = shadowKey(shadow);
            const color = shadow.opacity >= 1 ? shadow.hex : rgba(shadow.hex, shadow.opacity);
            const token: PlannedValueToken = {
                type: "shadow",
                name,
                value: key,
                penpotValue: [
                    {
                        offsetX: String(shadow.offsetX),
                        offsetY: String(shadow.offsetY),
                        blur: String(shadow.blur),
                        spread: String(shadow.spread),
                        color,
                        inset: "false",
                    },
                ],
            };
            const id = `shadow:${key}`;
            this.details.tokens.push({ proposalId: id, token });
            this.add(
                id,
                "token",
                "shadow-token",
                { token: name, count: shadow.count, blur: shadow.blur, offsetY: shadow.offsetY, color },
                `A shadow (blur ${shadow.blur} px) is used ${shadow.count} times; I will make it the token ${name}.`
            );
        });
    }

    private valueToken(
        type: "spacing" | "borderRadius",
        name: string,
        value: number,
        count: number,
        penpotValue: string,
        word: string
    ): void {
        const id = `${type === "spacing" ? "spacing" : "radius"}:${value}`;
        this.details.tokens.push({ proposalId: id, token: { type, name, value: String(value), penpotValue } });
        this.add(
            id,
            "token",
            type === "spacing" ? "spacing-token" : "radius-token",
            { token: name, value, count },
            `A ${word} of ${value} px is used ${count} times; I will make it the token ${name}.`
        );
    }

    // --- component candidates

    private planComponents(): void {
        const byHash = new Map<string, RawGroup[]>();
        for (const group of this.inventory.groups) {
            byHash.set(group.hash, [...(byHash.get(group.hash) ?? []), group]);
        }
        const clusters: RawGroup[][] = [];
        for (const groups of byHash.values()) {
            const left = [...groups];
            while (left.length > 0) {
                const first = left.shift()!;
                const cluster = [first];
                for (let i = left.length - 1; i >= 0; i--) {
                    if (similarSize(first, left[i])) {
                        cluster.push(left[i]);
                        left.splice(i, 1);
                    }
                }
                cluster.sort((a, b) => a.id.localeCompare(b.id));
                if (repeats(cluster)) {
                    clusters.push(cluster);
                }
            }
        }
        // outer layers win: take the clusters whose members sit highest first
        clusters.sort(
            (a, b) =>
                Math.min(...a.map((g) => g.ancestors.length)) - Math.min(...b.map((g) => g.ancestors.length)) ||
                b.length - a.length ||
                a[0].id.localeCompare(b[0].id)
        );
        const taken = new Set<string>();
        const accepted: RawGroup[][] = [];
        for (const cluster of clusters) {
            const free = cluster.filter(
                (group) => !taken.has(group.id) && !group.ancestors.some((id) => taken.has(id))
            );
            if (repeats(free)) {
                accepted.push(free);
                free.forEach((group) => taken.add(group.id));
            }
        }
        const usedNames = new Set(this.inventory.components.map((c) => c.name.toLowerCase()));
        let unnamed = 0;
        accepted
            .sort((a, b) => b.length - a.length || a[0].id.localeCompare(b[0].id))
            .slice(0, PLAN_LIMITS.components)
            .forEach((cluster) => {
                const looks = new Map<string, RawGroup[]>();
                for (const group of cluster) {
                    looks.set(group.look, [...(looks.get(group.look) ?? []), group]);
                }
                const variants = [...looks.values()]
                    .sort((a, b) => b.length - a.length || a[0].id.localeCompare(b[0].id))
                    .map((members, index) => ({
                        sampleId: members[0].id,
                        pageId: members[0].pageId,
                        name: index === 0 ? "Default" : `Style ${index + 1}`,
                        members: members.map((member) => member.id),
                    }));
                let base = commonName(cluster);
                if (!base) {
                    unnamed++;
                    base = `Component ${unnamed}`;
                }
                let name = base;
                for (let n = 2; usedNames.has(name.toLowerCase()); n++) {
                    name = `${base} ${n}`;
                }
                usedNames.add(name.toLowerCase());
                const component: PlannedComponent = {
                    name,
                    members: cluster.map((group) => group.id),
                    variants,
                };
                const id = `component:${cluster[0].id}`;
                const screens = new Set(cluster.map((group) => group.screenId)).size;
                this.details.components.push({ proposalId: id, component });
                this.add(
                    id,
                    "component",
                    variants.length > 1 ? "component-variants" : "component",
                    { name, count: cluster.length, screens, variants: variants.length },
                    `"${name}" is drawn ${cluster.length} times on ${screens} screens but is not a component; I will make it a component${
                        variants.length > 1 ? ` with ${variants.length} variants` : ""
                    }.`
                );
            });
    }

    // --- names and groups of the existing components

    private planRenames(): void {
        const names = new Set(this.inventory.components.map((c) => c.name.toLowerCase()));
        for (const component of this.sortedComponents()) {
            if (!GENERIC_NAME.test(component.name.trim()) || component.variantContainerId) {
                continue;
            }
            const label = titleCase(component.firstText);
            if (!label || GENERIC_NAME.test(label) || names.has(label.toLowerCase())) {
                continue;
            }
            names.add(label.toLowerCase());
            const id = `rename:${component.id}`;
            this.details.renames.push({ proposalId: id, componentId: component.id, name: label });
            this.add(
                id,
                "rename-component",
                "rename-component",
                { from: component.name, to: label },
                `The component "${component.name}" has no real name; I will call it "${label}".`
            );
        }
        const byWord = new Map<string, RawComponent[]>();
        for (const component of this.sortedComponents()) {
            if (component.path || component.variantContainerId || component.iconLike) {
                continue;
            }
            const word = component.name.trim().split(/[\s_-]+/)[0] ?? "";
            if (word.length < 3 || GENERIC_NAME.test(word) || word === component.name.trim()) {
                continue;
            }
            const key = word.toLowerCase();
            byWord.set(key, [...(byWord.get(key) ?? []), component]);
        }
        for (const [key, members] of [...byWord.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (members.length < 2) {
                continue;
            }
            const path = titleCase(key);
            const id = `group:${key}`;
            this.details.groups.push({ proposalId: id, path, componentIds: members.map((c) => c.id) });
            this.add(
                id,
                "group-components",
                "group-components",
                { path, count: members.length, names: members.map((c) => c.name).slice(0, 6) },
                `${members.length} components (${members
                    .map((c) => c.name)
                    .slice(0, 4)
                    .join(", ")}) belong together; I will put them in the group "${path}".`
            );
        }
    }

    // --- icons

    private planIcons(): void {
        const seen = new Set<string>();
        const names = new Set<string>();
        let unnamed = 0;
        for (const icon of this.inventory.icons) {
            if (seen.has(icon.hash) || this.details.icons.shapes.length >= PLAN_LIMITS.icons) {
                continue;
            }
            seen.add(icon.hash);
            let name = iconName(icon.name);
            if (!name) {
                unnamed++;
                name = `icon-${unnamed}`;
            }
            let unique = name;
            for (let n = 2; names.has(unique); n++) {
                unique = `${name}-${n}`;
            }
            names.add(unique);
            this.details.icons.shapes.push({ id: icon.id, pageId: icon.pageId, name: unique });
        }
        this.details.icons.componentIds = this.sortedComponents()
            .filter((c) => c.iconLike && !c.variantContainerId && !/^icons(\s*\/|$)/i.test(c.path))
            .map((c) => c.id);
        const count = this.details.icons.shapes.length + this.details.icons.componentIds.length;
        if (count > 0) {
            this.add(
                "icons",
                "icons",
                "icons",
                {
                    count,
                    drawn: this.details.icons.shapes.length,
                    components: this.details.icons.componentIds.length,
                    names: this.details.icons.shapes.map((s) => s.name).slice(0, 8),
                },
                `I found ${count} icons; I will collect them in the Icons group (24 px, one color token).`
            );
        }
    }

    // --- unused library items

    private planUnused(): void {
        for (const color of this.inventory.colors) {
            if (color.uses === 0) {
                this.unused("color", color.id, color.name);
            }
        }
        for (const typography of this.inventory.typographies) {
            if (typography.uses === 0) {
                this.unused("typography", typography.id, typography.name);
            }
        }
        const kept = new Set(this.details.icons.componentIds);
        for (const component of this.sortedComponents()) {
            if (component.instances === 0 && !component.variantContainerId && !kept.has(component.id)) {
                this.unused("component", component.id, component.name);
            }
        }
    }

    private unused(kind: "color" | "typography" | "component", id: string, name: string): void {
        const proposalId = `unused:${kind}:${id}`;
        this.details.unused.push({ proposalId, kind, id, name });
        const word = kind === "typography" ? "text style" : kind;
        this.add(
            proposalId,
            "drop-unused",
            `unused-${kind}`,
            { name },
            `The ${word} "${name}" is not used anywhere; I will leave it out.`
        );
    }

    private sortedComponents(): RawComponent[] {
        return [...this.inventory.components].sort(
            (a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
        );
    }
}

/** Proposal id of a color token. */
export function colorProposalId(hex: string): string {
    return `color:${hex}`;
}

function repeats(cluster: RawGroup[]): boolean {
    const screens = new Set(cluster.map((group) => group.screenId)).size;
    return cluster.length >= 3 || (cluster.length >= 2 && screens >= 2);
}

function similarSize(a: RawGroup, b: RawGroup): boolean {
    const close = (x: number, y: number) => Math.abs(x - y) <= Math.max(4, Math.max(x, y) * 0.2);
    return close(a.width, b.width) && close(a.height, b.height);
}

function commonName(cluster: RawGroup[]): string | null {
    const counts = new Map<string, number>();
    for (const group of cluster) {
        const name = group.name.trim();
        if (name && !GENERIC_NAME.test(name)) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return best ? best[0].slice(0, 60) : null;
}

function titleCase(text: string): string {
    const line = text.replace(/\s+/g, " ").trim().slice(0, 30).trim();
    return line
        .split(" ")
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function iconName(name: string): string {
    const last = name.split("/").at(-1) ?? "";
    const clean = last
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return clean && !GENERIC_NAME.test(clean.replace(/-/g, " ")) ? clean.slice(0, 60) : "";
}

function numberKey(value: number): string {
    return String(Math.round(value * 100) / 100).replace(".", "-");
}

/** Stable key of a shadow (offsets, blur, spread, color). */
export function shadowKey(shadow: {
    offsetX: number;
    offsetY: number;
    blur: number;
    spread: number;
    hex: string;
    opacity: number;
}): string {
    return `${shadow.offsetX}/${shadow.offsetY}/${shadow.blur}/${shadow.spread}/${shadow.hex}/${Math.round(shadow.opacity * 100)}`;
}

function rgba(hex: string, opacity: number): string {
    const [r, g, b] = ColorMath.rgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${Math.round(opacity * 100) / 100})`;
}
