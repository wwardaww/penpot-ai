import type {
    Action,
    Board,
    Color,
    Fill,
    Gradient,
    Interaction,
    Shadow,
    Shape,
    Stroke,
    Text,
} from "@penpot/plugin-types";

/**
 * Plain JSON object produced by the serializer.
 */
export type JsonObject = { [key: string]: unknown };

/**
 * Converts Penpot shapes into deterministic, JSON-friendly property snapshots.
 *
 * The snapshot covers everything the `get_node_properties` tool promises: geometry, rotation,
 * constraints, layout, fills, strokes, shadows, radius, text with spans and typography, applied
 * tokens, component/variant info, interactions and a children summary. Keys always appear in the
 * same order and numbers are rounded to two decimals, so equal designs yield equal snapshots.
 */
export class NodeSerializer {
    /**
     * Maximum number of characters for which per-character text spans are computed.
     * Longer texts get a single span carrying the (possibly "mixed") shape-level typography.
     */
    public static readonly MAX_SPAN_TEXT_LENGTH = 2000;

    /**
     * Maximum depth accepted by {@link serializeNode}.
     */
    public static readonly MAX_DEPTH = 5;

    private static readonly TYPOGRAPHY_KEYS = [
        "fontFamily",
        "fontId",
        "fontVariantId",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "lineHeight",
        "letterSpacing",
        "textTransform",
        "textDecoration",
    ] as const;

    private static readonly NUMERIC_TYPOGRAPHY_KEYS = new Set([
        "fontSize",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
    ]);

