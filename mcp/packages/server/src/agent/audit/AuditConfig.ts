import type { Platform } from "@penpot/mcp-common";
import type { AuditCheckId } from "./AuditFinding";

/** Settings a project can override in `.penforge/audit.json`. */
export interface AuditConfigOverrides {
    /** spacing values are on the scale when they are a multiple of this (default 4) */
    spacingBase?: number;
    /** extra spacing values that are always on the scale (default [1, 2]) */
    spacingExtras?: number[];
    /** allowed font sizes */
    typeScale?: number[];
    /** minimum touch target edge in px (default 44 on mobile, 24 on web) */
    minTouchTarget?: number;
    /** colors closer than this delta E (but not equal) count as near duplicates (default 3) */
    colorDistance?: number;
    /** maximum number of canvas comments one audit posts (default 40) */
    maxComments?: number;
    /** checks to skip */
    disabledChecks?: AuditCheckId[];
}

/**
 * Thresholds and scales of the deterministic audit checks.
 */
export class AuditConfig {
    /** default type scale (px) */
    public static readonly DEFAULT_TYPE_SCALE = [
        10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 30, 32, 36, 40, 48, 56, 64, 72, 96,
    ];

    public readonly spacingBase: number;
    public readonly spacingExtras: number[];
    public readonly typeScale: number[];
    public readonly minTouchTarget: number;
    public readonly colorDistance: number;
    public readonly maxComments: number;
    public readonly disabledChecks: Set<AuditCheckId>;

    /**
     * @param platform - the project platform, which sets the touch target minimum
     * @param overrides - project settings
     */
    constructor(
        public readonly platform: Platform,
        overrides: AuditConfigOverrides = {}
    ) {
        this.spacingBase = AuditConfig.positive(overrides.spacingBase, 4);
        this.spacingExtras = AuditConfig.numbers(overrides.spacingExtras) ?? [1, 2];
        this.typeScale = AuditConfig.numbers(overrides.typeScale) ?? AuditConfig.DEFAULT_TYPE_SCALE;
        this.minTouchTarget = AuditConfig.positive(overrides.minTouchTarget, platform === "mobile" ? 44 : 24);
        this.colorDistance = AuditConfig.positive(overrides.colorDistance, 3);
        this.maxComments = Math.floor(AuditConfig.positive(overrides.maxComments, 40));
        this.disabledChecks = new Set(Array.isArray(overrides.disabledChecks) ? overrides.disabledChecks : []);
    }

    /**
     * Tells whether a spacing value is on the spacing scale.
     *
     * @param value - the spacing in px
     */
    public isOnSpacingScale(value: number): boolean {
        if (value <= 0) {
            return true;
        }
        const rounded = Math.round(value * 100) / 100;
        return rounded % this.spacingBase === 0 || this.spacingExtras.includes(rounded);
    }

    /**
     * Nearest spacing scale value.
     *
     * @param value - the spacing in px
     */
    public nearestSpacing(value: number): number {
        return Math.max(this.spacingBase, Math.round(value / this.spacingBase) * this.spacingBase);
    }

    /**
     * Tells whether a font size is on the type scale.
     *
     * @param size - the font size in px
     */
    public isOnTypeScale(size: number): boolean {
        return this.typeScale.some((step) => Math.abs(step - size) < 0.01);
    }

    /**
     * Nearest type scale size.
     *
     * @param size - the font size in px
     */
    public nearestTypeSize(size: number): number {
        return this.typeScale.reduce((best, step) => (Math.abs(step - size) < Math.abs(best - size) ? step : best));
    }

    private static positive(value: unknown, fallback: number): number {
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    }

    private static numbers(value: unknown): number[] | null {
        if (!Array.isArray(value)) {
            return null;
        }
        const numbers = value.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
        return numbers.length > 0 ? numbers : null;
    }
}
