import { CssColor, CssValues } from "./CssValues";
import { DesignMdReferences } from "./DesignMdReferences";
import type { DesignMdDocument, DesignMdIssue, DesignMdTypography } from "./DesignMdTypes";

/**
 * Checker of the values of a parsed DESIGN.md: colors, dimensions, references, component
 * properties and section structure.
 *
 * Errors make a file unusable for import; warnings are worth showing but harmless.
 */
export class DesignMdValidator {
    /** canonical `##` sections in their required order, each with its aliases */
    public static readonly SECTIONS: string[][] = [
        ["Overview", "Brand & Style"],
        ["Colors"],
        ["Typography"],
        ["Layout", "Layout & Spacing"],
        ["Elevation & Depth", "Elevation"],
        ["Shapes"],
        ["Components"],
        ["Do's and Don'ts"],
    ];

    /** component properties defined by the spec */
    public static readonly COMPONENT_PROPERTIES = [
        "backgroundColor",
        "textColor",
        "typography",
        "rounded",
        "padding",
        "size",
        "height",
        "width",
    ];

    private static readonly TYPOGRAPHY_PROPERTIES = [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
        "fontFeature",
        "fontVariation",
    ];

    private static readonly CSS_FUNCTION_PATTERN = /^[a-z-]+\(.*\)$/i;

    private readonly issues: DesignMdIssue[] = [];
    private readonly references: DesignMdReferences;

    private constructor(private readonly document: DesignMdDocument) {
        this.references = new DesignMdReferences(document.tokens);
    }

    /**
     * Validates a document.
     *
     * @param document - the parsed document
     * @returns the issues found, errors first
     */
    public static validate(document: DesignMdDocument): DesignMdIssue[] {
        const validator = new DesignMdValidator(document);
        validator.run();
        return [
            ...validator.issues.filter((issue) => issue.severity === "error"),
            ...validator.issues.filter((issue) => issue.severity === "warning"),
        ];
    }

    /**
     * Gets the canonical index of a section heading.
     *
     * @returns the index in {@link SECTIONS}, or -1 for other headings
     */
    public static sectionIndex(heading: string): number {
        const normalized = heading.trim().toLowerCase();
        return DesignMdValidator.SECTIONS.findIndex((names) => names.some((name) => name.toLowerCase() === normalized));
    }

    private run(): void {
        const { tokens } = this.document;
        if (!tokens.name || tokens.name.trim().length === 0) {
            this.warning("name", "The design system has no name", "no-name");
        }
        for (const [name, value] of Object.entries(tokens.colors)) {
            this.checkColor(`colors.${name}`, value);
        }
        for (const [name, value] of Object.entries(tokens.typography)) {
            this.checkTypography(`typography.${name}`, value);
        }
        for (const [name, value] of Object.entries(tokens.rounded)) {
            this.checkDimension(`rounded.${name}`, value, "rounded", false);
        }
        for (const [name, value] of Object.entries(tokens.spacing)) {
            this.checkDimension(`spacing.${name}`, value, "spacing", true);
        }
        for (const [name, component] of Object.entries(tokens.components)) {
            for (const [property, value] of Object.entries(component)) {
                this.checkComponentProperty(`components.${name}.${property}`, property, value);
            }
        }
        this.checkSections();
    }

    private checkColor(path: string, value: string): void {
        const resolved = this.references.resolve(value, "colors");
        if (!resolved.ok) {
            this.error(path, resolved.error, resolved.code, resolved.params);
            return;
        }
        if (DesignMdReferences.parse(value) !== null) {
            return;
        }
        if (CssColor.parse(value) !== null) {
            return;
        }
        if (DesignMdValidator.CSS_FUNCTION_PATTERN.test(value.trim())) {
            this.warning(
                path,
                `${value} is kept as a token, but Penpot library colors need hex, rgb() or hsl()`,
                "color-unsupported",
                { value }
            );
        } else {
            this.error(path, `${value} is not a CSS color`, "not-color", { value });
        }
    }

