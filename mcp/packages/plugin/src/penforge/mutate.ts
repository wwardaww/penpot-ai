import type { Board, Fill, Shape, Stroke, Text } from "@penpot/plugin-types";

/**
 * Resolves a token by its name.
 */
export interface TokenResolver {
    /**
     * Returns the token with the given name, or null.
     *
     * @param name - the token name
     */
    findByName(name: string): any | null;
}

/**
 * Token resolver over the local library's token catalog.
 */
export class LocalTokenResolver implements TokenResolver {
    private readonly penpot: any;

    /**
     * @param penpotApi - the Penpot plugin API object
     */
    constructor(penpotApi: any) {
        this.penpot = penpotApi;
    }

    public findByName(name: string): any | null {
        const catalog = this.penpot.library?.local?.tokens;
        for (const set of catalog?.sets ?? []) {
            for (const token of set.tokens ?? []) {
                if (token.name === name) {
                    return token;
                }
            }
        }
        return null;
    }
}

/**
 * Error raised for mutations that are not allowed or malformed.
 */
export class MutationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MutationError";
    }
}

/**
 * Applies a whitelisted set of property changes to a shape through the Plugin API.
 *
 * Only the keys in {@link NodeMutator.ALLOWED_KEYS} (and the nested keys listed per key) are
 * accepted; anything else is rejected before a single change is made. Values use the same shape as
 * the snapshot returned by `get_node_properties`, so read and write formats match.
 */
export class NodeMutator {
    /**
     * Top-level mutation keys, in the order they are applied.
     */
    public static readonly ALLOWED_KEYS = [
        "name",
        "text",
        "layout",
        "fills",
        "strokes",
        "width",
        "height",
        "x",
        "y",
        "visible",
        "opacity",
        "radius",
        "layoutChild",
        "tokens",
    ] as const;

    private static readonly NESTED_KEYS: Record<string, readonly string[]> = {
        fills: ["color", "opacity", "gradient"],
        strokes: ["color", "opacity", "style", "width", "alignment", "capStart", "capEnd"],
        radius: ["all", "topLeft", "topRight", "bottomRight", "bottomLeft"],
        layout: [
            "type",
            "dir",
            "wrap",
            "alignItems",
            "alignContent",
            "justifyItems",
            "justifyContent",
            "rowGap",
            "columnGap",
            "padding",
            "horizontalSizing",
            "verticalSizing",
        ],
        layoutChild: [
            "absolute",
            "zIndex",
            "horizontalSizing",
            "verticalSizing",
            "alignSelf",
            "margin",
            "minWidth",
            "maxWidth",
            "minHeight",
            "maxHeight",
        ],
        padding: ["top", "right", "bottom", "left"],
        margin: ["top", "right", "bottom", "left"],
    };

    private static readonly LAYOUT_PROPS = [
        "dir",
        "wrap",
        "alignItems",
        "alignContent",
        "justifyItems",
        "justifyContent",
        "rowGap",
        "columnGap",
        "horizontalSizing",
        "verticalSizing",
    ];

    private static readonly LAYOUT_CHILD_PROPS = [
        "absolute",
        "zIndex",
        "horizontalSizing",
        "verticalSizing",
        "alignSelf",
        "minWidth",
        "maxWidth",
        "minHeight",
        "maxHeight",
    ];

    private readonly tokens: TokenResolver;

    /**
     * @param tokens - resolves token names for the `tokens` mutation
     */
    constructor(tokens: TokenResolver) {
        this.tokens = tokens;
    }

    /**
     * Checks that the mutation object only uses whitelisted keys and is not empty.
     *
     * @param mutations - the requested mutations
     * @throws MutationError if a key is unknown or the object is empty
     */
    public static validate(mutations: unknown): void {
        if (mutations === null || typeof mutations !== "object" || Array.isArray(mutations)) {
            throw new MutationError("mutations must be an object");
        }
        const keys = Object.keys(mutations);
        if (keys.length === 0) {
            throw new MutationError("mutations must contain at least one key");
        }
        const allowed = new Set<string>(NodeMutator.ALLOWED_KEYS);
        const unknown = keys.filter((key) => !allowed.has(key));
        if (unknown.length > 0) {
            throw new MutationError(
                `Unknown mutation key(s): ${unknown.join(", ")}. Allowed keys: ${NodeMutator.ALLOWED_KEYS.join(", ")}`
            );
        }
        const m = mutations as Record<string, any>;
        NodeMutator.checkNested("fills", m.fills, true);
        NodeMutator.checkNested("strokes", m.strokes, true);
        if (m.radius !== undefined && typeof m.radius !== "number") {
            NodeMutator.checkNested("radius", m.radius, false);
        }
        NodeMutator.checkNested("layout", m.layout, false);
        NodeMutator.checkNested("padding", m.layout?.padding, false);
        NodeMutator.checkNested("layoutChild", m.layoutChild, false);
        NodeMutator.checkNested("margin", m.layoutChild?.margin, false);
        if (m.tokens !== undefined) {
            if (m.tokens === null || typeof m.tokens !== "object" || Array.isArray(m.tokens)) {
                throw new MutationError("tokens must be an object mapping token property to token name");
            }
            for (const [property, name] of Object.entries(m.tokens)) {
                if (typeof name !== "string" || name.length === 0) {
                    throw new MutationError(`tokens.${property} must be a token name`);
                }
            }
        }
    }

