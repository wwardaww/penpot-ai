/**
 * Plugin API code run by the `generate-screen` workflow through the `execute_code` tool.
 *
 * Each builder returns the body of a function run in the Penpot plugin context (globals `penpot`,
 * `penpotUtils`, `storage`); arguments are inlined as JSON. Results come back as JSON text.
 */

/** Library token as read from the file. */
export interface DesignToken {
    name: string;
    type: string;
    value: string | null;
    set: string;
}

/** Library color. */
export interface DesignColor {
    id: string;
    name: string;
    path: string;
    color: string | null;
    opacity: number | null;
    library: string;
}

/** Library typography. */
export interface DesignTypography {
    id: string;
    name: string;
    path: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    library: string;
}

/** Library component. */
export interface DesignComponent {
    id: string;
    name: string;
    path: string;
    library: string;
}

/** Layer the user picked as a reference. */
export interface ReferenceNode {
    id: string;
    name: string;
    type: string;
    pageId: string;
}

/** Design system and target page of a file, read before generating. */
export interface DesignSystemSnapshot {
    fileId: string | null;
    page: { id: string; name: string };
    /** right edge of the top-level layers of the page (where a new board can go), or null if empty */
    freeX: number | null;
    /** top edge of the top-level layers of the page, or null if empty */
    topY: number | null;
    tokens: DesignToken[];
    colors: DesignColor[];
    typographies: DesignTypography[];
    components: DesignComponent[];
    references: ReferenceNode[];
    /** true when a list was cut at its limit */
    truncated: boolean;
}

