/** What an interaction of the prototype does. */
export type LinkType =
    "navigate" | "open-overlay" | "toggle-overlay" | "close-overlay" | "previous-screen" | "open-url";

/** One prototype interaction of a screen, as the app must wire it. */
export interface PrototypeLink {
    /** board that holds the interaction */
    from: string;
    /** destination board; null for back, close and URL actions */
    to: string | null;
    type: LinkType;
    trigger: string;
    /** ms, for `after-delay` */
    delay: number | null;
    sourceId: string;
    sourceName: string;
    url: string | null;
    /** overlay position and behaviour, in plain words ("" for other actions) */
    overlay: string;
}

/** Prototype flow: a name and its start screen. */
export interface PrototypeFlow {
    name: string;
    startingBoardId: string;
}

/**
 * The prototype of a design as the build needs it: links between boards, flows, and which boards
 * are overlays (shown on top of another screen) instead of screens with a route.
 */
export class PrototypeLinks {
    private static readonly TYPES: Record<string, LinkType> = {
        "navigate-to": "navigate",
        navigate: "navigate",
        "open-overlay": "open-overlay",
        "toggle-overlay": "toggle-overlay",
        "close-overlay": "close-overlay",
        "previous-screen": "previous-screen",
        "prev-screen": "previous-screen",
        "open-url": "open-url",
    };

    private constructor() {}

    /**
     * Reads the links of the `list_boards` answer; the edges of `get_prototype_graph` stand in for
     * boards without an interactions list.
     *
     * @param boards - parsed `list_boards` answer
     * @param edges - `edges` of the parsed `get_prototype_graph` answer
     */
    public static read(boards: Record<string, unknown>[], edges: Record<string, unknown>[]): PrototypeLink[] {
        const links: PrototypeLink[] = [];
        for (const board of boards) {
            const from = String(board.id ?? "");
            if (!Array.isArray(board.interactions)) {
                links.push(...edges.filter((edge) => edge.from === from).flatMap((edge) => PrototypeLinks.edge(edge)));
                continue;
            }
            for (const raw of board.interactions) {
                const interaction = PrototypeLinks.object(raw);
                const action = PrototypeLinks.object(interaction.action);
                const type = PrototypeLinks.TYPES[String(action.type ?? "")];
                const to = typeof action.destinationId === "string" ? action.destinationId : null;
                const needsTarget = type === "navigate" || type === "open-overlay" || type === "toggle-overlay";
                if (type === undefined || (needsTarget && to === null)) {
                    continue;
                }
                links.push({
                    from,
                    to: needsTarget ? to : null,
                    type,
                    trigger: String(interaction.trigger ?? ""),
                    delay: typeof interaction.delay === "number" ? interaction.delay : null,
                    sourceId: String(interaction.sourceId ?? ""),
                    sourceName: String(interaction.sourceName ?? ""),
                    url: typeof action.url === "string" ? action.url : null,
                    overlay:
                        type === "open-overlay" || type === "toggle-overlay" ? PrototypeLinks.overlayText(action) : "",
                });
            }
        }
        return links;
    }

    /**
     * Gets the boards that only ever show as an overlay: opened by an overlay action, never
     * navigated to and never the start of a flow. They are parts of the screens that open them.
     *
     * @param links - the prototype links
     * @param flows - the prototype flows
     */
    public static overlayBoards(links: PrototypeLink[], flows: PrototypeFlow[]): Set<string> {
        const overlays = new Set<string>();
        for (const link of links) {
            if (link.to !== null && (link.type === "open-overlay" || link.type === "toggle-overlay")) {
                overlays.add(link.to);
            }
        }
        for (const link of links) {
            if (link.to !== null && link.type === "navigate") {
                overlays.delete(link.to);
            }
        }
        for (const flow of flows) {
            overlays.delete(flow.startingBoardId);
        }
        return overlays;
    }

    /**
     * Gets the boards that open an overlay board.
     *
     * @param links - the prototype links
     * @param overlay - the overlay board
     */
    public static openers(links: PrototypeLink[], overlay: string): string[] {
        const openers = links
            .filter((link) => link.to === overlay && (link.type === "open-overlay" || link.type === "toggle-overlay"))
            .map((link) => link.from)
            .filter((from) => from !== overlay);
        return [...new Set(openers)];
    }

    private static edge(edge: Record<string, unknown>): PrototypeLink[] {
        const type = PrototypeLinks.TYPES[String(edge.type ?? "navigate")] ?? "navigate";
        const to = String(edge.to ?? "");
        if (to.length === 0) {
            return [];
        }
        return [
            {
                from: String(edge.from ?? ""),
                to,
                type,
                trigger: String(edge.trigger ?? ""),
                delay: null,
                sourceId: String(edge.sourceId ?? ""),
                sourceName: String(edge.sourceName ?? ""),
                url: null,
                overlay: "",
            },
        ];
    }

    private static overlayText(action: Record<string, unknown>): string {
        const parts = [
            typeof action.position === "string" ? `position ${action.position}` : "",
            action.addBackgroundOverlay === true ? "dimmed background behind it" : "",
            action.closeWhenClickOutside === true ? "closes on a click outside" : "",
        ];
        return parts.filter((part) => part.length > 0).join(", ");
    }

    private static object(value: unknown): Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    }
}