    private static checkNested(key: string, value: unknown, isArray: boolean): void {
        if (value === undefined) {
            return;
        }
        const items = isArray ? value : [value];
        if (!Array.isArray(items)) {
            throw new MutationError(`${key} must be an array`);
        }
        const allowed = new Set(NodeMutator.NESTED_KEYS[key]);
        for (const item of items) {
            if (item === null || typeof item !== "object" || Array.isArray(item)) {
                throw new MutationError(`${key} entries must be objects`);
            }
            const unknown = Object.keys(item).filter((k) => !allowed.has(k));
            if (unknown.length > 0) {
                throw new MutationError(
                    `Unknown key(s) in ${key}: ${unknown.join(", ")}. Allowed: ${[...allowed].join(", ")}`
                );
            }
        }
    }

    /**
     * Validates and applies the mutations to the shape.
     *
     * @param shape - the shape to change; it must be on the active page
     * @param mutations - the requested mutations
     * @returns the keys that were applied, in application order
     */
    public apply(shape: Shape, mutations: Record<string, any>): string[] {
        NodeMutator.validate(mutations);
        // checks that need the shape run before the first change, so a bad request changes nothing
        const resolvedTokens = this.precheck(shape, mutations);
        const applied: string[] = [];
        let resized = false;
        for (const key of NodeMutator.ALLOWED_KEYS) {
            const value = mutations[key];
            if (value === undefined) {
                continue;
            }
            switch (key) {
                case "name":
                    shape.name = String(value);
                    break;
                case "text":
                    (shape as Text).characters = value;
                    break;
                case "layout":
                    this.applyLayout(shape, value);
                    break;
                case "fills":
                    (shape as any).fills = value.map((fill: any) => NodeMutator.toFill(fill));
                    break;
                case "strokes":
                    shape.strokes = value.map((stroke: any) => NodeMutator.toStroke(stroke));
                    break;
                case "width":
                case "height":
                    if (!resized) {
                        const width = mutations.width ?? shape.width;
                        const height = mutations.height ?? shape.height;
                        shape.resize(NodeMutator.number("width", width), NodeMutator.number("height", height));
                        resized = true;
                    }
                    break;
                case "x":
                    shape.x = NodeMutator.number("x", value);
                    break;
                case "y":
                    shape.y = NodeMutator.number("y", value);
                    break;
                case "visible":
                    shape.hidden = !value;
                    break;
                case "opacity":
                    shape.opacity = NodeMutator.number("opacity", value);
                    break;
                case "radius":
                    this.applyRadius(shape, value);
                    break;
                case "layoutChild":
                    this.applyLayoutChild(shape, value);
                    break;
                case "tokens":
                    for (const [property, token] of resolvedTokens) {
                        shape.applyToken(token, [property as any]);
                    }
                    break;
            }
            applied.push(key);
        }
        return applied;
    }

