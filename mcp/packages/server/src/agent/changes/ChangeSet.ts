import { z } from "zod";

/**
 * Codes of the change items. Clients translate an item by its code and params; `text` is the
 * English fallback (the daemon never sends translated copy).
 */
export const CHANGE_CODES = [
    "text-changed",
    "layer-added",
    "layer-removed",
    "layer-renamed",
    "fill-changed",
    "stroke-changed",
    "typography-changed",
    "layout-changed",
    "size-changed",
    "component-swapped",
    "image-changed",
    "visibility-changed",
    "animation-changed",
    "navigation-added",
    "navigation-removed",
    "design-changed",
    "token-added",
    "token-removed",
    "token-changed",
    "flow-added",
    "flow-removed",
    "flow-start-changed",
    "design-system-changed",
] as const;

export type ChangeCode = (typeof CHANGE_CODES)[number];

/** One change, in plain words. */
export const ChangeItemSchema = z.object({
    code: z.enum(CHANGE_CODES),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    text: z.string(),
});

export type ChangeItem = z.infer<typeof ChangeItemSchema>;

/** Changes of one screen (top-level board). */
export const ScreenChangeSchema = z.object({
    boardId: z.string(),
    name: z.string(),
    /** `renamed` only when the name is the one change */
    status: z.enum(["added", "removed", "renamed", "changed"]),
    previousName: z.string().optional(),
    items: z.array(ChangeItemSchema),
    /** items left out of `items` because the list is long */
    more: z.number().int().min(0).default(0),
});

export type ScreenChange = z.infer<typeof ScreenChangeSchema>;

/** Everything that changed in the design since a build. */
export const ChangeSetSchema = z.object({
    screens: z.array(ScreenChangeSchema),
    tokens: z.array(ChangeItemSchema),
    flows: z.array(ChangeItemSchema),
    designSystem: ChangeItemSchema.nullable(),
    /** entries of the list the user sees: one per screen, token, flow and design system change */
    count: z.number().int().min(0),
    /** only design tokens changed (the theme can follow without a Claude turn) */
    tokenOnly: z.boolean(),
    /**
     * `state`: compared with the design state saved with the build (detailed items);
     * `hashes`: no saved state (build made before change requests), compared by board hashes
     */
    baseline: z.enum(["state", "hashes"]),
});

export type ChangeSet = z.infer<typeof ChangeSetSchema>;

/** Builder of a {@link ChangeSet}: keeps `count` and `tokenOnly` consistent. */
export class ChangeSets {
    /** An empty change set. */
    public static empty(baseline: ChangeSet["baseline"] = "state"): ChangeSet {
        return ChangeSets.of([], [], [], null, baseline);
    }

    /** A change set from its parts. */
    public static of(
        screens: ScreenChange[],
        tokens: ChangeItem[],
        flows: ChangeItem[],
        designSystem: ChangeItem | null,
        baseline: ChangeSet["baseline"]
    ): ChangeSet {
        const count = screens.length + tokens.length + flows.length + (designSystem ? 1 : 0);
        return {
            screens,
            tokens,
            flows,
            designSystem,
            count,
            tokenOnly: tokens.length > 0 && count === tokens.length,
            baseline,
        };
    }

    /** One item. */
    public static item(code: ChangeCode, params: ChangeItem["params"], text: string): ChangeItem {
        return { code, params, text };
    }
}
