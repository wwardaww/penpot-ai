import { MotionEasing, type MotionEasingValue } from "./MotionEasing";

/** Property a track animates (W31): factors, px, degrees, `#rrggbb` (fill), 0..1 sweep (shimmer). */
export type MotionProp = "opacity" | "translateX" | "translateY" | "scale" | "rotate" | "blur" | "fill" | "shimmer";

/**
 * Track ready to write as code: values at times 0..1 and the easing of each segment. A single
 * segment may be a spring; `sampled` tracks hold enough linear points to follow a curve that code
 * cannot name (a curve over several keyframes).
 */
export interface MotionTrack {
    prop: MotionProp;
    values: (number | string)[];
    times: number[];
    /** one per segment (`values.length - 1`) */
    easings: MotionEasingValue[];
    sampled: boolean;
}

/** Delays of a stagger: the direct children start one after the other. */
export interface MotionStagger {
    /** ms between two children */
    each: number;
    from: "first" | "last" | "center";
}

/** Motion of a layer: entrance, exit or loop. */
export interface MotionClip {
    /** ms */
    delay: number;
    /** ms; springs: their settle time */
    duration: number;
    iterations: number | "infinite";
    tracks: MotionTrack[];
    stagger: MotionStagger | null;
}

/** Hover or press state: values on top of the layer at rest, and how it gets there. */
export interface MotionState {
    values: {
        opacity?: number;
        scale?: number;
        translateX?: number;
        translateY?: number;
        fill?: string;
        shadow?: { x: number; y: number; blur: number; spread: number; color: string; opacity: number };
    };
    duration: number;
    easing: MotionEasingValue;
}

/** Smart animate transition to another screen. */
export interface MotionSmart {
    destinationName: string;
    duration: number;
    easing: MotionEasingValue;
}

/** Everything a layer animates. */
export interface LayerMotion {
    enter: MotionClip | null;
    exit: MotionClip | null;
    hover: MotionState | null;
    press: MotionState | null;
    loop: MotionClip | null;
    smart: MotionSmart[];
}

interface Keyframe {
    at: number;
    value: number | string;
    easing?: MotionEasingValue;
}

/**
 * Compiler of a layer's W31 animation spec into the values code needs. Follows the player in
 * Penpot (`app.main.animations.presets`): same effects, defaults, directions and loop presets.
 */
export class MotionModel {
    /** linear points of a sampled track */
    private static readonly SAMPLES = 24;
    private static readonly DEFAULT_DURATION = 300;
    private static readonly IDENTITY: Record<string, number> = {
        opacity: 1,
        translateX: 0,
        translateY: 0,
        scale: 1,
        rotate: 0,
        blur: 0,
    };
    private static readonly TRACK_PROPS = new Set([
        "opacity",
        "translateX",
        "translateY",
        "scale",
        "rotate",
        "blur",
        "fill",
    ]);

    private constructor() {}

    /**
     * Compiles a spec.
     *
     * @param spec - the layer's `penforge/animations` value
     * @param smart - resolved smart animate links of the layer
     */
    public static compile(
        spec: Record<string, unknown>,
        smart: { destinationName: string; duration?: number; easing?: unknown }[] = []
    ): LayerMotion {
        const states = MotionModel.object(spec.states);
        return {
            enter: MotionModel.motion(spec.entrance, false),
            exit: MotionModel.motion(spec.exit, true),
            hover: MotionModel.state(states.hover),
            press: MotionModel.state(states.press),
            loop: MotionModel.loop(spec.loop),
            smart: smart.map((link) => {
                const easing = MotionEasing.parse(link.easing, "ease-in-out");
                return {
                    destinationName: link.destinationName,
                    duration: MotionEasing.duration(easing, link.duration ?? MotionModel.DEFAULT_DURATION),
                    easing,
                };
            }),
        };
    }

    /** Tells whether a layer animates anything. */
    public static isEmpty(motion: LayerMotion): boolean {
        return (
            motion.enter === null &&
            motion.exit === null &&
            motion.hover === null &&
            motion.press === null &&
            motion.loop === null &&
            motion.smart.length === 0
        );
    }

    /**
     * Gets the extra delay of a staggered child.
     *
     * @param stagger - the stagger
     * @param index - position of the child in reading order
     * @param count - number of children
     */
    public static staggerDelay(stagger: MotionStagger, index: number, count: number): number {
        switch (stagger.from) {
            case "last":
                return (count - 1 - index) * stagger.each;
            case "center":
                return Math.floor(Math.abs(index - (count - 1) / 2)) * stagger.each;
            default:
                return index * stagger.each;
        }
    }