    private static number(key: string, value: unknown): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new MutationError(`${key} must be a finite number`);
        }
        return value;
    }

    private static toFill(fill: any): Fill {
        const result: Fill = {};
        if (fill.color !== undefined) {
            result.fillColor = fill.color;
        }
        if (fill.opacity !== undefined) {
            result.fillOpacity = fill.opacity;
        }
        if (fill.gradient !== undefined) {
            result.fillColorGradient = fill.gradient;
        }
        return result;
    }

    private static toStroke(stroke: any): Stroke {
        const result: Stroke = {};
        if (stroke.color !== undefined) {
            result.strokeColor = stroke.color;
        }
        if (stroke.opacity !== undefined) {
            result.strokeOpacity = stroke.opacity;
        }
        if (stroke.style !== undefined) {
            result.strokeStyle = stroke.style;
        }
        if (stroke.width !== undefined) {
            result.strokeWidth = stroke.width;
        }
        if (stroke.alignment !== undefined) {
            result.strokeAlignment = stroke.alignment;
        }
        if (stroke.capStart !== undefined) {
            result.strokeCapStart = stroke.capStart;
        }
        if (stroke.capEnd !== undefined) {
            result.strokeCapEnd = stroke.capEnd;
        }
        return result;
    }

    private applyRadius(shape: Shape, value: any): void {
        if (typeof value === "number") {
            shape.borderRadius = value;
            return;
        }
        if (value.all !== undefined) {
            shape.borderRadius = NodeMutator.number("radius.all", value.all);
        }
        if (value.topLeft !== undefined) {
            shape.borderRadiusTopLeft = NodeMutator.number("radius.topLeft", value.topLeft);
        }
        if (value.topRight !== undefined) {
            shape.borderRadiusTopRight = NodeMutator.number("radius.topRight", value.topRight);
        }
        if (value.bottomRight !== undefined) {
            shape.borderRadiusBottomRight = NodeMutator.number("radius.bottomRight", value.bottomRight);
        }
        if (value.bottomLeft !== undefined) {
            shape.borderRadiusBottomLeft = NodeMutator.number("radius.bottomLeft", value.bottomLeft);
        }
    }

    private applyLayout(shape: Shape, value: any): void {
        const board = shape as Board;
        const current = board.flex ? "flex" : board.grid ? "grid" : "none";
        const target = value.type ?? current;
        if (target !== current) {
            board.flex?.remove();
            board.grid?.remove();
            if (target === "flex") {
                board.addFlexLayout();
            } else if (target === "grid") {
                board.addGridLayout();
            }
        }
        const layout: any = board.flex ?? board.grid;
        if (!layout) {
            const extra = Object.keys(value).filter((k) => k !== "type");
            if (extra.length > 0) {
                throw new MutationError(`layout properties need a flex or grid layout: ${extra.join(", ")}`);
            }
            return;
        }
        for (const prop of NodeMutator.LAYOUT_PROPS) {
            if (value[prop] !== undefined) {
                layout[prop] = value[prop];
            }
        }
        const padding = value.padding;
        if (padding) {
            if (padding.top !== undefined) {
                layout.topPadding = NodeMutator.number("layout.padding.top", padding.top);
            }
            if (padding.right !== undefined) {
                layout.rightPadding = NodeMutator.number("layout.padding.right", padding.right);
            }
            if (padding.bottom !== undefined) {
                layout.bottomPadding = NodeMutator.number("layout.padding.bottom", padding.bottom);
            }
            if (padding.left !== undefined) {
                layout.leftPadding = NodeMutator.number("layout.padding.left", padding.left);
            }
        }
    }

    private applyLayoutChild(shape: Shape, value: any): void {
        const child: any = shape.layoutChild;
        for (const prop of NodeMutator.LAYOUT_CHILD_PROPS) {
            if (value[prop] !== undefined) {
                child[prop] = value[prop];
            }
        }
        const margin = value.margin;
        if (margin) {
            if (margin.top !== undefined) {
                child.topMargin = NodeMutator.number("layoutChild.margin.top", margin.top);
            }
            if (margin.right !== undefined) {
                child.rightMargin = NodeMutator.number("layoutChild.margin.right", margin.right);
            }
            if (margin.bottom !== undefined) {
                child.bottomMargin = NodeMutator.number("layoutChild.margin.bottom", margin.bottom);
            }
            if (margin.left !== undefined) {
                child.leftMargin = NodeMutator.number("layoutChild.margin.left", margin.left);
            }
        }
    }

    /**
     * Checks shape-dependent constraints and resolves tokens.
     *
     * @returns the resolved tokens as [property, token] pairs
     */
    private precheck(shape: Shape, mutations: Record<string, any>): [string, any][] {
        if (mutations.text !== undefined) {
            if (shape.type !== "text") {
                throw new MutationError(`text can only be set on text nodes (node type: ${shape.type})`);
            }
            if (typeof mutations.text !== "string" || mutations.text.length === 0) {
                throw new MutationError("text must be a non-empty string");
            }
        }
        if (mutations.layout !== undefined && shape.type !== "board") {
            throw new MutationError(`layout can only be set on boards (node type: ${shape.type})`);
        }
        const layoutType = mutations.layout?.type;
        if (layoutType !== undefined && !["flex", "grid", "none"].includes(layoutType)) {
            throw new MutationError(`layout.type must be one of flex, grid, none (got ${layoutType})`);
        }
        if (mutations.layoutChild !== undefined && !shape.layoutChild) {
            throw new MutationError("layoutChild can only be set on children of a flex or grid board");
        }
        const resolved: [string, any][] = [];
        for (const [property, name] of Object.entries((mutations.tokens ?? {}) as Record<string, string>)) {
            const token = this.tokens.findByName(name);
            if (!token) {
                throw new MutationError(`Token not found: ${name}`);
            }
            resolved.push([property, token]);
        }
        return resolved;
    }
}