    private checkTypography(path: string, typography: DesignMdTypography): void {
        for (const [property, value] of Object.entries(typography)) {
            const propertyPath = `${path}.${property}`;
            const resolved = this.references.resolve(value);
            if (!resolved.ok) {
                this.error(propertyPath, resolved.error, resolved.code, resolved.params);
                continue;
            }
            const literal = resolved.value;
            switch (property) {
                case "fontFamily":
                case "fontFeature":
                case "fontVariation":
                    if (typeof literal !== "string" || literal.trim().length === 0) {
                        this.error(propertyPath, `${property} must be text`, "not-text");
                    }
                    break;
                case "fontSize":
                case "letterSpacing":
                    if (CssValues.parseDimension(literal) === null && literal !== 0) {
                        this.error(
                            propertyPath,
                            `${property} must be a dimension such as 16px or 1rem`,
                            "not-dimension",
                            {
                                value: String(literal),
                            }
                        );
                    }
                    break;
                case "fontWeight": {
                    const weight = CssValues.parseNumber(literal);
                    if (weight === null || weight < 1 || weight > 1000) {
                        this.error(propertyPath, "fontWeight must be a number from 1 to 1000", "font-weight");
                    }
                    break;
                }
                case "lineHeight":
                    if (CssValues.parseNumber(literal) === null && CssValues.parseDimension(literal) === null) {
                        this.error(propertyPath, "lineHeight must be a number or a dimension", "line-height");
                    }
                    break;
                default:
                    if (!DesignMdValidator.TYPOGRAPHY_PROPERTIES.includes(property)) {
                        this.warning(propertyPath, `Unknown typography property "${property}"`, "unknown-property");
                    }
            }
        }
        if (typography.fontFamily === undefined) {
            this.warning(path, "No fontFamily: the default font will be used", "no-font-family");
        }
        if (typography.fontSize === undefined) {
            this.warning(path, "No fontSize: 14px will be used", "no-font-size");
        }
    }

    private checkDimension(path: string, value: string | number, group: string, allowUnitless: boolean): void {
        const resolved = this.references.resolve(value, group);
        if (!resolved.ok) {
            this.error(path, resolved.error, resolved.code, resolved.params);
            return;
        }
        const literal = resolved.value;
        if (CssValues.parseDimension(literal) !== null) {
            return;
        }
        const number = CssValues.parseNumber(literal);
        if (number !== null && (allowUnitless || number === 0)) {
            return;
        }
        this.error(path, `${String(literal)} must be a dimension such as 8px`, "not-dimension", {
            value: String(literal),
        });
    }

    private checkComponentProperty(path: string, property: string, value: string | number): void {
        const resolved = this.references.resolve(value);
        if (!resolved.ok) {
            this.error(path, resolved.error, resolved.code, resolved.params);
            return;
        }
        const literal = resolved.value;
        switch (property) {
            case "backgroundColor":
            case "textColor":
                if (typeof literal !== "string" || CssColor.parse(literal) === null) {
                    this.warning(path, `${String(value)} is not a color Penpot can use`, "not-color", {
                        value: String(value),
                    });
                }
                break;
            case "typography":
                if (DesignMdReferences.parse(value)?.group !== "typography") {
                    this.warning(
                        path,
                        "typography should reference a typography token, e.g. {typography.label-md}",
                        "typography-reference"
                    );
                }
                break;
            case "rounded":
            case "height":
            case "width":
            case "size":
                if (CssValues.toPx(literal) === null) {
                    this.warning(path, `${String(value)} is not a dimension`, "not-dimension", {
                        value: String(value),
                    });
                }
                break;
            case "padding":
                if (!DesignMdValidator.isPadding(literal)) {
                    this.warning(path, `${String(value)} is not 1 to 4 dimensions`, "not-padding", {
                        value: String(value),
                    });
                }
                break;
            default:
                this.warning(path, `Unknown component property "${property}"`, "unknown-property");
        }
    }

    private checkSections(): void {
        const seen = new Set<string>();
        let lastIndex = -1;
        for (const section of this.document.sections) {
            const key = section.heading.trim().toLowerCase();
            if (seen.has(key)) {
                this.error(section.heading, `The section "${section.heading}" appears twice`, "duplicate-section");
            }
            seen.add(key);
            const index = DesignMdValidator.sectionIndex(section.heading);
            if (index < 0) {
                continue;
            }
            if (index < lastIndex) {
                this.warning(
                    section.heading,
                    `The section "${section.heading}" is out of the usual order`,
                    "section-order"
                );
            }
            lastIndex = Math.max(lastIndex, index);
        }
    }

    private static isPadding(value: unknown): boolean {
        if (typeof value === "number") {
            return true;
        }
        if (typeof value !== "string") {
            return false;
        }
        const parts = value.trim().split(/\s+/);
        return parts.length >= 1 && parts.length <= 4 && parts.every((part) => CssValues.toPx(part) !== null);
    }

    private error(path: string, message: string, code: string, params?: Record<string, string>): void {
        this.issues.push({ severity: "error", path, message, code, ...(params ? { params } : {}) });
    }

    private warning(path: string, message: string, code: string, params?: Record<string, string>): void {
        this.issues.push({ severity: "warning", path, message, code, ...(params ? { params } : {}) });
    }
}
