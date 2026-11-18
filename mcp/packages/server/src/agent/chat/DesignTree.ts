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
     * Short text of a style for people: colors of fills and strokes, radius, opacity.
     */
    public static describe(style: Record<string, unknown>): string {
        const parts: string[] = [];
        for (const [key, value] of Object.entries(style)) {
            const colors = DesignTree.colors(value);
            if ((key === "fills" || key === "strokes") && colors.length > 0) {
                parts.push(`${key === "fills" ? "fill" : "stroke"} ${colors.join(" → ")}`);
            } else if (key === "radius" || key === "opacity") {
                parts.push(`${key} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
            } else {
                parts.push(key);
            }
        }
        return parts.join(", ");
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
