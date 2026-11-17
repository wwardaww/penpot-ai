import { z } from "zod";

/**
 * Zod schemas shared by the Penforge typed tools.
 *
 * Mutation values use the same shape as the snapshot returned by `get_node_properties`, so a value
 * read from a snapshot can be written back unchanged. All objects are strict: unknown keys are
 * rejected with an error naming the key.
 */
export class PenforgeSchemas {
    static readonly NODE_ID = z.string().min(1, "nodeId cannot be empty").max(128);

    static readonly PAGE_ID = z.string().min(1).max(128);

    static readonly HEX_COLOR = z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "colors must be 6-digit hex strings such as #1A2B3C");

    static readonly UNIT = z.number().min(0).max(1);

    static readonly GRADIENT = z.strictObject({
        type: z.enum(["linear", "radial"]),
        startX: z.number(),
        startY: z.number(),
        endX: z.number(),
        endY: z.number(),
        width: z.number(),
        stops: z
            .array(
                z.strictObject({
                    color: PenforgeSchemas.HEX_COLOR,
                    opacity: PenforgeSchemas.UNIT.optional(),
                    offset: PenforgeSchemas.UNIT,
                })
            )
            .min(2),
    });

    static readonly FILL = z.strictObject({
        color: PenforgeSchemas.HEX_COLOR.optional(),
        opacity: PenforgeSchemas.UNIT.optional(),
        gradient: PenforgeSchemas.GRADIENT.optional(),
    });

    static readonly STROKE_CAP = z.enum([
        "round",
        "square",
        "line-arrow",
        "triangle-arrow",
        "square-marker",
        "circle-marker",
        "diamond-marker",
    ]);

    static readonly STROKE = z.strictObject({
        color: PenforgeSchemas.HEX_COLOR.optional(),
        opacity: PenforgeSchemas.UNIT.optional(),
        style: z.enum(["solid", "dotted", "dashed", "mixed", "none"]).optional(),
        width: z.number().min(0).optional(),
        alignment: z.enum(["center", "inner", "outer"]).optional(),
        capStart: PenforgeSchemas.STROKE_CAP.optional(),
        capEnd: PenforgeSchemas.STROKE_CAP.optional(),
    });

    static readonly SIDES = z.strictObject({
        top: z.number().optional(),
        right: z.number().optional(),
        bottom: z.number().optional(),
        left: z.number().optional(),
    });

    static readonly RADIUS = z.union([
        z.number().min(0),
        z.strictObject({
            all: z.number().min(0).optional(),
            topLeft: z.number().min(0).optional(),
            topRight: z.number().min(0).optional(),
            bottomRight: z.number().min(0).optional(),
            bottomLeft: z.number().min(0).optional(),
        }),
    ]);

    static readonly LAYOUT = z.strictObject({
        type: z
            .enum(["flex", "grid", "none"])
            .optional()
            .describe("Adds, replaces or removes the board layout; omit to keep the current one."),
        dir: z.enum(["row", "row-reverse", "column", "column-reverse"]).optional(),
        wrap: z.enum(["wrap", "nowrap"]).optional(),
        alignItems: z.enum(["start", "end", "center", "stretch"]).optional(),
        alignContent: z
            .enum(["start", "end", "center", "space-between", "space-around", "space-evenly", "stretch"])
            .optional(),
        justifyItems: z.enum(["start", "end", "center", "stretch"]).optional(),
        justifyContent: z
            .enum(["start", "center", "end", "space-between", "space-around", "space-evenly", "stretch"])
            .optional(),
        rowGap: z.number().min(0).optional(),
        columnGap: z.number().min(0).optional(),
        padding: PenforgeSchemas.SIDES.optional(),
        horizontalSizing: z.enum(["fix", "fill", "auto"]).optional(),
        verticalSizing: z.enum(["fix", "fill", "auto"]).optional(),
    });

    static readonly LAYOUT_CHILD = z.strictObject({
        absolute: z.boolean().optional(),
        zIndex: z.number().int().optional(),
        horizontalSizing: z.enum(["auto", "fill", "fix"]).optional(),
        verticalSizing: z.enum(["auto", "fill", "fix"]).optional(),
        alignSelf: z.enum(["auto", "start", "center", "end", "stretch"]).optional(),
        margin: PenforgeSchemas.SIDES.optional(),
        minWidth: z.number().min(0).nullable().optional(),
        maxWidth: z.number().min(0).nullable().optional(),
        minHeight: z.number().min(0).nullable().optional(),
        maxHeight: z.number().min(0).nullable().optional(),
    });

    /**
     * Whitelisted mutations of `update_design_node`.
     */
    static readonly MUTATIONS = z
        .strictObject({
            name: z.string().min(1).max(250).optional(),
            text: z.string().min(1).optional().describe("New content of a text node (text nodes only)."),
            fills: z.array(PenforgeSchemas.FILL).optional().describe("Replaces all fills."),
            strokes: z.array(PenforgeSchemas.STROKE).optional().describe("Replaces all strokes."),
            x: z.number().optional().describe("Absolute x position on the page."),
            y: z.number().optional().describe("Absolute y position on the page."),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
            visible: z.boolean().optional(),
            opacity: PenforgeSchemas.UNIT.optional(),
            radius: PenforgeSchemas.RADIUS.optional().describe(
                "Corner radius: one number for all corners or per-corner values."
            ),
            layout: PenforgeSchemas.LAYOUT.optional().describe("Flex/grid layout of a board (boards only)."),
            layoutChild: PenforgeSchemas.LAYOUT_CHILD.optional().describe(
                "Sizing and margins of a child inside a flex/grid board."
            ),
            tokens: z
                .record(z.string().min(1), z.string().min(1))
                .optional()
                .describe("Applies design tokens: map of token property (e.g. 'fill', 'r1') to token name."),
        })
        .refine((value) => Object.keys(value).length > 0, { message: "mutations must contain at least one key" });
}