    /**
     * Rounds a number to two decimals; non-numbers are returned unchanged.
     *
     * @param value - the value to round
     */
    public static round(value: unknown): unknown {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return value;
        }
        const rounded = Math.round(value * 100) / 100;
        // avoid "-0" in the output
        return Object.is(rounded, -0) ? 0 : rounded;
    }

    /**
     * Serializes a shape.
     *
     * @param shape - the shape to serialize
     * @param depth - number of tree levels serialized in full, starting with the shape itself (1 = the shape
     *   only, with a summary of its children; 2 = the shape and its children in full; ...)
     */
    public static serializeNode(shape: Shape, depth: number = 1): JsonObject {
        const levels = Math.max(1, Math.min(NodeSerializer.MAX_DEPTH, Math.floor(depth)));
        return NodeSerializer.serialize(shape, levels);
    }

    /**
     * Summarizes a shape with identity fields only.
     *
     * @param shape - the shape to summarize
     */
    public static summarize(shape: Shape): JsonObject {
        return {
            id: shape.id,
            name: shape.name,
            type: shape.type,
            visible: !shape.hidden,
        };
    }

    private static serialize(shape: Shape, levels: number): JsonObject {
        const s = shape as any;
        const children: Shape[] = Array.isArray(s.children) ? s.children : [];
        const result: JsonObject = {
            id: shape.id,
            name: shape.name,
            type: shape.type,
            parentId: shape.parent ? shape.parent.id : null,
            visible: !shape.hidden,
            blocked: Boolean(shape.blocked),
            geometry: NodeSerializer.geometry(shape),
            constraints: {
                horizontal: shape.constraintsHorizontal ?? null,
                vertical: shape.constraintsVertical ?? null,
            },
            opacity: NodeSerializer.round(shape.opacity ?? 1),
            blendMode: shape.blendMode ?? "normal",
            radius: NodeSerializer.radius(shape),
            fills: NodeSerializer.fills(shape.fills),
            strokes: (shape.strokes ?? []).map((stroke) => NodeSerializer.stroke(stroke)),
            shadows: (shape.shadows ?? []).map((shadow) => NodeSerializer.shadow(shadow)),
            blur: shape.blur ? NodeSerializer.blur(shape.blur) : null,
            layout: shape.type === "board" ? NodeSerializer.layout(shape as Board) : null,
            layoutChild: NodeSerializer.layoutChild(shape),
            layoutCell: NodeSerializer.layoutCell(shape),
            text: shape.type === "text" ? NodeSerializer.text(shape as Text) : null,
            tokens: NodeSerializer.tokens(shape),
            component: NodeSerializer.component(shape),
            interactions: (shape.interactions ?? []).map((interaction) => NodeSerializer.interaction(interaction)),
            childCount: children.length,
        };
        if (levels > 1) {
            result.children = children.map((child) => NodeSerializer.serialize(child, levels - 1));
        } else {
            result.children = children.map((child) => NodeSerializer.summarize(child));
        }
        return result;
    }

    private static geometry(shape: Shape): JsonObject {
        const r = NodeSerializer.round;
        return {
            x: r(shape.x),
            y: r(shape.y),
            width: r(shape.width),
            height: r(shape.height),
            parentX: r(shape.parentX ?? null),
            parentY: r(shape.parentY ?? null),
            rotation: r(shape.rotation ?? 0),
            flipX: Boolean(shape.flipX),
            flipY: Boolean(shape.flipY),
        };
    }

    private static radius(shape: Shape): JsonObject | null {
        if (shape.borderRadius === undefined || shape.borderRadius === null) {
            return null;
        }
        const r = NodeSerializer.round;
        return {
            all: r(shape.borderRadius),
            topLeft: r(shape.borderRadiusTopLeft ?? shape.borderRadius),
            topRight: r(shape.borderRadiusTopRight ?? shape.borderRadius),
            bottomRight: r(shape.borderRadiusBottomRight ?? shape.borderRadius),
            bottomLeft: r(shape.borderRadiusBottomLeft ?? shape.borderRadius),
        };
    }

    private static fills(fills: Fill[] | "mixed" | undefined): unknown {
        if (fills === "mixed") {
            return "mixed";
        }
        return (fills ?? []).map((fill) => NodeSerializer.fill(fill));
    }

    private static fill(fill: Fill): JsonObject {
        return {
            color: fill.fillColor ?? null,
            opacity: NodeSerializer.round(fill.fillOpacity ?? 1),
            gradient: fill.fillColorGradient ? NodeSerializer.gradient(fill.fillColorGradient) : null,
            image: fill.fillImage
                ? {
                      id: fill.fillImage.id,
                      name: fill.fillImage.name ?? null,
                      width: NodeSerializer.round(fill.fillImage.width),
                      height: NodeSerializer.round(fill.fillImage.height),
                      mtype: fill.fillImage.mtype ?? null,
                  }
                : null,
            colorRef: fill.fillColorRefId ? { id: fill.fillColorRefId, fileId: fill.fillColorRefFile ?? null } : null,
        };
    }

    private static gradient(gradient: Gradient): JsonObject {
        const r = NodeSerializer.round;
        return {
            type: gradient.type,
            startX: r(gradient.startX),
            startY: r(gradient.startY),
            endX: r(gradient.endX),
            endY: r(gradient.endY),
            width: r(gradient.width),
            stops: (gradient.stops ?? []).map((stop) => ({
                color: stop.color,
                opacity: r(stop.opacity ?? 1),
                offset: r(stop.offset),
            })),
        };
    }

    private static stroke(stroke: Stroke): JsonObject {
        const r = NodeSerializer.round;
        return {
            color: stroke.strokeColor ?? null,
            opacity: r(stroke.strokeOpacity ?? 1),
            style: stroke.strokeStyle ?? "solid",
            width: r(stroke.strokeWidth ?? 1),
            alignment: stroke.strokeAlignment ?? "center",
            capStart: stroke.strokeCapStart ?? null,
            capEnd: stroke.strokeCapEnd ?? null,
            gradient: stroke.strokeColorGradient ? NodeSerializer.gradient(stroke.strokeColorGradient) : null,
            colorRef: stroke.strokeColorRefId
                ? { id: stroke.strokeColorRefId, fileId: stroke.strokeColorRefFile ?? null }
                : null,
        };
    }

    private static shadow(shadow: Shadow): JsonObject {
        const r = NodeSerializer.round;
        return {
            style: shadow.style ?? "drop-shadow",
            offsetX: r(shadow.offsetX ?? 0),
            offsetY: r(shadow.offsetY ?? 0),
            blur: r(shadow.blur ?? 0),
            spread: r(shadow.spread ?? 0),
            hidden: Boolean(shadow.hidden),
            color: shadow.color ? NodeSerializer.color(shadow.color) : null,
        };
    }

    private static color(color: Color): JsonObject {
        return {
            color: color.color ?? null,
            opacity: NodeSerializer.round(color.opacity ?? 1),
            colorRef: color.refId ? { id: color.refId, fileId: color.refFile ?? null } : null,
        };
    }

    private static blur(blur: { value?: number; hidden?: boolean }): JsonObject {
        return { value: NodeSerializer.round(blur.value ?? 0), hidden: Boolean(blur.hidden) };
    }

    private static layout(board: Board): JsonObject | null {
        const flex = board.flex;
        const grid = board.grid;
        const common = flex ?? grid;
        const boardSizing = {
            horizontal: board.horizontalSizing ?? null,
            vertical: board.verticalSizing ?? null,
        };
        if (!common) {
            return { type: "none", clipContent: Boolean(board.clipContent), boardSizing };
        }
        const r = NodeSerializer.round;
        const result: JsonObject = {
            type: flex ? "flex" : "grid",
            clipContent: Boolean(board.clipContent),
            boardSizing,
            dir: common === flex ? flex!.dir : grid!.dir,
            wrap: flex ? (flex.wrap ?? null) : null,
            alignItems: common.alignItems ?? null,
            alignContent: common.alignContent ?? null,
            justifyItems: common.justifyItems ?? null,
            justifyContent: common.justifyContent ?? null,
            rowGap: r(common.rowGap ?? 0),
            columnGap: r(common.columnGap ?? 0),
            padding: {
                top: r(common.topPadding ?? 0),
                right: r(common.rightPadding ?? 0),
                bottom: r(common.bottomPadding ?? 0),
                left: r(common.leftPadding ?? 0),
            },
            horizontalSizing: common.horizontalSizing ?? null,
            verticalSizing: common.verticalSizing ?? null,
        };
        if (grid && !flex) {
            const track = (t: { type: string; value: number | null }) => ({ type: t.type, value: r(t.value) });
            result.rows = (grid.rows ?? []).map(track);
            result.columns = (grid.columns ?? []).map(track);
        }
        return result;
    }

    private static layoutChild(shape: Shape): JsonObject | null {
        const child = shape.layoutChild;
        if (!child) {
            return null;
        }
        const r = NodeSerializer.round;
        return {
            absolute: Boolean(child.absolute),
            zIndex: child.zIndex ?? 0,
            horizontalSizing: child.horizontalSizing ?? null,
            verticalSizing: child.verticalSizing ?? null,
            alignSelf: child.alignSelf ?? null,
            margin: {
                top: r(child.topMargin ?? 0),
                right: r(child.rightMargin ?? 0),
                bottom: r(child.bottomMargin ?? 0),
                left: r(child.leftMargin ?? 0),
            },
            minWidth: r(child.minWidth ?? null),
            maxWidth: r(child.maxWidth ?? null),
            minHeight: r(child.minHeight ?? null),
            maxHeight: r(child.maxHeight ?? null),
        };
    }

    private static layoutCell(shape: Shape): JsonObject | null {
        const cell = shape.layoutCell;
        if (!cell) {
            return null;
        }
        return {
            row: cell.row ?? null,
            rowSpan: cell.rowSpan ?? null,
            column: cell.column ?? null,
            columnSpan: cell.columnSpan ?? null,
            areaName: cell.areaName ?? null,
            position: cell.position ?? null,
        };
    }

    private static typographyValue(key: string, value: unknown): unknown {
        if (value === undefined) {
            return null;
        }
        if (NodeSerializer.NUMERIC_TYPOGRAPHY_KEYS.has(key) && typeof value === "string" && value !== "mixed") {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? NodeSerializer.round(parsed) : value;
        }
        return value;
    }

    private static typography(source: any): JsonObject {
        const result: JsonObject = {};
        for (const key of NodeSerializer.TYPOGRAPHY_KEYS) {
            result[key] = NodeSerializer.typographyValue(key, source[key]);
        }
        return result;
    }

    private static text(text: Text): JsonObject {
        const content = text.characters ?? "";
        const typography = NodeSerializer.typography(text);
        typography.align = text.align ?? null;
        typography.verticalAlign = text.verticalAlign ?? null;
        typography.direction = text.direction ?? null;
        return {
            content,
            growType: text.growType ?? null,
            typography,
            spans: NodeSerializer.spans(text, content, typography),
        };
    }

    /**
     * Computes text spans: maximal runs of characters sharing the same style.
     */
    private static spans(text: Text, content: string, typography: JsonObject): JsonObject[] {
        const isMixed =
            Object.values(typography).some((value) => value === "mixed") || (text.fills as unknown) === "mixed";
        const canSplit =
            isMixed && typeof text.getRange === "function" && content.length <= NodeSerializer.MAX_SPAN_TEXT_LENGTH;
        if (!canSplit) {
            return content.length === 0
                ? []
                : [NodeSerializer.span(0, content.length, content, typography, NodeSerializer.fills(text.fills))];
        }
        const spans: JsonObject[] = [];
        let current: { start: number; key: string; style: JsonObject; fills: unknown } | null = null;
        for (let i = 0; i < content.length; i++) {
            const range = text.getRange(i, i + 1);
            const style = NodeSerializer.typography(range);
            const fills = NodeSerializer.fills(range.fills);
            const key = JSON.stringify([style, fills]);
            if (current && current.key === key) {
                continue;
            }
            if (current) {
                spans.push(
                    NodeSerializer.span(current.start, i, content.slice(current.start, i), current.style, current.fills)
                );
            }
            current = { start: i, key, style, fills };
        }
        if (current) {
            spans.push(
                NodeSerializer.span(
                    current.start,
                    content.length,
                    content.slice(current.start),
                    current.style,
                    current.fills
                )
            );
        }
        return spans;
    }

    private static span(start: number, end: number, content: string, style: JsonObject, fills: unknown): JsonObject {
        const result: JsonObject = { start, end, text: content };
        for (const key of NodeSerializer.TYPOGRAPHY_KEYS) {
            result[key] = style[key] ?? null;
        }
        result.fills = fills;
        return result;
    }

    private static tokens(shape: Shape): JsonObject {
        const tokens = (shape.tokens ?? {}) as Record<string, string>;
        const result: JsonObject = {};
        for (const key of Object.keys(tokens).sort()) {
            result[key] = tokens[key];
        }
        return result;
    }

    private static component(shape: Shape): JsonObject | null {
        const s = shape as any;
        const call = (name: string): boolean => (typeof s[name] === "function" ? Boolean(s[name]()) : false);
        const isInstance = call("isComponentInstance");
        const isVariantContainer = shape.type === "board" && call("isVariantContainer");
        if (!isInstance && !isVariantContainer) {
            return null;
        }
        const component = isInstance && typeof s.component === "function" ? s.component() : null;
        const mainInstance =
            component && typeof component.mainInstance === "function" ? component.mainInstance() : null;
        const isVariant = component && typeof component.isVariant === "function" ? component.isVariant() : false;
        return {
            isInstance,
            isMainInstance: call("isComponentMainInstance"),
            isCopy: call("isComponentCopyInstance"),
            isRoot: call("isComponentRoot"),
            isVariantContainer,
            componentId: component ? component.id : null,
            componentName: component ? component.name : null,
            componentPath: component ? (component.path ?? null) : null,
            libraryId: component ? (component.libraryId ?? null) : null,
            mainInstanceId: mainInstance ? mainInstance.id : null,
            variantProps: isVariant ? NodeSerializer.sortedRecord(component.variantProps ?? {}) : null,
        };
    }

    private static sortedRecord(record: Record<string, unknown>): JsonObject {
        const result: JsonObject = {};
        for (const key of Object.keys(record).sort()) {
            result[key] = record[key];
        }
        return result;
    }

    /**
     * Serializes a prototype interaction.
     *
     * @param interaction - the interaction to serialize
     */
    public static interaction(interaction: Interaction): JsonObject {
        return {
            trigger: interaction.trigger,
            delay: interaction.delay ?? null,
            action: NodeSerializer.action(interaction.action),
        };
    }

    private static action(action: Action): JsonObject {
        const a = action as any;
        const destination: Shape | undefined = a.destination;
        const result: JsonObject = {
            type: action.type,
            destinationId: destination ? destination.id : null,
            destinationName: destination ? destination.name : null,
        };
        if (action.type === "open-url") {
            result.url = a.url ?? null;
        }
        if (action.type === "navigate-to") {
            result.preserveScrollPosition = Boolean(a.preserveScrollPosition);
        }
        if (action.type === "open-overlay" || action.type === "toggle-overlay") {
            result.position = a.position ?? null;
            result.relativeToId = a.relativeTo ? a.relativeTo.id : null;
            result.closeWhenClickOutside = Boolean(a.closeWhenClickOutside);
            result.addBackgroundOverlay = Boolean(a.addBackgroundOverlay);
        }
        result.animation = a.animation ? NodeSerializer.sortedRecord(a.animation) : null;
        return result;
    }
}
