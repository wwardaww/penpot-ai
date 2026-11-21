import { createHash } from "crypto";
import { z } from "zod";

/**
 * One layer of a board, reduced to the facts a change request names. Every property is a short
 * fingerprint string, so two states compare with `===`; a property bound to a design token holds
 * the token name (`token:color.primary`), so a token value change does not show as a change of
 * every layer that uses it.
 */
export const LayerStateSchema = z.object({
    name: z.string(),
    type: z.string(),
    parentId: z.string().nullable(),
    visible: z.boolean(),
    /** text content of a text layer */
    text: z.string().nullable().default(null),
    /** font family, size and weight of a text layer */
    typography: z.string().default(""),
    fills: z.string().default(""),
    strokes: z.string().default(""),
    /** image ids of the fills */
    images: z.string().default(""),
    /** flex/grid layout of a board: direction, gaps, padding, alignment */
    layout: z.string().default(""),
    /** rounded width × height */
    size: z.string().default(""),
    /** component of an instance (`<library>/<name>`) */
    component: z.string().default(""),
    /** hash of the layer's animation spec (W31 shared plugin data `penforge/animations`) */
    animation: z.string().default(""),
});

export type LayerState = z.infer<typeof LayerStateSchema>;

/** Top-level board (screen) of the design with its layers. */
export const BoardStateSchema = z.object({
    name: z.string(),
    pageName: z.string().default(""),
    size: z.string().default(""),
    /** layers by id, the board itself included */
    layers: z.record(z.string(), LayerStateSchema),
    /** layers left out because the board is very large */
    truncated: z.boolean().default(false),
});

export type BoardState = z.infer<typeof BoardStateSchema>;

/** Navigation edge of the prototype. */
export const EdgeStateSchema = z.object({
    from: z.string(),
    to: z.string(),
    trigger: z.string(),
    sourceName: z.string(),
});

export type EdgeState = z.infer<typeof EdgeStateSchema>;

/** State of the design at one moment: what a change request compares. */
export const DesignStateSchema = z.object({
    schemaVersion: z.literal(1),
    fileId: z.string(),
    /** Penpot file revision (`File.revn`), changes with every saved change */
    revn: z.number(),
    readAt: z.string(),
    boards: z.record(z.string(), BoardStateSchema),
    /** resolved value of every token of the active sets, by name */
    tokens: z.record(z.string(), z.string()),
    edges: z.array(EdgeStateSchema),
    /** prototype flows: name → starting board id */
    flows: z.record(z.string(), z.string()),
    /** connected shared libraries (the design system), sorted by name */
    libraries: z.array(z.object({ id: z.string(), name: z.string() })),
});

export type DesignState = z.infer<typeof DesignStateSchema>;

/** Hashes of a design state, recorded with each build. */
export interface DesignHashes {
    tokensHash: string;
    prototypeHash: string;
    animationsHash: string;
    designSystemHash: string;
}

/**
 * Helpers of {@link DesignState}: hashes and parsing.
 */
export class DesignStates {
    /** Parses a stored state; null when it is missing or invalid. */
    public static parse(value: unknown): DesignState | null {
        const parsed = DesignStateSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
    }

    /** Hashes of the parts of a state that the build record keeps. */
    public static hashes(state: DesignState): DesignHashes {
        const animations: string[] = [];
        for (const boardId of Object.keys(state.boards).sort()) {
            const layers = state.boards[boardId].layers;
            for (const layerId of Object.keys(layers).sort()) {
                if (layers[layerId].animation) {
                    animations.push(`${layerId}:${layers[layerId].animation}`);
                }
            }
        }
        const sortedTokens = Object.keys(state.tokens)
            .sort()
            .map((name) => `${name}=${state.tokens[name]}`);
        const edges = state.edges.map((e) => `${e.from}>${e.to}:${e.trigger}:${e.sourceName}`).sort();
        const flows = Object.keys(state.flows)
            .sort()
            .map((name) => `${name}@${state.flows[name]}`);
        return {
            tokensHash: DesignStates.hash(sortedTokens),
            prototypeHash: DesignStates.hash([...edges, "--", ...flows]),
            animationsHash: DesignStates.hash(animations),
            designSystemHash: DesignStates.hash(state.libraries.map((library) => library.id)),
        };
    }

    private static hash(lines: string[]): string {
        return createHash("sha256").update(lines.join("\n")).digest("hex");
    }
}
