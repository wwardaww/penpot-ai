import type { Page, Shape } from "@penpot/plugin-types";
import {
    ANIMATION_KEY,
    ANIMATION_NAMESPACE,
    ANIMATION_VERSION,
    AnimationReader,
    encodeAnimationSpec,
    normalizeAnimationSpec,
    validateAnimationSpec,
} from "./animations.ts";
import type { AnimationSpec, Easing, SmartAnimate } from "./animations.ts";
import type { JsonObject } from "./serialize.ts";

/** Sections of a spec that `set` / `update` take. */
const SECTIONS = ["entrance", "exit", "states", "loop"] as const;

/** Parts of a spec that `remove` takes. */
const REMOVABLE = ["entrance", "exit", "states", "hover", "press", "loop", "smart"] as const;

/** Interaction actions that lead to a board, so smart animate can apply. */
const SMART_ACTIONS = ["navigate-to", "open-overlay", "toggle-overlay"];

type Section = (typeof SECTIONS)[number];
type Removable = (typeof REMOVABLE)[number];

/**
 * One operation of the `update_animations` tool.
 *
 * - `set` replaces the given sections (a `null` section removes it) and keeps the others.
 * - `update` merges the given fields into the stored sections (objects merge, arrays and values
 *   replace, a `null` field removes that field).
 * - `remove` removes the listed parts, or the whole spec when `sections` is missing.
 * - `set-smart` / `remove-smart` turn smart animate on or off for the interaction `index` of the
 *   layer (it must lead to a board).
 */
export type AnimationOperation =
    | ({ op: "set" | "update"; nodeId: string } & Partial<Record<Section, unknown>>)
    | { op: "remove"; nodeId: string; sections?: Removable[] }
    | { op: "set-smart"; nodeId: string; index: number; duration?: number; easing?: Easing }
    | { op: "remove-smart"; nodeId: string; index: number };

/** Result of one changed layer. */
interface LayerChange {
    shape: Shape;
    before: string | null;
    spec: AnimationSpec;
    ops: Set<string>;
    warnings: Set<string>;
}

/**
 * Writes the animation specs (W31 shared plugin data `penforge` / `animations`) of the layers of
 * one page.
 *
 * All operations are checked, applied to copies of the specs and validated against the W31
 * schema before the first change, so a bad operation leaves the file untouched. Several
 * operations on one layer add up; each changed layer is written once.
 */
export class AnimationWriter {
    private readonly page: Page;
    private readonly changes = new Map<string, LayerChange>();

    /**
     * @param page - the active page all operations apply to
     */
    constructor(page: Page) {
        this.page = page;
    }

    /**
     * Checks the shape of the operations without touching the file. Throws on the first problem.
     *
     * @param operations - the operations to check
     */
    public static validate(operations: unknown): asserts operations is AnimationOperation[] {
        if (!Array.isArray(operations) || operations.length === 0) {
            throw new Error("operations must be a non-empty array");
        }
        operations.forEach((raw, i) => {
            const op: any = raw;
            const where = `operations[${i}]`;
            if (!op || typeof op !== "object" || Array.isArray(op)) {
                throw new Error(`${where} must be an object`);
            }
            if (typeof op.nodeId !== "string" || op.nodeId.length === 0) {
                throw new Error(`${where}.nodeId must be a non-empty string`);
            }
            switch (op.op) {
                case "set":
                case "update": {
                    AnimationWriter.onlyKeys(op, ["op", "nodeId", ...SECTIONS], where);
                    const given = SECTIONS.filter((key) => op[key] !== undefined);
                    if (given.length === 0) {
                        throw new Error(`${where} needs at least one of ${SECTIONS.join(", ")}`);
                    }
                    for (const key of given) {
                        const value = op[key];
                        if (value !== null && !AnimationWriter.isObject(value)) {
                            throw new Error(`${where}.${key} must be an object or null`);
                        }
                    }
                    break;
                }
                case "remove":
                    AnimationWriter.onlyKeys(op, ["op", "nodeId", "sections"], where);
                    if (op.sections !== undefined) {
                        if (!Array.isArray(op.sections) || op.sections.length === 0) {
                            throw new Error(`${where}.sections must be a non-empty array`);
                        }
                        for (const section of op.sections) {
                            if (!REMOVABLE.includes(section)) {
                                throw new Error(`${where}.sections items must be one of ${REMOVABLE.join(", ")}`);
                            }
                        }
                    }
                    break;
                case "set-smart":
                case "remove-smart":
                    AnimationWriter.onlyKeys(
                        op,
                        op.op === "set-smart"
                            ? ["op", "nodeId", "index", "duration", "easing"]
                            : ["op", "nodeId", "index"],
                        where
                    );
                    if (!Number.isInteger(op.index) || op.index < 0) {
                        throw new Error(`${where}.index must be an integer >= 0`);
                    }
                    break;
                default:
                    throw new Error(
                        `${where}.op must be one of set, update, remove, set-smart, remove-smart ` +
                            `(got ${JSON.stringify(op.op)})`
                    );
            }
        });
    }

