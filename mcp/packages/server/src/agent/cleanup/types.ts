/**
 * Types of the tidy-up (W17 `cleanup-import`): the layer records read from the canvas, the
 * proposals the heuristics make, and the report of a run.
 */

/** Plugin API shape types the cleanup reads. */
export type CleanupShapeType =
    "board" | "group" | "rectangle" | "ellipse" | "path" | "text" | "boolean" | "image" | "svg-raw" | string;

/** Component role of a layer: anything but `null` is left alone by the structural steps. */
export type ComponentRole = "main" | "copy" | "variant" | null;

/**
 * One layer as read by the scan script. Geometry is absolute (page coordinates), rounded to
 * two decimals.
 */
export interface CleanupNode {
    id: string;
    name: string;
    type: CleanupShapeType;
    /** null for children of the page root */
    parentId: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
    /** rotated or flipped: never moved into a layout */
    transformed: boolean;
    visible: boolean;
    opacity: number;
    /** group used as a mask */
    mask: boolean;
    /** number of prototype interactions on the layer */
    interactions: number;
    component: ComponentRole;
    /** component of a copy root (look-alike items must use the same one) */
    componentRef?: string | null;
    /** layout of a board */
    layout: "flex" | "grid" | null;
    /** absolute child of a layout */
    absolute: boolean;
    /** clips its content (boards) */
    clip: boolean;
    /** fills without images, as a comparable string */
    fills: string;
    /** has an image fill */
    image: boolean;
    /** fills that draw something (any fill with opacity > 0) */
    painted: boolean;
    strokes: string;
    /** shadows and blur, as a comparable string ("" = none) */
    effects: string;
    radius: string;
    /** text layers only */
    text?: { content: string; font: string; grow: string };
    /** children ids, bottom to top */
    children: string[];
}

/** Units of a scan: the top-level layers whose screenshots are compared. */
export interface CleanupScan {
    pageId: string;
    pageName: string;
    /** top-level layers (children of the page root) to tidy up */
    units: string[];
    nodes: Map<string, CleanupNode>;
    /** layers the run may change (subtrees of the selection, or every layer of the units) */
    scope: Set<string>;
    /** some unit had more layers than the scan reads */
    truncated: boolean;
}

/** Why a layer counts as junk. */
export type JunkReason = "hidden" | "transparent" | "empty-group" | "empty-board" | "zero-size";

export interface JunkProposal {
    id: string;
    kind: "junk";
    unitId: string;
    nodeId: string;
    name: string;
    reason: JunkReason;
}

/** Edge paddings of a layout. */
export interface Padding {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

/** Flex layout to give a container. */
export interface FlexPlan {
    type: "flex";
    dir: "row" | "column";
    gap: number;
    align: "start" | "center" | "end";
    padding: Padding;
    /** flow children, in visual order */
    order: string[];
}

/** Grid layout to give a container (fixed tracks). */
export interface GridPlan {
    type: "grid";
    columns: number[];
    rows: number[];
    columnGap: number;
    rowGap: number;
    padding: Padding;
    /** flow children with their 1-based cell */
    cells: { id: string; row: number; column: number }[];
}

export interface LayoutProposal {
    id: string;
    kind: "layout";
    unitId: string;
    nodeId: string;
    name: string;
    /** the container is a group that becomes a board first */
    convert: boolean;
    /** depth below the unit (deepest first when applying) */
    depth: number;
    layout: FlexPlan | GridPlan;
    /** children kept where they are (absolute): under every flow child, or over them */
    absoluteBelow: string[];
    absoluteAbove: string[];
    /** board sizing after the change: groups hug their content, boards keep their size */
    sizing: "fix" | "auto";
    /** name of the board a group becomes, when not the group's own (a default "Group 4" → "Board") */
    boardName?: string;
}

export interface ComponentProposal {
    id: string;
    kind: "component";
    /** look-alike layers, reading order; the first becomes the main component */
    memberIds: string[];
    unitIds: string[];
    /** name of the first member */
    name: string;
    width: number;
    height: number;
    /** layers in one member */
    size: number;
}

export type CleanupProposal = JunkProposal | LayoutProposal | ComponentProposal;

/** Pixel comparison of two screenshots. */
export interface DiffScore {
    /** share of differing pixels, 0..1 (1 when the sizes differ) */
    ratio: number;
    width: number;
    height: number;
    sameSize: boolean;
}

/** What happened to one proposal. */
export type ProposalOutcome = "applied" | "reverted" | "failed" | "skipped";

/** Report of one unit (top-level layer). */
export interface UnitReport {
    id: string;
    name: string;
    junkRemoved: number;
    junkReverted: number;
    layoutsApplied: number;
    layoutsReverted: number;
    /** highest pixel difference kept in this unit (0..1) */
    maxDiff: number;
    /** layer names that got a layout */
    layouts: { name: string; type: "flex" | "grid"; dir?: "row" | "column" }[];
}

export interface ComponentReport {
    name: string;
    componentId: string | null;
    instances: number;
    outcome: ProposalOutcome;
    diff: number;
}

/** `result` payload of `cleanup-import`. */
export interface CleanupResult {
    pageId: string;
    pageName: string;
    dryRun: boolean;
    truncated: boolean;
    checkpoint: { id: string; n: number } | null;
    units: UnitReport[];
    components: ComponentReport[];
    totals: {
        junk: number;
        layouts: number;
        layoutsReverted: number;
        components: number;
        instances: number;
        componentsReverted: number;
        renamed: number;
    };
    /** proposals (dry run only, or when nothing was applied) */
    proposals?: CleanupProposal[];
    /** proposal ids Claude asked to skip */
    skipped: string[];
    /** short notes from Claude's review */
    notes: string | null;
    threshold: number;
}