    private static motion(value: unknown, exit: boolean): MotionClip | null {
        if (value === null || typeof value !== "object") {
            return null;
        }
        const motion = value as Record<string, unknown>;
        const easing = MotionEasing.parse(motion.easing, exit ? "ease-in" : "ease-out");
        const duration = MotionEasing.duration(
            easing,
            MotionModel.number(motion.duration, MotionModel.DEFAULT_DURATION)
        );
        const raw = MotionModel.array(motion.tracks);
        const tracks: { prop: MotionProp; keyframes: Keyframe[] }[] =
            raw.length > 0
                ? MotionModel.specTracks(raw)
                : MotionModel.effectTracks(MotionModel.array(motion.effects), exit);
        const stagger = MotionModel.object(motion.stagger);
        if (tracks.length === 0) {
            return null;
        }
        return {
            delay: MotionModel.number(motion.delay, 0),
            duration,
            iterations: 1,
            tracks: tracks.map((track) => MotionModel.track(track.prop, track.keyframes, easing)),
            stagger:
                typeof stagger.each === "number"
                    ? {
                          each: stagger.each,
                          from: stagger.from === "last" || stagger.from === "center" ? stagger.from : "first",
                      }
                    : null,
        };
    }

    private static effectTracks(
        effects: Record<string, unknown>[],
        exit: boolean
    ): { prop: MotionProp; keyframes: Keyframe[] }[] {
        const hidden = new Map<MotionProp, number>();
        for (const effect of effects) {
            switch (effect.type) {
                case "fade":
                    hidden.set("opacity", 0);
                    break;
                case "scale":
                    hidden.set("scale", MotionModel.number(effect.from, 0.8));
                    break;
                case "blur":
                    hidden.set("blur", MotionModel.number(effect.amount, 8));
                    break;
                case "slide": {
                    // the direction names where the layer moves, in and out
                    const distance = MotionModel.number(effect.distance, 24) * (exit ? -1 : 1);
                    const direction = effect.direction ?? "up";
                    if (direction === "left" || direction === "right") {
                        hidden.set("translateX", direction === "left" ? distance : -distance);
                    } else {
                        hidden.set("translateY", direction === "up" ? distance : -distance);
                    }
                    break;
                }
            }
        }
        return [...hidden].map(([prop, value]) => {
            const shown = MotionModel.IDENTITY[prop];
            return {
                prop,
                keyframes: [
                    { at: 0, value: exit ? shown : value },
                    { at: 1, value: exit ? value : shown },
                ],
            };
        });
    }

    private static specTracks(raw: Record<string, unknown>[]): { prop: MotionProp; keyframes: Keyframe[] }[] {
        return raw
            .filter((track) => MotionModel.TRACK_PROPS.has(String(track.prop)))
            .map((track) => ({
                prop: track.prop as MotionProp,
                keyframes: MotionModel.array(track.keyframes)
                    .map((frame) => ({
                        at: MotionModel.number(frame.at, 0),
                        value:
                            typeof frame.value === "string"
                                ? MotionModel.hex(frame.value)
                                : MotionModel.number(frame.value, 0),
                        ...(frame.easing !== undefined && frame.easing !== null
                            ? { easing: MotionEasing.parse(frame.easing, "ease") }
                            : {}),
                    }))
                    .sort((a, b) => a.at - b.at),
            }))
            .filter((track) => track.keyframes.length > 0);
    }

    private static loop(value: unknown): MotionClip | null {
        if (value === null || typeof value !== "object") {
            return null;
        }
        const loop = value as Record<string, unknown>;
        const intensity = MotionModel.number(loop.intensity, 1);
        const named = (name: string) => MotionEasing.parse(name, name);
        const presets: Record<string, { duration: number; tracks: { prop: MotionProp; keyframes: Keyframe[] }[] }> = {
            pulse: {
                duration: 1000,
                tracks: [
                    {
                        prop: "scale",
                        keyframes: [
                            { at: 0, value: 1 },
                            { at: 0.5, value: 1 + 0.06 * intensity, easing: named("ease-in-out") },
                            { at: 1, value: 1, easing: named("ease-in-out") },
                        ],
                    },
                    {
                        prop: "opacity",
                        keyframes: [
                            { at: 0, value: 1 },
                            { at: 0.5, value: Math.max(0, 1 - 0.15 * intensity), easing: named("ease-in-out") },
                            { at: 1, value: 1, easing: named("ease-in-out") },
                        ],
                    },
                ],
            },
            spin: {
                duration: 1000,
                tracks: [
                    {
                        prop: "rotate",
                        keyframes: [
                            { at: 0, value: 0 },
                            { at: 1, value: 360 * Math.max(1, Math.round(intensity)) },
                        ],
                    },
                ],
            },
            bounce: {
                duration: 800,
                tracks: [
                    {
                        prop: "translateY",
                        keyframes: [
                            { at: 0, value: 0 },
                            { at: 0.5, value: -8 * intensity, easing: named("ease-out") },
                            { at: 1, value: 0, easing: named("ease-in") },
                        ],
                    },
                ],
            },
            shimmer: {
                duration: 1200,
                tracks: [
                    {
                        prop: "shimmer",
                        keyframes: [
                            { at: 0, value: 0 },
                            { at: 1, value: 1 },
                        ],
                    },
                ],
            },
        };
        const preset = presets[String(loop.type)];
        if (preset === undefined) {
            return null;
        }
        const easing = MotionEasing.parse(loop.easing, "linear");
        return {
            delay: MotionModel.number(loop.delay, 0),
            duration: MotionModel.number(loop.duration, preset.duration),
            iterations: typeof loop.count === "number" ? loop.count : "infinite",
            tracks: preset.tracks.map((track) => MotionModel.track(track.prop, track.keyframes, easing)),
            stagger: null,
        };
    }