/** Board created for the new screen. */
export interface CreatedBoard {
    boardId: string;
    pageId: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Facts about a generated board, used for the self-review and the result. */
export interface BoardInspection {
    found: boolean;
    boardId: string;
    name: string;
    width: number;
    height: number;
    /** layers below the board (not counting the inside of component instances) */
    layerCount: number;
    /** component instances placed in the board */
    instanceCount: number;
    /** names of the components used, without duplicates */
    componentNames: string[];
    /** layers with at least one applied token */
    tokenizedLayerCount: number;
    /** names of the tokens applied, without duplicates */
    tokenNames: string[];
    /** boards (the screen included) with a flex or grid layout */
    layoutContainerCount: number;
    /** names of boards with two or more children and no flex/grid layout */
    containersWithoutLayout: string[];
    /** names of layers still called after their type ("Rectangle", "Board 2") */
    genericNames: string[];
    /** fills with a raw color (no library color, no color token), the screen board not counted */
    rawColorFillCount: number;
    /** layers placed with absolute position inside a flex/grid parent */
    absoluteLayerCount: number;
}

/** Limits of the snapshot lists, to keep the prompt small. */
export const SNAPSHOT_LIMITS = { tokens: 300, colors: 120, typographies: 60, components: 150 } as const;

/**
 * Code reading the design system of the open file and the free space of the target page.
 *
 * @param args - target page (current page when omitted) and the reference node ids
 */
export function readDesignSystemCode(args: { pageId?: string; referenceNodeIds: string[] }): string {
    return `
const args = ${JSON.stringify({ ...args, limits: SNAPSHOT_LIMITS })};
let truncated = false;
const cut = (list, limit) => {
    if (list.length > limit) { truncated = true; return list.slice(0, limit); }
    return list;
};
const file = penpot.currentFile;
const pages = file ? file.pages : [penpot.currentPage];
const page = (args.pageId && pages.find((p) => p.id === args.pageId)) || penpot.currentPage;
if (!page) { throw new Error("No page is open"); }
let freeX = null;
let topY = null;
const roots = page.root ? page.root.children : [];
for (const shape of roots) {
    const right = shape.x + shape.width;
    freeX = freeX === null ? right : Math.max(freeX, right);
    topY = topY === null ? shape.y : Math.min(topY, shape.y);
}
const libraries = [{ name: "local", lib: penpot.library.local }].concat(
    (penpot.library.connected || []).map((lib) => ({ name: lib.name, lib }))
);
const tokens = [];
const catalog = penpot.library.local.tokens;
for (const set of catalog ? catalog.sets : []) {
    if (!set.active) { continue; }
    for (const token of set.tokens) {
        tokens.push({
            name: token.name,
            type: token.type,
            value: token.resolvedValueString === undefined ? null : token.resolvedValueString,
            set: set.name,
        });
    }
}
const colors = [];
const typographies = [];
const components = [];
for (const { name: library, lib } of libraries) {
    for (const c of lib.colors || []) {
        colors.push({ id: c.id, name: c.name, path: c.path || "", color: c.color || null,
            opacity: c.opacity === undefined ? null : c.opacity, library });
    }
    for (const t of lib.typographies || []) {
        typographies.push({ id: t.id, name: t.name, path: t.path || "", fontFamily: t.fontFamily,
            fontSize: String(t.fontSize), fontWeight: String(t.fontWeight),
            lineHeight: String(t.lineHeight), library });
    }
    for (const c of lib.components || []) {
        components.push({ id: c.id, name: c.name, path: c.path || "", library });
    }
}
const references = [];
for (const id of args.referenceNodeIds) {
    for (const p of pages) {
        const shape = p.getShapeById ? p.getShapeById(id) : null;
        if (shape) { references.push({ id: shape.id, name: shape.name, type: shape.type, pageId: p.id }); break; }
    }
}
return {
    fileId: file ? file.id : null,
    page: { id: page.id, name: page.name },
    freeX,
    topY,
    tokens: cut(tokens, args.limits.tokens),
    colors: cut(colors, args.limits.colors),
    typographies: cut(typographies, args.limits.typographies),
    components: cut(components, args.limits.components),
    references,
    truncated,
};
`;
}

/**
 * Code creating the empty screen board: opens the page, places and sizes the board, adds a vertical
 * flex layout and the safe-area guides.
 */
export function createBoardCode(args: {
    pageId: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    guides: number[];
}): string {
    return `
const args = ${JSON.stringify(args)};
if (!penpot.currentPage || penpot.currentPage.id !== args.pageId) {
    const page = penpot.currentFile.pages.find((p) => p.id === args.pageId);
    if (!page) { throw new Error("Page not found: " + args.pageId); }
    await penpot.openPage(page);
}
const board = penpot.createBoard();
board.name = args.name;
board.x = args.x;
board.y = args.y;
board.resize(args.width, args.height);
board.clipContent = true;
board.fills = [{ fillColor: "#FFFFFF", fillOpacity: 1 }];
const flex = board.addFlexLayout();
flex.dir = "column";
flex.alignItems = "stretch";
flex.justifyContent = "start";
for (const offset of args.guides) {
    board.addRulerGuide("horizontal", offset);
}
return { boardId: board.id, pageId: penpot.currentPage.id, name: board.name,
    x: board.x, y: board.y, width: board.width, height: board.height };
`;
}

/**
 * Code inspecting a generated board (names, components, tokens, layouts, raw colors).
 */
export function inspectBoardCode(args: { boardId: string }): string {
    return `
const args = ${JSON.stringify(args)};
const generic = /^(board|rectangle|ellipse|text|group|path|image|bool|boolean|frame|layer|container|svg|component|copy)( ?\\d+)?$/i;
let board = penpot.currentPage ? penpot.currentPage.getShapeById(args.boardId) : null;
if (!board && penpot.currentFile) {
    for (const page of penpot.currentFile.pages) {
        board = page.getShapeById(args.boardId);
        if (board) { break; }
    }
}
const result = {
    found: !!board, boardId: args.boardId, name: board ? board.name : "",
    width: board ? board.width : 0, height: board ? board.height : 0,
    layerCount: 0, instanceCount: 0, componentNames: [], tokenizedLayerCount: 0, tokenNames: [],
    layoutContainerCount: 0, containersWithoutLayout: [], genericNames: [], rawColorFillCount: 0,
    absoluteLayerCount: 0,
};
if (!board) { return result; }
const componentNames = new Set();
const tokenNames = new Set();
const visit = (shape, isRoot, parentHasLayout) => {
    if (!isRoot) { result.layerCount += 1; }
    if (generic.test(shape.name.trim())) { result.genericNames.push(shape.name); }
    const tokens = Object.values(shape.tokens || {});
    if (tokens.length > 0) { result.tokenizedLayerCount += 1; tokens.forEach((t) => tokenNames.add(t)); }
    const fillToken = shape.tokens && shape.tokens.fill;
    // the screen board keeps the white fill it was created with
    if (!isRoot && Array.isArray(shape.fills) && !fillToken) {
        for (const fill of shape.fills) {
            if (fill.fillColor && !fill.fillColorRefId) { result.rawColorFillCount += 1; }
        }
    }
    if (!isRoot && parentHasLayout && shape.layoutChild && shape.layoutChild.absolute) {
        result.absoluteLayerCount += 1;
    }
    if (!isRoot && shape.isComponentInstance && shape.isComponentInstance()) {
        result.instanceCount += 1;
        const component = shape.component ? shape.component() : null;
        if (component) { componentNames.add(component.name); }
        return;
    }
    const hasLayout = !!(shape.flex || shape.grid);
    const children = shape.children || [];
    if (shape.type === "board") {
        if (hasLayout) { result.layoutContainerCount += 1; }
        else if (children.length >= 2) { result.containersWithoutLayout.push(shape.name); }
    }
    for (const child of children) { visit(child, false, hasLayout); }
};
visit(board, true, false);
result.componentNames = [...componentNames];
result.tokenNames = [...tokenNames];
return result;
`;
}