    /**
     * Returns the ids of the layers the operations change, first appearance first.
     *
     * @param operations - validated operations
     */
    public static referencedIds(operations: AnimationOperation[]): string[] {
        return [...new Set(operations.map((op) => op.nodeId))];
    }

    /**
     * Applies the operations to copies of the stored specs and validates the results. Throws
     * before any change when an operation does not fit its layer or gives an invalid spec.
     *
     * @param operations - validated operations
     */
    public prepare(operations: AnimationOperation[]): void {
        operations.forEach((op, i) => {
            const where = `operations[${i}]`;
            const change = this.change(op.nodeId, where);
            change.spec = this.applyOne(change, op, where);
            change.ops.add(op.op);
            const normalized = normalizeAnimationSpec(change.spec);
            const result = validateAnimationSpec(normalized);
            if (!result.ok) {
                throw new Error(`${where} (${change.shape.name}): ${result.errors.join("; ")}`);
            }
            change.spec = normalized;
        });
    }

    /**
     * Writes the prepared specs and returns one result per layer, in the order of first use.
     */
    public write(): JsonObject[] {
        const results: JsonObject[] = [];
        for (const change of this.changes.values()) {
            const encoded = encodeAnimationSpec(change.spec);
            const stored = encoded ?? "";
            let status: string;
            if ((change.before ?? "") === stored) {
                status = "unchanged";
            } else {
                change.shape.setSharedPluginData(ANIMATION_NAMESPACE, ANIMATION_KEY, stored);
                status = encoded === null ? "removed" : "set";
            }
            const result: JsonObject = {
                nodeId: change.shape.id,
                name: change.shape.name,
                type: change.shape.type,
                status,
                animations: encoded === null ? null : (JSON.parse(encoded) as JsonObject),
            };
            if (change.warnings.size > 0) {
                result.warnings = [...change.warnings];
            }
            results.push(result);
        }
        return results;
    }

    private change(nodeId: string, where: string): LayerChange {
        const existing = this.changes.get(nodeId);
        if (existing) {
            return existing;
        }
        const shape = this.page.getShapeById(nodeId);
        if (!shape) {
            throw new Error(
                `${where}.nodeId: node ${nodeId} is not on page "${this.page.name}" (one call changes one page)`
            );
        }
        const before = AnimationReader.raw(shape);
        // an invalid stored value is ignored by the players; it is replaced on write
        const spec = AnimationReader.read(shape) ?? { v: ANIMATION_VERSION };
        const change: LayerChange = { shape, before, spec, ops: new Set(), warnings: new Set() };
        if (before !== null && AnimationReader.read(shape) === null) {
            change.warnings.add("the stored animation was not valid and was replaced");
        }
        this.changes.set(nodeId, change);
        return change;
    }

