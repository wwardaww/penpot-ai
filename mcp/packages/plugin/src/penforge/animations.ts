import type { Shape } from "@penpot/plugin-types";

/**
 * Penforge layer animations (W31): the spec each layer keeps in its shared plugin data
 * `penforge` / `animations` (a JSON string), and plugin-side read helpers.
 *
 * Mirror of the frontend schema `app.main.animations.spec` (`frontend/src/app/main/animations/
 * spec.cljs`); both must accept exactly the same documents. W32 builds its MCP tools and
 * `animations-write.ts` on these helpers.
 */

export const ANIMATION_NAMESPACE = "penforge";
export const ANIMATION_KEY = "animations";
export const ANIMATION_VERSION = 1;

export const EASING_NAMES = ["linear", "ease", "ease-in", "ease-out", "ease-in-out"] as const;
export const DIRECTIONS = ["up", "down", "left", "right"] as const;
export const EFFECT_TYPES = ["fade", "slide", "scale", "blur"] as const;
export const LOOP_TYPES = ["pulse", "spin", "bounce", "shimmer"] as const;
export const TRACK_PROPS = ["opacity", "translateX", "translateY", "scale", "rotate", "blur", "fill"] as const;
export const STAGGER_ORIGINS = ["first", "last", "center"] as const;

export type EasingName = (typeof EASING_NAMES)[number];
export interface SpringEasing {
    type: "spring";
    stiffness?: number;
    damping?: number;
    mass?: number;
}
export type Easing = EasingName | SpringEasing;

export interface Effect {
    type: (typeof EFFECT_TYPES)[number];
    /** slide only */
    direction?: (typeof DIRECTIONS)[number];
    /** slide distance in px (default 24) */
    distance?: number;
    /** scale start factor (default 0.8) */
    from?: number;
    /** blur radius in px (default 8) */
    amount?: number;
}

export interface Keyframe {
    /** 0..1 position in the motion */
    at: number;
    /** number, or "#rrggbb" for `fill` */
    value: number | string;
    easing?: Easing;
}

export interface Track {
    prop: (typeof TRACK_PROPS)[number];
    keyframes: Keyframe[];
}

export interface Motion {
    effects?: Effect[];
    /** free keyframes; when present they replace `effects` */
    tracks?: Track[];
    /** ms; springs use their own settle time */
    duration: number;
    delay?: number;
    easing?: Easing;
    /** animate the direct children one after the other instead of the layer */
    stagger?: { each: number; from?: (typeof STAGGER_ORIGINS)[number] };
}

export interface ShadowValue {
    offsetX?: number;
    offsetY?: number;
    blur?: number;
    spread?: number;
    color?: string;
    opacity?: number;
}

export interface StateSpec {
    /** absolute opacity 0..1 */
    opacity?: number;
    scale?: number;
    offsetX?: number;
    offsetY?: number;
    fill?: string;
    shadow?: ShadowValue;
    duration?: number;
    easing?: Easing;
}

export interface LoopSpec {
    type: (typeof LOOP_TYPES)[number];
    duration?: number;
    /** number of runs, or "infinite" (default) */
    count?: number | "infinite";
    delay?: number;
    easing?: Easing;
    intensity?: number;
}

export interface SmartAnimate {
    /** index of the interaction in `shape.interactions` */
    index: number;
    /** destination board id when the option was set; ignored if it no longer matches */
    destination?: string | null;
    duration?: number;
    easing?: Easing;
}

export interface AnimationSpec {
    v: 1;
    entrance?: Motion;
    exit?: Motion;
    states?: { hover?: StateSpec; press?: StateSpec };
    loop?: LoopSpec;
    smart?: SmartAnimate[];
}

export type ValidationResult = { ok: true; spec: AnimationSpec } | { ok: false; errors: string[] };

const COLOR = /^#[0-9a-fA-F]{6}$/;

type Check = (value: unknown, path: string, errors: string[]) => void;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(min: number, max: number, exclusiveMin = false): Check {
    return (value, path, errors) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            errors.push(`${path}: expected a number`);
        } else if ((exclusiveMin ? value <= min : value < min) || value > max) {
            errors.push(`${path}: expected ${exclusiveMin ? ">" : ">="} ${min} and <= ${max}`);
        }
    };
}

function anyNumber(): Check {
    return (value, path, errors) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            errors.push(`${path}: expected a number`);
        }
    };
}

function int(min: number, max: number): Check {
    return (value, path, errors) => {
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
            errors.push(`${path}: expected an integer from ${min} to ${max}`);
        }
    };
}

function oneOf(values: readonly string[]): Check {
    return (value, path, errors) => {
        if (typeof value !== "string" || !values.includes(value)) {
            errors.push(`${path}: expected one of ${values.join(", ")}`);
        }
    };
}

