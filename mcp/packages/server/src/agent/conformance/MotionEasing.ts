/** Easing of a motion: a cubic bezier, or a spring with its own settle time. */
export type MotionEasingValue =
    | { kind: "bezier"; points: [number, number, number, number] }
    | { kind: "spring"; stiffness: number; damping: number; mass: number };

/**
 * Easings of the W31 animation spec, with the same curves, spring defaults and settle time as the
 * player in Penpot (`app.main.animations.easing`), so generated animations run one to one.
 */
export class MotionEasing {
    private static readonly NAMED: Record<string, [number, number, number, number]> = {
        linear: [0, 0, 1, 1],
        ease: [0.25, 0.1, 0.25, 1],
        "ease-in": [0.42, 0, 1, 1],
        "ease-out": [0, 0, 0.58, 1],
        "ease-in-out": [0.42, 0, 0.58, 1],
    };
    private static readonly SPRING = { stiffness: 170, damping: 26, mass: 1 };

    private constructor() {}

    /**
     * Reads an easing of the spec.
     *
     * @param value - easing name or spring object of the spec
     * @param fallback - name used when the spec has none
     */
    public static parse(value: unknown, fallback: string): MotionEasingValue {
        if (value !== null && typeof value === "object" && (value as { type?: unknown }).type === "spring") {
            const spring = value as Record<string, unknown>;
            const positive = (key: "stiffness" | "damping" | "mass") => {
                const given = spring[key];
                return typeof given === "number" && given > 0 ? given : MotionEasing.SPRING[key];
            };
            return {
                kind: "spring",
                stiffness: positive("stiffness"),
                damping: positive("damping"),
                mass: positive("mass"),
            };
        }
        const points =
            (typeof value === "string" ? MotionEasing.NAMED[value] : undefined) ??
            MotionEasing.NAMED[fallback] ??
            MotionEasing.NAMED.linear;
        return { kind: "bezier", points: [...points] };
    }

    /** Tells whether an easing is the straight line. */
    public static isLinear(easing: MotionEasingValue): boolean {
        return easing.kind === "bezier" && easing.points.join() === "0,0,1,1";
    }

    /**
     * Gets the duration of a motion in ms: the given one, or the settle time of a spring (within
     * 0.1% of the end, 50 to 5000 ms).
     *
     * @param easing - the easing
     * @param duration - duration of the spec, ms
     */
    public static duration(easing: MotionEasingValue, duration: number): number {
        if (easing.kind !== "spring") {
            return duration;
        }
        const step = 0.01;
        let lastOut = 0;
        for (let i = 0; i < 500; i++) {
            const t = i * step;
            if (Math.abs(1 - MotionEasing.springAt(easing, t)) > 0.001) {
                lastOut = t;
            }
        }
        return Math.round(Math.min(5000, Math.max(50, 1000 * (lastOut + step))));
    }

    /**
     * Gets the eased progress.
     *
     * @param easing - the easing
     * @param progress - linear progress 0..1
     */
    public static at(easing: MotionEasingValue, progress: number): number {
        if (progress <= 0) {
            return 0;
        }
        if (progress >= 1) {
            return 1;
        }
        if (easing.kind === "spring") {
            return MotionEasing.springAt(easing, (progress * MotionEasing.duration(easing, 0)) / 1000);
        }
        const [x1, y1, x2, y2] = easing.points;
        let low = 0;
        let high = 1;
        for (let i = 0; i < 40; i++) {
            const middle = (low + high) / 2;
            if (MotionEasing.bezier(x1, x2, middle) < progress) {
                low = middle;
            } else {
                high = middle;
            }
        }
        return MotionEasing.bezier(y1, y2, (low + high) / 2);
    }

    private static bezier(p1: number, p2: number, t: number): number {
        const u = 1 - t;
        return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
    }

    /** Position of a damped spring going from 0 to 1, at `t` seconds. */
    private static springAt(spring: { stiffness: number; damping: number; mass: number }, t: number): number {
        const { stiffness, damping, mass } = spring;
        const w0 = Math.sqrt(stiffness / mass);
        const zeta = damping / (2 * Math.sqrt(stiffness * mass));
        if (zeta < 1) {
            const wd = w0 * Math.sqrt(1 - zeta * zeta);
            return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
        }
        if (zeta === 1) {
            return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
        }
        const s = Math.sqrt(zeta * zeta - 1);
        const r1 = w0 * (-zeta - s);
        const r2 = w0 * (-zeta + s);
        const c2 = r1 / (r1 - r2);
        const c1 = -1 - c2;
        return 1 + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
    }
}