    private applyOne(change: LayerChange, op: AnimationOperation, where: string): AnimationSpec {
        // plain JSON data; the plugin sandbox may lack structuredClone
        const spec: any = JSON.parse(JSON.stringify(change.spec));
        switch (op.op) {
            case "set":
            case "update":
                for (const key of SECTIONS) {
                    const value = (op as any)[key];
                    if (value === undefined) {
                        continue;
                    }
                    if (value === null) {
                        delete spec[key];
                    } else if (op.op === "set" || spec[key] === undefined) {
                        spec[key] = AnimationWriter.withoutNulls(value);
                    } else {
                        spec[key] = AnimationWriter.merge(spec[key], value);
                    }
                }
                this.warn(change, spec);
                return spec;
            case "remove": {
                if (op.sections === undefined) {
                    return { v: ANIMATION_VERSION };
                }
                for (const section of op.sections) {
                    if (section === "hover" || section === "press") {
                        if (spec.states) {
                            delete spec.states[section];
                        }
                    } else {
                        delete spec[section];
                    }
                }
                return spec;
            }
            case "set-smart": {
                const destination = this.smartDestination(change.shape, op.index, where);
                const entry: SmartAnimate = { index: op.index, destination };
                if (op.duration !== undefined) {
                    entry.duration = op.duration;
                }
                if (op.easing !== undefined) {
                    entry.easing = op.easing;
                }
                const others = (spec.smart ?? []).filter((s: SmartAnimate) => s.index !== op.index);
                spec.smart = [...others, entry].sort((a: SmartAnimate, b: SmartAnimate) => a.index - b.index);
                return spec;
            }
            case "remove-smart":
                if (spec.smart) {
                    spec.smart = spec.smart.filter((s: SmartAnimate) => s.index !== op.index);
                }
                return spec;
        }
    }

    private smartDestination(shape: Shape, index: number, where: string): string {
        const interactions = shape.interactions ?? [];
        const interaction: any = interactions[index];
        if (!interaction) {
            throw new Error(
                `${where}.index: ${shape.name} has no interaction at index ${index} (it has ${interactions.length}); ` +
                    "add the link with update_prototype first"
            );
        }
        const type = interaction.action?.type;
        const destination = interaction.action?.destination?.id;
        if (!SMART_ACTIONS.includes(type) || typeof destination !== "string") {
            throw new Error(
                `${where}.index: interaction ${index} of ${shape.name} is ${JSON.stringify(type)}; smart animate ` +
                    `needs one of ${SMART_ACTIONS.join(", ")} with a destination board`
            );
        }
        return destination;
    }

    /** Notes about parts the players ignore on this layer. */
    private warn(change: LayerChange, spec: any): void {
        const shape: any = change.shape;
        const children: unknown[] = Array.isArray(shape.children) ? shape.children : [];
        for (const key of ["entrance", "exit"]) {
            if (spec[key]?.stagger && children.length === 0) {
                change.warnings.add(
                    `${key}.stagger animates the children one after the other, but this layer has none`
                );
            }
        }
        if (shape.type === "text" && (spec.states?.hover?.fill || spec.states?.press?.fill)) {
            change.warnings.add("text layers ignore states.fill (use opacity, scale or offset)");
        }
    }

    private static merge(base: unknown, patch: unknown): unknown {
        if (!AnimationWriter.isObject(base) || !AnimationWriter.isObject(patch)) {
            return AnimationWriter.withoutNulls(patch);
        }
        const out: Record<string, unknown> = { ...base };
        for (const [key, value] of Object.entries(patch)) {
            if (value === null) {
                delete out[key];
            } else if (value !== undefined) {
                out[key] = AnimationWriter.merge(out[key], value);
            }
        }
        return out;
    }

    private static withoutNulls(value: unknown): unknown {
        if (!AnimationWriter.isObject(value)) {
            return value;
        }
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            if (item !== null && item !== undefined) {
                out[key] = AnimationWriter.withoutNulls(item);
            }
        }
        return out;
    }

    private static isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    private static onlyKeys(op: Record<string, unknown>, allowed: readonly string[], where: string): void {
        for (const key of Object.keys(op)) {
            if (!allowed.includes(key)) {
                throw new Error(`${where}.${key}: unknown key for op ${JSON.stringify(op.op)}`);
            }
        }
    }
}