const color: Check = (value, path, errors) => {
    if (typeof value !== "string" || !COLOR.test(value)) {
        errors.push(`${path}: expected a color "#rrggbb"`);
    }
};

function closedMap(fields: Record<string, { check: Check; optional?: boolean }>): Check {
    return (value, path, errors) => {
        if (!isObject(value)) {
            errors.push(`${path}: expected an object`);
            return;
        }
        for (const key of Object.keys(value)) {
            if (!(key in fields)) {
                errors.push(`${path}.${key}: unknown key`);
            }
        }
        for (const [key, { check, optional }] of Object.entries(fields)) {
            if (value[key] === undefined) {
                if (!optional) {
                    errors.push(`${path}.${key}: required`);
                }
            } else {
                check(value[key], `${path}.${key}`, errors);
            }
        }
    };
}

function vector(item: Check, min: number, max: number): Check {
    return (value, path, errors) => {
        if (!Array.isArray(value)) {
            errors.push(`${path}: expected an array`);
            return;
        }
        if (value.length < min || value.length > max) {
            errors.push(`${path}: expected ${min} to ${max} items`);
        }
        value.forEach((v, i) => item(v, `${path}[${i}]`, errors));
    };
}

function either(a: Check, b: Check, message: string): Check {
    return (value, path, errors) => {
        const ea: string[] = [];
        a(value, path, ea);
        if (ea.length === 0) {
            return;
        }
        const eb: string[] = [];
        b(value, path, eb);
        if (eb.length === 0) {
            return;
        }
        errors.push(`${path}: ${message}`);
    };
}

const duration = num(0, 20000);

const spring = closedMap({
    type: { check: oneOf(["spring"]) },
    stiffness: { check: num(0, 2000, true), optional: true },
    damping: { check: num(0, 500, true), optional: true },
    mass: { check: num(0, 50, true), optional: true },
});

const easing = either(oneOf(EASING_NAMES), spring, `expected ${EASING_NAMES.join(", ")} or a spring`);

const effect = closedMap({
    type: { check: oneOf(EFFECT_TYPES) },
    direction: { check: oneOf(DIRECTIONS), optional: true },
    distance: { check: num(-4000, 4000), optional: true },
    from: { check: num(0, 10), optional: true },
    amount: { check: num(0, 200), optional: true },
});

const keyframe = closedMap({
    at: { check: num(0, 1) },
    value: { check: either(anyNumber(), color, "expected a number or a color"), optional: false },
    easing: { check: easing, optional: true },
});

const track = closedMap({
    prop: { check: oneOf(TRACK_PROPS) },
    keyframes: { check: vector(keyframe, 1, Infinity) },
});

const motion = closedMap({
    effects: { check: vector(effect, 0, 4), optional: true },
    tracks: { check: vector(track, 0, 16), optional: true },
    duration: { check: duration },
    delay: { check: duration, optional: true },
    easing: { check: easing, optional: true },
    stagger: {
        check: closedMap({
            each: { check: duration },
            from: { check: oneOf(STAGGER_ORIGINS), optional: true },
        }),
        optional: true,
    },
});

const shadow = closedMap({
    offsetX: { check: anyNumber(), optional: true },
    offsetY: { check: anyNumber(), optional: true },
    blur: { check: num(0, Number.MAX_VALUE), optional: true },
    spread: { check: anyNumber(), optional: true },
    color: { check: color, optional: true },
    opacity: { check: num(0, 1), optional: true },
});

const state = closedMap({
    opacity: { check: num(0, 1), optional: true },
    scale: { check: num(0, 10), optional: true },
    offsetX: { check: num(-4000, 4000), optional: true },
    offsetY: { check: num(-4000, 4000), optional: true },
    fill: { check: color, optional: true },
    shadow: { check: shadow, optional: true },
    duration: { check: duration, optional: true },
    easing: { check: easing, optional: true },
});

const loop = closedMap({
    type: { check: oneOf(LOOP_TYPES) },
    duration: { check: num(50, 20000), optional: true },
    count: { check: either(oneOf(["infinite"]), int(1, 1000), 'expected "infinite" or 1..1000'), optional: true },
    delay: { check: duration, optional: true },
    easing: { check: easing, optional: true },
    intensity: { check: num(0, 10, true), optional: true },
});

const smart = closedMap({
    index: { check: int(0, Number.MAX_SAFE_INTEGER) },
    destination: {
        check: (value, path, errors) => {
            if (value !== null && typeof value !== "string") {
                errors.push(`${path}: expected a string or null`);
            }
        },
        optional: true,
    },
    duration: { check: duration, optional: true },
    easing: { check: easing, optional: true },
});

