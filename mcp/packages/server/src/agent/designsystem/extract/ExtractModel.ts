/**
 * Data of the `design-system-extract` workflow (W36): what the inventory script reads from the
 * copied file, the proposal list shown to the user and the source map handed to W30.
 *
 * The copy is made with Penpot's `duplicate-file`, which keeps the ids of pages, shapes,
 * components, library colors and typographies (only the file id and media ids change). So every
 * id the inventory reads in the copy is also the id of the same item in the source file.
 */

/** One page of the copy as the inventory sees it. */
export interface RawPage {
    id: string;
    name: string;
    /** top-level layers that are neither main components nor variant containers */
    screens: number;
    /** main components on the page (nested ones included) */
    mains: number;
    /** W29 overview page kind (`colors`, `typography`, `tokens`) when the page holds one, else null */
    overview: string | null;
}

/** A library component of the copy. */
export interface RawComponent {
    id: string;
    name: string;
    path: string;
    /** id of its main instance shape, or null when it has none */
    mainId: string | null;
    /** page of the main instance, or null */
    pageId: string | null;
    /** copies of it found on the pages */
    instances: number;
    /** the main is a variant of this container, else null */
    variantContainerId: string | null;
    /** first text inside the main (to name generic components), or "" */
    firstText: string;
    /** the main looks like an icon (small, square-ish, vectors only) */
    iconLike: boolean;
    width: number;
    height: number;
}

/** A library color of the copy. */
export interface RawLibraryColor {
    id: string;
    name: string;
    path: string;
    /** `#rrggbb`, or null for gradients and images */
    hex: string | null;
    opacity: number;
    /** fills and strokes that use it (by reference or by the same value) */
    uses: number;
}

/** A library typography of the copy. */
export interface RawLibraryTypography {
    id: string;
    name: string;
    path: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    letterSpacing: string;
    /** texts with the same family, size and weight */
    uses: number;
}

/** A token set of the copy. */
export interface RawTokenSet {
    name: string;
    active: boolean;
    tokens: { name: string; type: string; value: unknown }[];
}

/** A text style used on the pages (family, size, weight) and how often. */
export interface RawFont {
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    letterSpacing: string;
    count: number;
}

/** A drop shadow used on the pages and how often. */
export interface RawShadow {
    offsetX: number;
    offsetY: number;
    blur: number;
    spread: number;
    /** `#rrggbb` */
    hex: string;
    opacity: number;
    count: number;
}

/** Raw values used on the pages, with their counts. */
export interface RawValues {
    /** solid fill colors (`#rrggbb` → count) */
    fills: Record<string, number>;
    /** solid stroke colors (`#rrggbb` → count) */
    strokes: Record<string, number>;
    fonts: RawFont[];
    /** flex/grid gaps and paddings in px (value → count) */
    spacing: Record<string, number>;
    /** corner radius in px (value → count) */
    radius: Record<string, number>;
    shadows: RawShadow[];
}

/** A group or board that is not a component (a component candidate when it repeats). */
export interface RawGroup {
    id: string;
    pageId: string;
    /** top-level board (screen) that holds it */
    screenId: string;
    name: string;
    type: string;
    /** structure signature (layer types and nesting; texts and images count as slots) */
    hash: string;
    /** look signature (fills, strokes, radius of the non-text layers) */
    look: string;
    width: number;
    height: number;
    /** text layers inside */
    texts: number;
    /** ids of the eligible groups that contain it (outer first) */
    ancestors: string[];
}

/** A small vector drawing that is not a component (an icon candidate). */
export interface RawIcon {
    id: string;
    pageId: string;
    name: string;
    width: number;
    height: number;
    /** drawing signature, to drop the same icon drawn twice */
    hash: string;
}

/** Everything the inventory script reads from the copy. */
export interface RawInventory {
    fileName: string;
    /** more layers than the read limit: the counts are partial */
    truncated: boolean;
    pages: RawPage[];
    components: RawComponent[];
    colors: RawLibraryColor[];
    typographies: RawLibraryTypography[];
    tokenSets: RawTokenSet[];
    values: RawValues;
    groups: RawGroup[];
    icons: RawIcon[];
}

/** Kinds of proposals. */
export type ProposalKind =
    | "merge-colors"
    | "color-token"
    | "text-style"
    | "token"
    | "component"
    | "rename-component"
    | "group-components"
    | "icons"
    | "drop-unused";

/** One line of the proposal list (one checkbox, on by default). */
export interface Proposal {
    /** stable id, e.g. `color:#1e88e5`, `component:<first member id>` */
    id: string;
    kind: ProposalKind;
    /** translation code for the client (`penforge.design-system-extract.proposal.<code>`) */
    code: string;
    /** values the client puts into the translated text */
    params: Record<string, unknown>;
    /** English text in plain words (fallback) */
    text: string;
}

/** Section of the list a proposal belongs to (the client groups them). */
export type ProposalSection = "colors" | "text" | "tokens" | "components" | "icons" | "cleanup";

/** Counts shown above the list. */
export interface InventoryStats {
    pages: number;
    screens: number;
    components: number;
    colors: number;
    typographies: number;
    tokens: number;
    rawColors: number;
    truncated: boolean;
}

/** The proposal list. `planId` hashes the proposals; apply refuses another plan. */
export interface ExtractPlan {
    planId: string;
    stats: InventoryStats;
    proposals: Proposal[];
}

/** Planned color token with everything the apply needs. */
export interface PlannedColorToken {
    hex: string;
    opacity: number;
    /** token name, `color.<key>` */
    token: string;
    /** library color it comes from, or null for a raw value */
    libraryColorId: string | null;
}

/** Planned non-color token. */
export interface PlannedValueToken {
    type: "spacing" | "borderRadius" | "shadow";
    name: string;
    /** px value (spacing, radius) or shadow key */
    value: string;
    /** Penpot value (string, or the shadow object list) */
    penpotValue: unknown;
}

/** Planned text style (a new library typography from a raw text style). */
export interface PlannedTextStyle {
    name: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    letterSpacing: string;
}

/** Planned component made of repeated layers; one variant per look. */
export interface PlannedComponent {
    name: string;
    /** every repeated layer, by look */
    members: string[];
    variants: { sampleId: string; pageId: string; name: string; members: string[] }[];
}

/**
 * Everything a plan would change, with ids; the proposals are its user-facing view. Built again
 * at apply time from the same inventory and filtered by the accepted proposal ids.
 */
export interface ExtractDetails {
    colors: PlannedColorToken[];
    /** merged hex → kept hex, and the token names the dropped values get when not merged */
    merges: {
        proposalId: string;
        keep: string;
        drop: { hex: string; altToken: string; libraryColorId: string | null }[];
    }[];
    textStyles: { proposalId: string; style: PlannedTextStyle }[];
    tokens: { proposalId: string; token: PlannedValueToken }[];
    components: { proposalId: string; component: PlannedComponent }[];
    renames: { proposalId: string; componentId: string; name: string }[];
    groups: { proposalId: string; path: string; componentIds: string[] }[];
    icons: { proposalId: string; shapes: { id: string; pageId: string; name: string }[]; componentIds: string[] };
    unused: { proposalId: string; kind: "color" | "typography" | "component"; id: string; name: string }[];
}
