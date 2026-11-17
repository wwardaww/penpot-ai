import type { NodeSnapshot } from "../DesignTree";

/** Node snapshot fields a test sets; everything else gets neutral defaults. */
export type NodeSpec = Partial<Omit<NodeSnapshot, "geometry" | "children">> & {
    id: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    children?: NodeSnapshot[];
};

/**
 * Builds a full node snapshot in the `get_node_properties` format.
 *
 * @param spec - the fields to set
 */
export function node(spec: NodeSpec): NodeSnapshot {
    const { x = 0, y = 0, width = 100, height = 100, children = [], ...rest } = spec;
    return {
        pageId: "page-1",
        name: spec.id,
        type: "rectangle",
        visible: true,
        opacity: 1,
        fills: [],
        strokes: [],
        layout: null,
        text: null,
        tokens: {},
        component: null,
        interactions: [],
        ...rest,
        geometry: { x, y, width, height, rotation: 0 },
        childCount: children.length,
        children,
    };
}

/**
 * Builds a text node snapshot with one span.
 *
 * @param spec - node fields plus the text, its color and size
 */
export function text(
    spec: NodeSpec & { content: string; color?: string; fontSize?: number; fontWeight?: number; growType?: string }
): NodeSnapshot {
    const { content, color = "#000000", fontSize = 16, fontWeight = 400, growType = "auto-height", ...rest } = spec;
    const fills = [{ color, opacity: 1, gradient: null, image: null, colorRef: null }];
    return node({
        type: "text",
        fills,
        text: {
            content,
            growType,
            typography: { fontSize, fontWeight, lineHeight: 1.2 },
            spans: [{ start: 0, end: content.length, text: content, fontSize, fontWeight, fills }],
        },
        ...rest,
    });
}

/**
 * Flat fill list.
 *
 * @param color - hex color
 * @param opacity - opacity
 */
export function fill(color: string, opacity = 1) {
    return [{ color, opacity, gradient: null, image: null, colorRef: null }];
}

/**
 * The acceptance scenario board: a light-gray label on white and a 20×20 close button.
 */
export function loginBoard(): NodeSnapshot {
    return node({
        id: "board-login",
        name: "Login",
        type: "board",
        width: 390,
        height: 844,
        fills: fill("#FFFFFF"),
        layout: { type: "none", clipContent: true },
        children: [
            text({
                id: "text-title",
                name: "Title",
                content: "Welcome back",
                x: 24,
                y: 80,
                width: 300,
                height: 40,
                fontSize: 32,
                fontWeight: 700,
            }),
            text({
                id: "text-hint",
                name: "Hint",
                content: "Forgot your password?",
                x: 24,
                y: 140,
                width: 200,
                height: 20,
                color: "#BBBBBB",
                fontSize: 14,
            }),
            node({
                id: "close-button",
                name: "Close",
                type: "board",
                x: 350,
                y: 20,
                width: 20,
                height: 20,
                fills: fill("#EEEEEE"),
                interactions: [{ trigger: "click", action: { type: "previous-screen" } }],
                children: [
                    node({
                        id: "close-icon",
                        name: "Close icon",
                        type: "path",
                        x: 354,
                        y: 24,
                        width: 12,
                        height: 12,
                        fills: fill("#333333"),
                    }),
                ],
            }),
        ],
    });
}
