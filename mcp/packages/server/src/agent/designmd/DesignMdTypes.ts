/**
 * Data model of a DESIGN.md file (see `wiki/research/design-md-format.md`).
 *
 * The front matter follows the public Google Labs DESIGN.md format (version `alpha`); the body is
 * kept as a preamble plus `##` sections.
 */

/** Typography token: a composite of font properties. */
export interface DesignMdTypography {
    fontFamily?: string;
    /** dimension (`16px`, `1rem`) */
    fontSize?: string;
    fontWeight?: number | string;
    /** dimension or unitless multiplier */
    lineHeight?: number | string;
    /** dimension */
    letterSpacing?: string;
    fontFeature?: string;
    fontVariation?: string;
    [property: string]: unknown;
}

/** Component token: property name to a literal or a token reference. */
export type DesignMdComponent = Record<string, string | number>;

/** Section the author intentionally left out. */
export type DesignMdOmitted = string | { section: string; reason?: string };

/** Machine-readable part of a DESIGN.md (the YAML front matter). */
export interface DesignMdTokens {
    version?: string;
    name?: string;
    description?: string;
    omitted?: DesignMdOmitted[];
    colors: Record<string, string>;
    typography: Record<string, DesignMdTypography>;
    rounded: Record<string, string | number>;
    spacing: Record<string, string | number>;
    components: Record<string, DesignMdComponent>;
    /** unknown top-level keys, kept for the round trip */
    extra: Record<string, unknown>;
}

/** A `##` section of the Markdown body. */
export interface DesignMdSection {
    /** heading text without the `## ` marker */
    heading: string;
    /** text below the heading, without surrounding blank lines */
    body: string;
}

/** A parsed DESIGN.md. */
export interface DesignMdDocument {
    tokens: DesignMdTokens;
    /** body text before the first `##` heading, without surrounding blank lines */
    preamble: string;
    sections: DesignMdSection[];
}

/** Problem found in a DESIGN.md. */
export interface DesignMdIssue {
    severity: "error" | "warning";
    /** dotted path of the offending value (`colors.primary`), or a section name */
    path: string;
    /** English description (developers, logs) */
    message: string;
    /** stable code the panel translates; see `wiki/research/design-md-format.md` */
    code: string;
    /** values the translated text needs (`value`, `reference`…) */
    params?: Record<string, string>;
}

/** Token groups of the front matter that hold scalar or composite tokens. */
export type DesignMdTokenGroup = "colors" | "typography" | "rounded" | "spacing" | "components";

/** Creates an empty token set. */
export function emptyDesignMdTokens(): DesignMdTokens {
    return { colors: {}, typography: {}, rounded: {}, spacing: {}, components: {}, extra: {} };
}