const spec = closedMap({
    v: {
        check: (value, path, errors) => {
            if (value !== ANIMATION_VERSION) {
                errors.push(`${path}: expected ${ANIMATION_VERSION}`);
            }
        },
    },
    entrance: { check: motion, optional: true },
    exit: { check: motion, optional: true },
    states: {
        check: closedMap({ hover: { check: state, optional: true }, press: { check: state, optional: true } }),
        optional: true,
    },
    loop: { check: loop, optional: true },
    smart: { check: vector(smart, 0, 64), optional: true },
});

/**
 * Drops empty `states`/`smart` sections, as the frontend does before validating and storing.
 */
export function normalizeAnimationSpec(value: AnimationSpec): AnimationSpec {
    const out: AnimationSpec = { ...value };
    if (out.states !== undefined && Object.keys(out.states).length === 0) {
        delete out.states;
    }
    if (out.smart !== undefined && out.smart.length === 0) {
        delete out.smart;
    }
    return out;
}

/**
 * Validates a spec object (after `normalizeAnimationSpec`); errors name the JSON path.
 */
export function validateAnimationSpec(value: unknown): ValidationResult {
    const normalized = isObject(value) ? normalizeAnimationSpec(value as unknown as AnimationSpec) : value;
    const errors: string[] = [];
    spec(normalized, "$", errors);
    return errors.length === 0 ? { ok: true, spec: normalized as AnimationSpec } : { ok: false, errors };
}

/**
 * Parses the stored JSON string; `null` when missing, not JSON or not a valid version 1 spec
 * (the frontend ignores such values too).
 */
export function parseAnimationSpec(raw: string | null | undefined): AnimationSpec | null {
    if (typeof raw !== "string" || raw === "") {
        return null;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    const result = validateAnimationSpec(value);
    return result.ok ? result.spec : null;
}

/**
 * Serializes a spec for storage; `null` when it holds no section (the caller removes the entry
 * by storing an empty string). Throws when the spec is invalid.
 */
export function encodeAnimationSpec(value: AnimationSpec): string | null {
    const normalized = normalizeAnimationSpec({ ...value, v: ANIMATION_VERSION });
    const result = validateAnimationSpec(normalized);
    if (!result.ok) {
        throw new Error(`Invalid animation spec: ${result.errors.join("; ")}`);
    }
    const sections = ["entrance", "exit", "states", "loop", "smart"] as const;
    if (!sections.some((key) => normalized[key] !== undefined)) {
        return null;
    }
    return JSON.stringify(normalized);
}

/** One animated layer as the read helpers return it. */
export interface AnimatedLayer {
    nodeId: string;
    name: string;
    type: string;
    /** names from the root (excluded) down to the layer, joined with "/" */
    path: string;
    parentId: string | null;
    animations: AnimationSpec;
}

/**
 * Reads the animation specs of layers.
 */
export class AnimationReader {
    /**
     * The valid spec of a shape, or `null` (none, or an invalid stored value).
     */
    public static read(shape: Shape): AnimationSpec | null {
        return parseAnimationSpec(AnimationReader.raw(shape));
    }

    /**
     * The raw stored value (JSON string), `null` when the shape has none.
     */
    public static raw(shape: Shape): string | null {
        const value = shape.getSharedPluginData(ANIMATION_NAMESPACE, ANIMATION_KEY);
        return value === undefined || value === "" ? null : value;
    }

    /**
     * Every animated layer in `root` (included) and its descendants, depth first in layer order.
     */
    public static collect(root: Shape): AnimatedLayer[] {
        const out: AnimatedLayer[] = [];
        // `names` holds the names from the root down to the parent of `shape`.
        const visit = (shape: Shape, names: string[], parentId: string | null): void => {
            const animations = AnimationReader.read(shape);
            if (animations !== null) {
                out.push({
                    nodeId: shape.id,
                    name: shape.name,
                    type: shape.type,
                    path: [...names.slice(1), shape.name].join("/"),
                    parentId,
                    animations,
                });
            }
            const children = (shape as any).children as Shape[] | undefined;
            for (const child of children ?? []) {
                visit(child, [...names, shape.name], shape.id);
            }
        };
        visit(root, [], (root as any).parent?.id ?? null);
        return out;
    }

    /**
     * Smart animate options of the interaction `index` of `shape`, or `null`. An entry whose
     * stored destination differs from the interaction's current destination is ignored.
     */
    public static smartFor(shape: Shape, index: number): SmartAnimate | null {
        const spec = AnimationReader.read(shape);
        const interaction = (shape.interactions ?? [])[index] as any;
        const destination: string | undefined = interaction?.action?.destination?.id;
        const entry = spec?.smart?.find((s) => s.index === index);
        if (!entry) {
            return null;
        }
        if (entry.destination && destination && entry.destination !== destination) {
            return null;
        }
        return entry;
    }
}
