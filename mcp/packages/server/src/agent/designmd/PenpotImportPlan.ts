import { CssColor, CssValues } from "./CssValues";
import { DesignMdReferences } from "./DesignMdReferences";
import type { DesignMdDocument } from "./DesignMdTypes";

/** Library color to create or update. */
export interface PlannedColor {
    name: string;
    /** `#rrggbb` */
    hex: string;
    opacity: number;
}

/** Library typography to create or update (values in Penpot's string form). */
export interface PlannedTypography {
    name: string;
    fontFamily: string;
    /** px number, e.g. `"16"` */
    fontSize: string;
    fontWeight: string;
    fontStyle: "normal" | "italic";
    /** unitless multiplier, e.g. `"1.5"` */
    lineHeight: string;
    /** px number, e.g. `"-0.5"` */
    letterSpacing: string;
}

/** Penpot token type used by the plan. */
export type PlannedTokenType = "color" | "borderRadius" | "spacing" | "number";

/** Token to create or update in the DESIGN.md token set. */
export interface PlannedToken {
    name: string;
    type: PlannedTokenType;
    /** value in Penpot's string form; aliases are `{<token name>}` */
    value: string;
}

/** Everything an import writes into the Penpot file, except components. */
export interface PenpotImportPlan {
    setName: string;
    /** theme group of the DESIGN.md theme (its own, so it never turns off the user's themes) */
    themeGroup: string;
    themeName: string;
    colors: PlannedColor[];
    typographies: PlannedTypography[];
    /** literal tokens first, then aliases */
    tokens: PlannedToken[];
    /** values left out, with the reason */
    skipped: { path: string; reason: string }[];
}

/**
 * Builder of the {@link PenpotImportPlan} of a DESIGN.md: resolves references, converts units to
 * Penpot's px numbers and names tokens (`color.<n>`, `radius.<n>`, `spacing.<n>`).
 */
export class PenpotImportPlanner {
    /** name of the token set and theme that hold the DESIGN.md tokens */
    public static readonly TOKEN_SET = "DESIGN.md";

    /** Penpot token name prefix per DESIGN.md group */
    public static readonly TOKEN_PREFIX = { colors: "color", rounded: "radius", spacing: "spacing" } as const;

    private static readonly DEFAULT_FONT = "Source Sans Pro";
    private static readonly DEFAULT_FONT_SIZE_PX = 14;

    private readonly references: DesignMdReferences;
    private readonly plan: PenpotImportPlan;

    private constructor(private readonly document: DesignMdDocument) {
        this.references = new DesignMdReferences(document.tokens);
        this.plan = {
            setName: PenpotImportPlanner.TOKEN_SET,
            themeGroup: PenpotImportPlanner.TOKEN_SET,
            themeName: PenpotImportPlanner.TOKEN_SET,
            colors: [],
            typographies: [],
            tokens: [],
            skipped: [],
        };
    }

    /**
     * Builds the plan of a document.
     *
     * @param document - a document without validation errors
     */
    public static plan(document: DesignMdDocument): PenpotImportPlan {
        const planner = new PenpotImportPlanner(document);
        planner.planColors();
        planner.planTypographies();
        planner.planDimensions("rounded", "borderRadius");
        planner.planDimensions("spacing", "spacing");
        const isAlias = (token: PlannedToken) => /^\{[^}]+\}$/.test(token.value);
        planner.plan.tokens = [
            ...planner.plan.tokens.filter((token) => !isAlias(token)),
            ...planner.plan.tokens.filter(isAlias),
        ];
        return planner.plan;
    }

    private planColors(): void {
        for (const [name, value] of Object.entries(this.document.tokens.colors)) {
            const resolved = this.references.resolve(value, "colors");
            const color = resolved.ok && typeof resolved.value === "string" ? CssColor.parse(resolved.value) : null;
            const reference = DesignMdReferences.parse(value);
            if (color === null) {
                this.plan.skipped.push({ path: `colors.${name}`, reason: "not a color Penpot can store" });
                continue;
            }
            this.plan.colors.push({ name, hex: color.hex, opacity: color.opacity });
            this.plan.tokens.push({
                name: `${PenpotImportPlanner.TOKEN_PREFIX.colors}.${name}`,
                type: "color",
                value: reference
                    ? `{${PenpotImportPlanner.TOKEN_PREFIX.colors}.${reference.name}}`
                    : CssColor.format(color),
            });
        }
    }

    private planTypographies(): void {
        for (const [name, typography] of Object.entries(this.document.tokens.typography)) {
            const literal = (property: string) => {
                const resolved = this.references.resolve(typography[property]);
                return resolved.ok ? resolved.value : undefined;
            };
            const fontSizePx = CssValues.toPx(literal("fontSize")) ?? PenpotImportPlanner.DEFAULT_FONT_SIZE_PX;
            const weight = CssValues.parseNumber(literal("fontWeight")) ?? 400;
            const lineHeight = CssValues.lineHeightMultiplier(literal("lineHeight"), fontSizePx) ?? 1.2;
            const letterSpacing = CssValues.toPx(literal("letterSpacing"), fontSizePx) ?? 0;
            const family = literal("fontFamily");
            this.plan.typographies.push({
                name,
                fontFamily:
                    typeof family === "string" && family.trim().length > 0
                        ? family.trim()
                        : PenpotImportPlanner.DEFAULT_FONT,
                fontSize: CssValues.formatNumber(fontSizePx),
                fontWeight: CssValues.formatNumber(weight, 0),
                fontStyle: "normal",
                lineHeight: CssValues.formatNumber(lineHeight),
                letterSpacing: CssValues.formatNumber(letterSpacing),
            });
        }
    }

    private planDimensions(group: "rounded" | "spacing", dimensionType: PlannedTokenType): void {
        const prefix = PenpotImportPlanner.TOKEN_PREFIX[group];
        for (const [name, value] of Object.entries(this.document.tokens[group])) {
            const reference = DesignMdReferences.parse(value);
            const resolved = this.references.resolve(value, group);
            const literal = resolved.ok ? resolved.value : undefined;
            const unitless = CssValues.parseNumber(literal);
            const px = CssValues.toPx(literal);
            if (px === null) {
                this.plan.skipped.push({ path: `${group}.${name}`, reason: "not a dimension" });
                continue;
            }
            const type: PlannedTokenType = unitless !== null && group === "spacing" ? "number" : dimensionType;
            this.plan.tokens.push({
                name: `${prefix}.${name}`,
                type,
                value: reference ? `{${prefix}.${reference.name}}` : CssValues.formatNumber(px),
            });
        }
    }
}
