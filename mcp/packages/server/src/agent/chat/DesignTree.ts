/** Node of a `get_node_properties` snapshot, reduced to what style comparisons need. */
export interface DesignNode {
    id: string;
    name: string;
    type: string;
    /** style values in snapshot format, by key (`fills`, `strokes`, `radius`, `opacity`, `shadows`) */
    style: Record<string, unknown>;
    children: DesignNode[];
}

/**
 * Reader of `get_node_properties` snapshots for style comparisons between layers and screens.
 */
export class DesignTree {
    /** Snapshot keys that make up a layer's look. */
    public static readonly STYLE_KEYS = ["fills", "strokes", "radius", "opacity", "shadows"] as const;

    /**
     * Parses the text of a `get_node_properties` answer.
     *
     * @returns the node, or null when the text holds no snapshot
     */
    public static parse(text: string): DesignNode | null {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start < 0 || end < start) {
            return null;
        }
        try {
            return DesignTree.node(JSON.parse(text.slice(start, end + 1)));
        } catch {
            return null;
        }
    }

    /**
     * All nodes of a tree below the root, depth first.
     */
    public static descendants(root: DesignNode): DesignNode[] {
        const result: DesignNode[] = [];
        const walk = (node: DesignNode) => {
            for (const child of node.children) {
                result.push(child);
                walk(child);
            }
        };
        walk(root);
        return result;
    }

    /**
     * Whether two style values are the same (deep comparison of their JSON).
     */
    public static same(a: unknown, b: unknown): boolean {
        return DesignTree.canonical(a) === DesignTree.canonical(b);
    }

    /**
     * Short text of a style change for people, old value then new value per key, e.g.
     * `fill gradient #7b61ff/#5b3fe0 → gradient #ff9a3d/#f26b1d, radius 8 → 12`.
     *
     * @param before - the style before the change (missing keys read as "none")
     * @param after - the style after the change
     */
    public static describeChange(before: Record<string, unknown>, after: Record<string, unknown>): string {
        const label: Record<string, string> = { fills: "fill", strokes: "stroke" };
        return Object.keys(after)
            .map((key) => `${label[key] ?? key} ${DesignTree.value(before[key])} → ${DesignTree.value(after[key])}`)
            .join(", ");
    }

    /** Text of one style value: paints as colors (a gradient's stops joined by "/"), else JSON. */
    private static value(value: unknown): string {
        if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
            return "none";
        }
        if (Array.isArray(value)) {
            const paints = value.map((paint) => {
                const gradient = paint && typeof paint === "object" ? (paint as { gradient?: unknown }).gradient : null;
                const colors = DesignTree.colors(gradient ?? paint);
                return gradient ? `gradient ${colors.join("/")}` : colors.join("/");
            });
            if (paints.every((paint) => paint.length > 0)) {
                return paints.join(" + ");
            }
        }
        return typeof value === "object" ? JSON.stringify(value) : String(value);
    }

    private static colors(value: unknown): string[] {
        const found: string[] = [];
        const walk = (item: unknown) => {
            if (Array.isArray(item)) {
                item.forEach(walk);
            } else if (item && typeof item === "object") {
                for (const [key, child] of Object.entries(item)) {
                    if (key === "color" && typeof child === "string") {
                        found.push(child);
                    } else {
                        walk(child);
                    }
                }
            }
        };
        walk(value);
        return found;
    }

    private static node(value: unknown): DesignNode | null {
        if (!value || typeof value !== "object") {
            return null;
        }
        const raw = value as Record<string, unknown>;
        if (typeof raw.id !== "string") {
            return null;
        }
        const style: Record<string, unknown> = {};
        for (const key of DesignTree.STYLE_KEYS) {
            if (key in raw) {
                style[key] = raw[key];
            }
        }
        const children = Array.isArray(raw.children)
            ? raw.children.map((child) => DesignTree.node(child)).filter((child): child is DesignNode => child !== null)
            : [];
        return {
            id: raw.id,
            name: typeof raw.name === "string" ? raw.name : "",
            type: typeof raw.type === "string" ? raw.type : "",
            style,
            children,
        };
    }

    private static canonical(value: unknown): string {
        return JSON.stringify(value, (_key, item: unknown) =>
            item && typeof item === "object" && !Array.isArray(item)
                ? Object.fromEntries(
                      Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
                  )
                : item
        );
    }
}
