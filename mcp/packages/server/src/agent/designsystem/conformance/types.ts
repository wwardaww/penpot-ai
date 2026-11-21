/**
 * Shapes shared by the design system binding (W30): what the plugin scripts read from the open
 * file, what the checker finds and the fixes it plans.
 */

/** Library color of the linked design system. */
export interface SystemColor {
    id: string;
    name: string;
    path: string;
    /** lowercase `#rrggbb` */
    hex: string;
    opacity: number;
}

/** Text style of the linked design system. */
export interface SystemTypography {
    id: string;
    name: string;
    path: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: string;
}

/** Component of the linked design system. */
export interface SystemComponent {
    id: string;
    name: string;
    path: string;
}

/** Token of the linked design system with its resolved value. */
export interface SystemToken {
    name: string;
    type: string;
    /** `#rrggbb` for colors, a number for dimensions, the raw text otherwise */
    value: string | number | null;
}

/** What the open file sees of the linked design system library. */
export interface SystemCatalog {
    libraryId: string;
    name: string;
    /** the library is linked to the open file */
    linked: boolean;
    /** the library is the file's tokens source */
    tokensSource: boolean;
    colors: SystemColor[];
    typographies: SystemTypography[];
    components: SystemComponent[];
    tokens: SystemToken[];
}

/** Solid paint of a layer (gradients and images are left alone). */
export interface RawPaint {
    index: number;
    hex: string;
    opacity: number;
    refId: string | null;
    refFile: string | null;
}

/** Component link of a layer. */
export interface RawComponentLink {
    id: string;
    name: string;
    path: string;
    libraryId: string | null;
    main: boolean;
    copy: boolean;
}

/** One layer as the scan script reads it. */
export interface RawLayer {
    id: string;
    name: string;
    type: string;
    pageId: string;
    boardId: string;
    boardName: string;
    /** a top-level board (a screen) */
    topLevel: boolean;
    /** parent layer id, null at the page root */
    parentId: string | null;
    /** inside a component copy (its styles belong to the component) */
    insideCopy: boolean;
    /** ids of the component mains this layer sits in (nearest first) */
    insideMains: string[];
    fills: RawPaint[];
    strokes: RawPaint[];
    /** applied tokens, property → token name */
    tokens: Record<string, string>;
    text: { fontFamily: string; fontSize: number | null; fontWeight: string } | null;
    radius: number | null;
    /** flex/grid gaps and paddings, property → px */
    spacing: Record<string, number> | null;
    shadows: number;
    childCount: number;
    component: RawComponentLink | null;
}

/** Result of the scan script. */
export interface ScanResult {
    layers: RawLayer[];
    truncated: boolean;
    pages: { id: string; name: string }[];
}

/** Stable codes of fixes and findings (clients translate them). */
export type FixCode =
    "color" | "color-linked" | "typography" | "radius" | "spacing" | "component" | "swap" | "token-linked";

/** Ordering of fix ops in one run: swaps first, so a replaced main has no copies left. */
export const OP_ORDER: Record<FixOp["op"], number> = {
    swap: 0,
    fill: 1,
    stroke: 1,
    typography: 1,
    token: 1,
    replace: 2,
};

export type FindingCode =
    | "off-color"
    | "off-typography"
    | "off-shadow"
    | "off-radius"
    | "off-spacing"
    | "local-component"
    | "foreign-component";

/** One change the fix script makes. */
export type FixOp =
    | {
          op: "fill" | "stroke";
          layerId: string;
          index: number;
          colorId: string | null;
          token: string | null;
          hex: string;
      }
    | { op: "typography"; layerId: string; typographyId: string }
    | { op: "token"; layerId: string; token: string; properties: string[]; value: number }
    | { op: "swap"; layerId: string; componentId: string }
    | { op: "replace"; layerId: string; componentId: string };

/** A planned fix with its explanation. */
export interface Fix {
    code: FixCode;
    pageId: string;
    layerId: string;
    layerName: string;
    boardName: string;
    /** values for the client's wording (`from`, `to`, `name`) */
    params: Record<string, string | number>;
    /** English explanation in plain words */
    text: string;
    ops: FixOp[];
    /** a value that already matched and only got linked: counted, not explained */
    quiet: boolean;
}

/** Drift the checker could not fix by itself. */
export interface Finding {
    code: FindingCode;
    pageId: string;
    layerId: string;
    layerName: string;
    boardName: string;
    params: Record<string, string | number>;
    text: string;
}

/** Kinds of items the design system misses. */
export type MissingKind = "component" | "color" | "typography" | "token" | "icon";

/** Something the design needs that the design system does not have. */
export interface MissingItem {
    /** stable id: `<kind>:<normalized name>` */
    id: string;
    kind: MissingKind;
    name: string;
    /** short reason in plain words (English; the AI writes it in the user's persona) */
    reason: string;
    /** local component of the project that stands for it */
    componentId?: string;
    /** layers that use it */
    layerIds?: string[];
    status: "open" | "kept" | "adding" | "added";
    /** who found it: the AI while designing, or the check */
    source: "ai" | "check";
    reportedAt: string;
    /** design system component made for it (after "Add to design system") */
    systemComponentId?: string;
}

/** What one check found and fixed. */
export interface CheckReport {
    fixes: Fix[];
    findings: Finding[];
    missing: MissingItem[];
    scanned: number;
    truncated: boolean;
}
