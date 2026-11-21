import { z } from "zod";
import { PenforgeSchemas } from "./PenforgeSchemas";

/**
 * Zod schemas of the animation tools (W32): the shape of the W31 animation spec
 * (architecture §8 "Layer animations"), with every field optional and nullable so that `update`
 * operations can send only what changes and remove a field with `null`.
 *
 * Only structure and names are checked here; ranges and required fields are checked by the
 * plugin against the W31 schema (`mcp/packages/plugin/src/penforge/animations.ts`), the single
 * source of truth, before the first change.
 */
export class AnimationSchemas {
    static readonly EASING = z
        .union([
            z.enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]),
            z.strictObject({
                type: z.literal("spring"),
                stiffness: z.number().optional(),
                damping: z.number().optional(),
                mass: z.number().optional(),
            }),
        ])
        .describe('A name ("ease-out" for entrances, "ease-in" for exits) or {type:"spring"}.');

    static readonly EFFECT = z.strictObject({
        type: z.enum(["fade", "slide", "scale", "blur"]),
        direction: z.enum(["up", "down", "left", "right"]).optional().describe("slide only"),
        distance: z.number().optional().describe("slide distance in px (default 24)"),
        from: z.number().optional().describe("scale start factor (default 0.8)"),
        amount: z.number().optional().describe("blur radius in px (default 8)"),
    });

    static readonly TRACK = z.strictObject({
        prop: z.enum(["opacity", "translateX", "translateY", "scale", "rotate", "blur", "fill"]),
        keyframes: z
            .array(
                z.strictObject({
                    at: z.number().describe("0..1 position in the motion"),
                    value: z.union([z.number(), z.string()]).describe('a number, or "#rrggbb" for fill'),
                    easing: AnimationSchemas.EASING.optional(),
                })
            )
            .min(1),
    });

    /** Entrance or exit. */
    static readonly MOTION = z.strictObject({
        effects: z.array(AnimationSchemas.EFFECT).max(4).nullable().optional(),
        tracks: z
            .array(AnimationSchemas.TRACK)
            .max(16)
            .nullable()
            .optional()
            .describe("free keyframes; replace `effects` when present (rarely needed)"),
        duration: z.number().optional().describe("ms; required for a new entrance/exit"),
        delay: z.number().nullable().optional().describe("ms"),
        easing: AnimationSchemas.EASING.nullable().optional(),
        stagger: z
            .strictObject({
                each: z.number().optional().describe("ms between two children"),
                from: z.enum(["first", "last", "center"]).optional(),
            })
            .nullable()
            .optional()
            .describe("animate the direct children one after the other instead of the layer itself"),
    });

    static readonly STATE = z.strictObject({
        opacity: z.number().nullable().optional().describe("absolute opacity 0..1"),
        scale: z.number().nullable().optional(),
        offsetX: z.number().nullable().optional(),
        offsetY: z.number().nullable().optional(),
        fill: PenforgeSchemas.HEX_COLOR.nullable().optional(),
        shadow: z
            .strictObject({
                offsetX: z.number().optional(),
                offsetY: z.number().optional(),
                blur: z.number().optional(),
                spread: z.number().optional(),
                color: PenforgeSchemas.HEX_COLOR.optional(),
                opacity: z.number().optional(),
            })
            .nullable()
            .optional(),
        duration: z.number().nullable().optional().describe("ms"),
        easing: AnimationSchemas.EASING.nullable().optional(),
    });

    static readonly STATES = z.strictObject({
        hover: AnimationSchemas.STATE.nullable().optional(),
        press: AnimationSchemas.STATE.nullable().optional(),
    });

    static readonly LOOP = z.strictObject({
        type: z.enum(["pulse", "spin", "bounce", "shimmer"]).optional().describe("required for a new loop"),
        duration: z.number().nullable().optional().describe("ms of one run"),
        count: z
            .union([z.number().int(), z.literal("infinite")])
            .nullable()
            .optional()
            .describe('runs, or "infinite" (default)'),
        delay: z.number().nullable().optional(),
        easing: AnimationSchemas.EASING.nullable().optional(),
        intensity: z.number().nullable().optional(),
    });

    private static readonly SECTIONS = {
        nodeId: PenforgeSchemas.NODE_ID,
        entrance: AnimationSchemas.MOTION.nullable().optional(),
        exit: AnimationSchemas.MOTION.nullable().optional(),
        states: AnimationSchemas.STATES.nullable().optional(),
        loop: AnimationSchemas.LOOP.nullable().optional(),
    };

    /** One operation of `update_animations`. */
    static readonly OPERATION = z.discriminatedUnion("op", [
        z
            .strictObject({ op: z.literal("set"), ...AnimationSchemas.SECTIONS })
            .describe("Replace the given sections (null removes one); other sections stay."),
        z
            .strictObject({ op: z.literal("update"), ...AnimationSchemas.SECTIONS })
            .describe("Merge the given fields into the stored sections; a null field removes it."),
        z
            .strictObject({
                op: z.literal("remove"),
                nodeId: PenforgeSchemas.NODE_ID,
                sections: z
                    .array(z.enum(["entrance", "exit", "states", "hover", "press", "loop", "smart"]))
                    .min(1)
                    .optional()
                    .describe("Parts to remove; the whole animation when omitted."),
            })
            .describe("Remove animations of the layer."),
        z
            .strictObject({
                op: z.literal("set-smart"),
                nodeId: PenforgeSchemas.NODE_ID,
                index: z.number().int().min(0).describe("Position in the layer's `interactions` list."),
                duration: z.number().optional().describe("ms (default 300)"),
                easing: AnimationSchemas.EASING.optional(),
            })
            .describe(
                "Smart animate the layer's navigate/overlay interaction: layers with the same name move from " +
                    "screen A to screen B."
            ),
        z
            .strictObject({
                op: z.literal("remove-smart"),
                nodeId: PenforgeSchemas.NODE_ID,
                index: z.number().int().min(0),
            })
            .describe("Turn smart animate off for that interaction."),
    ]);
}
