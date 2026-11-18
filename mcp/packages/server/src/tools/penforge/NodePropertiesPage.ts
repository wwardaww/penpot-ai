type JsonObject = Record<string, unknown>;

/**
 * Size limit and paging of a `get_node_properties` answer (W11).
 *
 * A board with hundreds of children, read with `depth` 2 or more, can produce megabytes of JSON
 * and flood Claude's context. The answer is cut into pages of the node's direct children; a page
 * that is still too large first loses the children's details (they become summaries), then gets
 * fewer children. `childrenPage` tells Claude how to read the next page. A plugin that knows the
 * paging parameters walks only the requested page; an older one sends every child and the page is
 * cut here.
 */
export class NodePropertiesPage {
    /** Largest answer in characters. */
    public static readonly MAX_CHARS = 50_000;
    /** Default number of children per page. */
    public static readonly DEFAULT_LIMIT = 100;
    /** Largest number of children per page. */
    public static readonly MAX_LIMIT = 500;

    private static readonly SUMMARY_KEYS = ["id", "name", "type", "visible", "childCount"];

    /**
     * Serializes one page of a node snapshot.
     *
     * @param data - the snapshot returned by the plugin
     * @param offset - index of the first child to return
     * @param limit - largest number of children to return
     * @param maxChars - largest answer in characters
     * @returns the JSON text of the page
     */
    public static render(
        data: unknown,
        offset: number = 0,
        limit: number = NodePropertiesPage.DEFAULT_LIMIT,
        maxChars: number = NodePropertiesPage.MAX_CHARS
    ): string {
        if (!NodePropertiesPage.isObject(data) || !Array.isArray(data.children)) {
            return NodePropertiesPage.fit(JSON.stringify(data ?? null), maxChars);
        }
        const all = data.children as unknown[];
        // a plugin that pages itself sends one page and its range; it is cut further only to fit
        const pluginPage = NodePropertiesPage.isObject(data.childrenPage) ? data.childrenPage : null;
        const base = pluginPage ? Number(pluginPage.offset) || 0 : 0;
        const total = pluginPage ? Number(pluginPage.total) || all.length : all.length;
        const start = pluginPage ? 0 : Math.min(Math.max(0, Math.floor(offset)), all.length);
        let size = Math.max(1, Math.floor(limit));
        let summarized = false;
        for (;;) {
            const slice = all
                .slice(start, start + size)
                .map((child) => (summarized ? NodePropertiesPage.summary(child) : child));
            const end = base + start + slice.length;
            const out: JsonObject = { ...data, children: slice };
            delete out.childrenPage;
            if (base + start > 0 || end < total || summarized) {
                out.childrenPage = {
                    offset: base + start,
                    returned: slice.length,
                    total,
                    nextOffset: end < total ? end : null,
                    ...(summarized ? { summarized: true } : {}),
                };
            }
            const text = JSON.stringify(out);
            if (text.length <= maxChars || size === 0) {
                return NodePropertiesPage.fit(text, maxChars);
            }
            if (!summarized) {
                summarized = true;
            } else {
                size = Math.floor(size / 2);
            }
        }
    }

    private static summary(child: unknown): unknown {
        if (!NodePropertiesPage.isObject(child)) {
            return child;
        }
        const out: JsonObject = {};
        for (const key of NodePropertiesPage.SUMMARY_KEYS) {
            if (key in child) {
                out[key] = child[key];
            } else if (key === "childCount" && Array.isArray(child.children)) {
                out.childCount = child.children.length;
            }
        }
        return out;
    }

    private static fit(text: string, maxChars: number): string {
        if (text.length <= maxChars) {
            return text;
        }
        return (
            text.slice(0, maxChars) +
            `\n[truncated: ${text.length - maxChars} more characters. The node itself is too large; ` +
            "read its children one by one with get_node_properties.]"
        );
    }

    private static isObject(value: unknown): value is JsonObject {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }
}