    private static state(value: unknown): MotionState | null {
        if (value === null || typeof value !== "object") {
            return null;
        }
        const state = value as Record<string, unknown>;
        const easing = MotionEasing.parse(state.easing, "ease-out");
        const values: MotionState["values"] = {};
        if (typeof state.opacity === "number") {
            values.opacity = state.opacity;
        }
        if (typeof state.scale === "number") {
            values.scale = state.scale;
        }
        if (typeof state.offsetX === "number") {
            values.translateX = state.offsetX;
        }
        if (typeof state.offsetY === "number") {
            values.translateY = state.offsetY;
        }
        if (typeof state.fill === "string" && /^#[0-9a-f]{6}$/i.test(state.fill)) {
            values.fill = state.fill;
        }
        if (state.shadow !== null && typeof state.shadow === "object") {
            const shadow = state.shadow as Record<string, unknown>;
            values.shadow = {
                x: MotionModel.number(shadow.offsetX, 0),
                y: MotionModel.number(shadow.offsetY, 0),
                blur: MotionModel.number(shadow.blur, 0),
                spread: MotionModel.number(shadow.spread, 0),
                color: MotionModel.hex(shadow.color),
                opacity: MotionModel.number(shadow.opacity, 0.2),
            };
        }
        return { values, duration: MotionEasing.duration(easing, MotionModel.number(state.duration, 150)), easing };
    }

    /** Plans one track: kept as written where code can say it, sampled where it cannot. */
    private static track(prop: MotionProp, keyframes: Keyframe[], easing: MotionEasingValue): MotionTrack {
        const linear = MotionEasing.parse("linear", "linear");
        if (keyframes.length === 1) {
            const value = keyframes[0].value;
            return { prop, values: [value, value], times: [0, 1], easings: [linear], sampled: false };
        }
        const last = keyframes[keyframes.length - 1];
        const whole = keyframes[0].at === 0 && last.at === 1;
        if (keyframes.length === 2 && whole) {
            const segment = keyframes[1].easing;
            if (segment === undefined || MotionEasing.isLinear(easing)) {
                return {
                    prop,
                    values: keyframes.map((frame) => frame.value),
                    times: [0, 1],
                    easings: [segment ?? easing],
                    sampled: false,
                };
            }
        } else if (MotionEasing.isLinear(easing) && whole && keyframes.every((f) => f.easing?.kind !== "spring")) {
            return {
                prop,
                values: keyframes.map((frame) => frame.value),
                times: keyframes.map((frame) => frame.at),
                easings: keyframes.slice(1).map((frame) => frame.easing ?? linear),
                sampled: false,
            };
        }
        const times = Array.from({ length: MotionModel.SAMPLES + 1 }, (_, i) => i / MotionModel.SAMPLES);
        return {
            prop,
            values: times.map((time) => MotionModel.sample(keyframes, MotionEasing.at(easing, time))),
            times,
            easings: times.slice(1).map(() => linear),
            sampled: true,
        };
    }

    /** Value of keyframes at an eased progress (numbers extrapolate, as the player does). */
    private static sample(keyframes: Keyframe[], progress: number): number | string {
        let index = 0;
        while (index < keyframes.length - 2 && progress > keyframes[index + 1].at) {
            index++;
        }
        const a = keyframes[index];
        const b = keyframes[index + 1];
        const span = b.at - a.at;
        let local = span > 0 ? (progress - a.at) / span : 1;
        if (b.easing !== undefined) {
            local = MotionEasing.at(b.easing, Math.min(1, Math.max(0, local)));
        }
        if (typeof a.value === "string" || typeof b.value === "string") {
            return MotionModel.mix(String(a.value), String(b.value), Math.min(1, Math.max(0, local)));
        }
        return Math.round((a.value + (b.value - a.value) * local) * 10000) / 10000;
    }

    private static mix(from: string, to: string, t: number): string {
        const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) || 0;
        const mixed = [0, 1, 2].map((i) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t));
        return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    }

    /** A `#rrggbb` color; black for anything else (values end up in code). */
    private static hex(value: unknown): string {
        return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
    }

    private static number(value: unknown, fallback: number): number {
        return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    }

    private static array(value: unknown): Record<string, unknown>[] {
        return Array.isArray(value) ? value.filter((item) => item !== null && typeof item === "object") : [];
    }

    private static object(value: unknown): Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    }
}
