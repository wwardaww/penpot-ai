import type { ComponentProposal, JunkProposal, LayoutProposal } from "./types";

/**
 * Plugin API code of the tidy-up, run with `execute_code` (natural child ordering is on there:
 * `children` of a flex board are in visual order, of other containers bottom to top).
 *
 * Every script that changes the design opens the page first and returns a JSON string. Layout
 * scripts wrap their changes in one undo block. A junk or component step spans two scripts (apply,
 * then keep or take back) and stays one undo block: the first script opens it and keeps it in the
 * plugin's persistent `storage`, the second closes it ({@link CleanupScripts.closeStep} closes a
 * block left open by a failed step).
 */
export class CleanupScripts {
    /** most layers read per unit */
    public static readonly MAX_UNIT_NODES = 6000;
    /** most time one layout script spends before leaving the rest for the next call */
    public static readonly LAYOUT_SCRIPT_BUDGET_MS = 30_000;

    private static readonly PRELUDE = `
const ZERO = "00000000-0000-0000-0000-000000000000";
const safe = (fn, fallback) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } };
const file = penpot.currentFile;
if (!file) { throw new Error("No Penpot file is open"); }
const openPage = async (pageId) => {
  const page = file.pages.find((p) => p.id === pageId);
  if (!page) { throw new Error("Page not found: " + pageId); }
  if (!penpot.currentPage || penpot.currentPage.id !== page.id) { await penpot.openPage(page); }
  return penpot.currentPage || page;
};
const message = (e) => String((e && e.message) || e);
const STEP = "penforgeCleanupBlock";
const endStep = () => {
  const block = storage[STEP];
  storage[STEP] = null;
  if (block) { penpot.history.undoBlockFinish(block); }
};
const beginStep = () => {
  endStep();
  storage[STEP] = penpot.history.undoBlockBegin();
};
`;

    /** Marks of the layers a component step made (shared plugin data), and taking them back. */
    private static readonly MARKS = `
const MARK = (shape, value) => safe(() => shape.setSharedPluginData("penforge", "cleanupStep", value), null);
const MARKED = (shape) => safe(() => shape.getSharedPluginData("penforge", "cleanupStep"), "") || "";
const everyShape = (root) => {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const shape = stack.pop();
    out.push(shape);
    for (const child of (safe(() => shape.children, []) || [])) { stack.push(child); }
  }
  return out;
};
const undoMarked = (page, key, memberIds) => {
  const marked = everyShape(page.root).filter((shape) => MARKED(shape).startsWith(key + ":"));
  const main = marked.find((shape) => MARKED(shape) === key + ":main");
  for (const shape of marked) {
    if (MARKED(shape) === key + ":copy") { safe(() => shape.remove(), null); }
  }
  if (main) {
    const component = safe(() => main.component(), null);
    if (component) { component.remove(); }
  }
  for (const id of memberIds) {
    const member = page.getShapeById(id);
    if (member) { member.visible = true; }
  }
  const backup = marked.find((shape) => MARKED(shape) === key + ":backup");
  if (backup && page.getShapeById(backup.id)) {
    if (main) { backup.visible = true; MARK(backup, ""); } else { backup.remove(); }
  }
};
`;

    /**
     * Lists the units to tidy up: the page's top-level layers, or the top-level ancestors of the
     * given layers, and the layers comment threads point at. JSON `{pageId, pageName, units:[{id,
     * name, type}], scopeRoots, commented}`.
     */
    public static plan(params: { pageId: string | null; nodeIds: string[] }): string {
        return `${CleanupScripts.PRELUDE}
const P = ${JSON.stringify(params)};
const page = P.pageId ? file.pages.find((p) => p.id === P.pageId) : penpot.currentPage;
if (!page) { throw new Error("Page not found"); }
const top = (shape) => {
  let current = shape;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = safe(() => current.parent, null);
    if (!parent || parent.id === ZERO) { return current; }
    current = parent;
  }
  return current;
};
const units = [];
const roots = [];
if (P.nodeIds.length === 0) {
  for (const shape of safe(() => page.root.children, []) || []) {
    units.push({ id: shape.id, name: shape.name, type: shape.type });
  }
} else {
  for (const id of P.nodeIds) {
    const shape = page.getShapeById(id);
    if (!shape) { continue; }
    roots.push(shape.id);
    const unit = top(shape);
    if (unit && !units.some((u) => u.id === unit.id)) { units.push({ id: unit.id, name: unit.name, type: unit.type }); }
  }
}
// layers comment threads point at: removing or replacing them would lose the thread's anchor
const commented = [];
let threads = [];
try { threads = (await page.findCommentThreads({ onlyYours: false, showResolved: true })) || []; } catch (e) { threads = []; }
for (const thread of threads) {
  const board = safe(() => thread.board, null);
  if (board && board.id) { commented.push(board.id); }
  const nodeId = safe(() => thread.nodeId, null);
  if (typeof nodeId === "string") { commented.push(nodeId); }
}
return JSON.stringify({ pageId: page.id, pageName: page.name, units, scopeRoots: roots, commented });
`;
    }

    /**
     * Reads one unit's layers depth first (at most {@link MAX_UNIT_NODES}). JSON `{nodes,
     * truncated}`; records follow `CleanupNode`.
     */
    public static read(params: { pageId: string; unitId: string; limit?: number }): string {
        const limit = params.limit ?? CleanupScripts.MAX_UNIT_NODES;
        return `${CleanupScripts.PRELUDE}
const P = ${JSON.stringify({ ...params, limit })};
const page = file.pages.find((p) => p.id === P.pageId);
if (!page) { throw new Error("Page not found: " + P.pageId); }
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const color = (c) => c ? [c.color || "", r2(c.opacity === undefined ? 1 : c.opacity)].join("/") : "";
const gradient = (g) => g ? [g.type, r2(g.startX), r2(g.startY), r2(g.endX), r2(g.endY), (g.stops || []).map((s) => [s.color, r2(s.opacity), r2(s.offset)].join(":")).join(";")].join("~") : "";
const fillsOf = (shape) => {
  const fills = safe(() => shape.fills, []);
  if (!Array.isArray(fills)) { return { sig: String(fills), image: false, painted: true }; }
  let image = false;
  let painted = false;
  const sig = fills.map((f) => {
    const opacity = f.fillOpacity === undefined ? 1 : f.fillOpacity;
    if (opacity > 0) { painted = true; }
    if (f.fillImage) { image = true; return "img/" + r2(opacity); }
    if (f.fillColorGradient) { return "grad/" + gradient(f.fillColorGradient) + "/" + r2(opacity); }
    return (f.fillColor || "") + "/" + r2(opacity);
  }).join(",");
  return { sig, image, painted };
};
const strokesOf = (shape) => (safe(() => shape.strokes, []) || [])
  .map((s) => [s.strokeColor || "", r2(s.strokeOpacity === undefined ? 1 : s.strokeOpacity), r2(s.strokeWidth), s.strokeAlignment || "", s.strokeStyle || "", gradient(s.strokeColorGradient)].join("/")).join(",");
const effectsOf = (shape) => {
  const shadows = (safe(() => shape.shadows, []) || []).filter((s) => !s.hidden)
    .map((s) => [s.style, r2(s.offsetX), r2(s.offsetY), r2(s.blur), r2(s.spread), color(s.color)].join("/"));
  const blur = safe(() => shape.blur, null);
  if (blur && !blur.hidden && blur.value) { shadows.push("blur/" + r2(blur.value)); }
  const blend = safe(() => shape.blendMode, "normal");
  if (blend && blend !== "normal") { shadows.push("blend/" + blend); }
  return shadows.join(",");
};
const radiusOf = (shape) => {
  const values = [safe(() => shape.borderRadiusTopLeft, 0), safe(() => shape.borderRadiusTopRight, 0), safe(() => shape.borderRadiusBottomRight, 0), safe(() => shape.borderRadiusBottomLeft, 0)];
  return values.map(r2).join("/");
};
const roleOf = (shape) => {
  if (safe(() => shape.isVariantContainer(), false) || safe(() => shape.isVariantHead(), false)) { return "variant"; }
  if (safe(() => shape.isComponentMainInstance(), false)) { return "main"; }
  if (safe(() => shape.isComponentCopyInstance(), false) || safe(() => shape.isComponentInstance(), false)) { return "copy"; }
  return null;
};
const record = (shape, children) => {
  const parent = safe(() => shape.parent, null);
  const fills = fillsOf(shape);
  const role = roleOf(shape);
  const flex = shape.type === "board" ? safe(() => shape.flex, null) : null;
  const grid = shape.type === "board" ? safe(() => shape.grid, null) : null;
  const layoutChild = safe(() => shape.layoutChild, null);
  const fontParts = shape.type === "text"
    ? [safe(() => shape.fontFamily, ""), safe(() => shape.fontSize, ""), safe(() => shape.fontWeight, ""), safe(() => shape.fontStyle, ""), safe(() => shape.lineHeight, ""), safe(() => shape.letterSpacing, ""), safe(() => shape.textAlign, ""), safe(() => shape.textDecoration, ""), safe(() => shape.textTransform, "")]
    : [];
  const text = shape.type === "text" ? {
    content: String(safe(() => shape.characters, "")).slice(0, 200),
    font: fontParts.concat([fills.sig]).join("|"),
    grow: String(safe(() => shape.growType, "fixed")),
    // styles that change inside the text: setting its characters would lose them
    mixed: fontParts.some((v) => v === "mixed") || !Array.isArray(safe(() => shape.fills, [])),
  } : undefined;
  const rotation = safe(() => shape.rotation, 0) || 0;
  const flipped = !!safe(() => shape.flipX, false) || !!safe(() => shape.flipY, false);
  const component = role === "copy" && safe(() => shape.isComponentHead(), false) ? safe(() => shape.component(), null) : null;
  return {
    id: shape.id,
    name: shape.name,
    type: shape.type,
    parentId: parent && parent.id !== ZERO ? parent.id : null,
    x: r2(safe(() => shape.x, 0)),
    y: r2(safe(() => shape.y, 0)),
    width: r2(safe(() => shape.width, 0)),
    height: r2(safe(() => shape.height, 0)),
    transformed: Math.abs(rotation) > 0.01 || flipped,
    visible: safe(() => shape.visible, true) !== false,
    opacity: r2(safe(() => shape.opacity, 1)),
    mask: shape.type === "group" && !!safe(() => shape.isMask(), false),
    interactions: (safe(() => shape.interactions, []) || []).length,
    exports: (safe(() => shape.exports, []) || []).length,
    constraints: [safe(() => shape.constraintsHorizontal, "") || "", safe(() => shape.constraintsVertical, "") || ""].join("/"),
    component: role,
    componentRef: component ? component.id : null,
    layout: flex ? "flex" : (grid ? "grid" : null),
    absolute: !!(layoutChild && safe(() => layoutChild.absolute, false)),
    clip: shape.type === "board" ? safe(() => shape.clipContent, true) !== false : false,
    fills: fills.sig,
    image: fills.image,
    painted: fills.painted,
    strokes: strokesOf(shape),
    effects: effectsOf(shape),
    radius: shape.type === "rectangle" || shape.type === "board" ? radiusOf(shape) : "",
    text,
    children: children.map((child) => child.id),
  };
};
const unit = page.getShapeById(P.unitId);
if (!unit) { throw new Error("Layer not found: " + P.unitId); }
const nodes = [];
const stack = [unit];
let truncated = false;
while (stack.length > 0) {
  const shape = stack.pop();
  if (nodes.length >= P.limit) { truncated = true; break; }
  const isFlex = shape.type === "board" && !!safe(() => shape.flex, null);
  let children = safe(() => shape.children, []) || [];
  // flex boards list children in visual order; records keep bottom to top
  if (isFlex) { children = children.slice().reverse(); }
  nodes.push(record(shape, children));
  for (let i = children.length - 1; i >= 0; i--) { stack.push(children[i]); }
}
return JSON.stringify({ nodes, truncated });
`;
    }

    /**
     * Opens the junk step's undo block and hides the junk layers that are still visible.
     * JSON `{hidden:[id], missing:[id]}`. Finish with {@link junkFinish}.
     */
    public static junkHide(pageId: string, items: JunkProposal[]): string {
        return `${CleanupScripts.PRELUDE}
const P = ${JSON.stringify({ pageId, ids: items.map((item) => item.nodeId) })};
const page = await openPage(P.pageId);
const hidden = [];
const missing = [];
beginStep();
try {
  for (const id of P.ids) {
    const shape = page.getShapeById(id);
    if (!shape) { missing.push(id); continue; }
    if (shape.visible !== false) { shape.visible = false; hidden.push(id); }
  }
} catch (e) {
  for (const id of hidden) {
    const shape = page.getShapeById(id);
    if (shape) { shape.visible = true; }
  }
  endStep();
  throw e;
}
return JSON.stringify({ hidden, missing });
`;
    }

    /**
     * Ends the junk step: shows `showIds` again (taken back) and removes `removeIds` (kept), then
     * closes the step's undo block. JSON `{removed, shown}`.
     */
    public static junkFinish(pageId: string, removeIds: string[], showIds: string[]): string {
        return `${CleanupScripts.PRELUDE}
const P = ${JSON.stringify({ pageId, removeIds, showIds })};
const page = await openPage(P.pageId);
let removed = 0;
let shown = 0;
try {
  for (const id of P.showIds) {
    const shape = page.getShapeById(id);
    if (shape) { shape.visible = true; shown++; }
  }
  for (const id of P.removeIds) {
    const shape = page.getShapeById(id);
    if (shape) { shape.remove(); removed++; }
  }
} finally {
  endStep();
}
return JSON.stringify({ removed, shown });
`;
    }

    /** Closes a step's undo block left open (a step that failed between its two scripts). */
    public static closeStep(): string {
        return `${CleanupScripts.PRELUDE}
endStep();
return JSON.stringify({ closed: true });
`;
    }

    /**
     * Gives containers their layouts, deepest first, in one undo block. Groups become boards
     * (same name, place, size and constraints, no fill, no clipping) first. `remap` maps ids of
     * groups that became boards earlier in the run to the new board ids. Items left when
     * `budgetMs` is spent come back `deferred` (not touched).
     *
     * JSON `{results:[{id, ok, deferred?, error?, undo?}], remap}`; `undo` is the input of
     * {@link revertLayouts}.
     */
    public static applyLayouts(
        pageId: string,
        items: LayoutProposal[],
        remap: Record<string, string>,
        budgetMs = CleanupScripts.LAYOUT_SCRIPT_BUDGET_MS
    ): string {
        return `${CleanupScripts.PRELUDE}
const P = ${JSON.stringify({ pageId, items, remap, budgetMs })};
const started = Date.now();
const page = await openPage(P.pageId);
const R = Object.assign({}, P.remap);
const get = (id) => page.getShapeById(R[id] || id);
const indexIn = (parent, shape) => (safe(() => parent.children, []) || []).findIndex((c) => c.id === shape.id);
const apply = (item) => {
  const node = get(item.nodeId);
  if (!node) { throw new Error("Layer not found"); }
  const undo = { id: item.id, nodeId: item.nodeId, converted: false };
  let board = node;
  if (item.convert) {
    if (node.type !== "group") { throw new Error("Not a group"); }
    const parent = node.parent;
    const index = indexIn(parent, node);
    const kids = node.children.slice();
    board = penpot.createBoard();
    board.name = item.boardName || node.name;
    board.fills = [];
    board.clipContent = false;
    parent.insertChild(Math.max(0, index), board);
    board.x = node.x;
    board.y = node.y;
    board.resize(Math.max(0.01, node.width), Math.max(0.01, node.height));
    const gch = safe(() => node.constraintsHorizontal, null);
    const gcv = safe(() => node.constraintsVertical, null);
    if (gch) { safe(() => { board.constraintsHorizontal = gch; }, null); }
    if (gcv) { safe(() => { board.constraintsVertical = gcv; }, null); }
    undo.groupConstraints = [gch, gcv];
    for (const kid of kids) { board.appendChild(kid); }
    if (page.getShapeById(node.id)) { node.remove(); }
    R[item.nodeId] = board.id;
    undo.converted = true;
    undo.groupName = item.name;
  }
  undo.boardId = board.id;
  undo.size = [board.width, board.height];
  undo.order = board.children.map((c) => c.id);
  undo.children = board.children.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.width, h: c.height, ch: safe(() => c.constraintsHorizontal, null), cv: safe(() => c.constraintsVertical, null) }));
  const layout = item.layout;
  const all = board.children;
  const byId = new Map(all.map((c) => [c.id, c]));
  const pick = (ids) => ids.map((id) => byId.get(R[id] || id)).filter(Boolean);
  const below = pick(item.absoluteBelow);
  const above = pick(item.absoluteAbove);
  const flowIds = layout.type === "flex" ? layout.order : layout.cells.map((cell) => cell.id);
  const flow = pick(flowIds);
  if (flow.length !== flowIds.length) { throw new Error("Children changed"); }
  const listed = new Set([...below, ...above, ...flow].map((c) => c.id));
  const rest = all.filter((c) => !listed.has(c.id));
  if (rest.some((c) => c.visible !== false)) { throw new Error("Children changed"); }
  const p = layout.padding;
  const pads = (l) => { l.topPadding = p.top; l.rightPadding = p.right; l.bottomPadding = p.bottom; l.leftPadding = p.left; };
  const keep = below.concat(above).map((c) => ({ c, x: c.x, y: c.y }));
  // z order (bottom to top) set before the layout exists: a flex layout shows its children
  // top-most first, so the flow goes in reversed; "below" stays at the bottom, "above" on top
  board.children = below.concat(rest, flow.slice().reverse(), above);
  if (layout.type === "flex") {
    const flex = board.addFlexLayout();
    flex.dir = layout.dir;
    flex.wrap = "nowrap";
    flex.alignItems = layout.align;
    flex.justifyContent = "start";
    if (layout.dir === "row") { flex.columnGap = layout.gap; flex.rowGap = 0; } else { flex.rowGap = layout.gap; flex.columnGap = 0; }
    pads(flex);
    flex.horizontalSizing = item.sizing;
    flex.verticalSizing = item.sizing;
  } else {
    const grid = board.addGridLayout();
    grid.dir = "row";
    while (grid.rows.length > 0) { grid.removeRow(grid.rows.length - 1); }
    while (grid.columns.length > 0) { grid.removeColumn(grid.columns.length - 1); }
    for (const w of layout.columns) { grid.addColumn("fixed", w); }
    for (const h of layout.rows) { grid.addRow("fixed", h); }
    grid.rowGap = layout.rowGap;
    grid.columnGap = layout.columnGap;
    grid.alignItems = "start";
    grid.justifyItems = "start";
    pads(grid);
    grid.horizontalSizing = item.sizing;
    grid.verticalSizing = item.sizing;
    for (const cell of layout.cells) {
      const child = byId.get(R[cell.id] || cell.id);
      if (child) { grid.appendChild(child, cell.row, cell.column); }
    }
  }
  for (const k of keep) {
    const lc = safe(() => k.c.layoutChild, null);
    if (lc) { lc.absolute = true; }
    k.c.x = k.x;
    k.c.y = k.y;
  }
  return undo;
};
const results = [];
const block = penpot.history.undoBlockBegin();
try {
  for (const item of P.items) {
    if (Date.now() - started > P.budgetMs) { results.push({ id: item.id, ok: false, deferred: true }); continue; }
    try { results.push({ id: item.id, ok: true, undo: apply(item) }); }
    catch (e) { results.push({ id: item.id, ok: false, error: message(e) }); }
  }
} finally {
  penpot.history.undoBlockFinish(block);
}
return JSON.stringify({ results, remap: R });
`;
    }

    /**
     * Takes layouts away again (reverse order): removes the layout, restores the children's
     * order, positions, sizes and constraints, and turns converted boards back into groups.
     * JSON `{reverted, errors:[{id, error}], remap}` (`remap` drops the reverted conversions and maps
     * the original group ids to the new groups).
     */
    public static revertLayouts(pageId: string, undos: LayoutUndo[], remap: Record<string, string>): string {
        return `${CleanupScripts.PRELUDE}
const P = ${JSON.stringify({ pageId, undos, remap })};
const page = await openPage(P.pageId);
const R = Object.assign({}, P.remap);
let reverted = 0;
const errors = [];
const revert = (u) => {
  const board = page.getShapeById(u.boardId);
  if (!board) { throw new Error("Layer not found"); }
  const flex = safe(() => board.flex, null);
  if (flex) { flex.remove(); }
  const grid = safe(() => board.grid, null);
  if (grid) { grid.remove(); }
  const kids = u.order.map((id) => page.getShapeById(id)).filter(Boolean);
  if (kids.length === board.children.length) { board.children = kids; }
  for (const c of u.children) {
    const shape = page.getShapeById(c.id);
    if (!shape) { continue; }
    if (Math.abs(shape.width - c.w) > 0.01 || Math.abs(shape.height - c.h) > 0.01) { shape.resize(c.w, c.h); }
    shape.x = c.x;
    shape.y = c.y;
    if (c.ch) { safe(() => { shape.constraintsHorizontal = c.ch; }, null); }
    if (c.cv) { safe(() => { shape.constraintsVertical = c.cv; }, null); }
  }
  if (Math.abs(board.width - u.size[0]) > 0.01 || Math.abs(board.height - u.size[1]) > 0.01) { board.resize(u.size[0], u.size[1]); }
  if (u.converted) {
    const parent = board.parent;
    const index = (parent.children || []).findIndex((c) => c.id === board.id);
    const group = penpot.group(board.children.slice());
    if (!group) { throw new Error("Could not group"); }
    group.name = u.groupName;
    const gc = u.groupConstraints || [];
    if (gc[0]) { safe(() => { group.constraintsHorizontal = gc[0]; }, null); }
    if (gc[1]) { safe(() => { group.constraintsVertical = gc[1]; }, null); }
    parent.insertChild(Math.max(0, index), group);
    board.remove();
    R[u.nodeId] = group.id;
  }
};
const block = penpot.history.undoBlockBegin();
try {
  for (const u of P.undos.slice().reverse()) {
    try { revert(u); reverted++; } catch (e) { errors.push({ id: u.id, error: message(e) }); }
  }
} finally {
  penpot.history.undoBlockFinish(block);
}
return JSON.stringify({ reverted, errors, remap: R });
`;
    }

    /**
     * Opens the component step's undo block, makes the first member a main component and puts a
     * copy in place of every other member (same parent, index, position and constraints; texts
     * and images of the member carried over), hiding the members. The first member's backup (a
     * hidden clone) allows taking the component back. The layers made are marked with `stepKey`
     * so that {@link recoverComponent} can take back a step whose script did not answer; an error
     * inside the script takes the step back at once and closes the block (answer `{failed}`).
     *
     * JSON `{componentId, mainId, backupId, pairs:[{memberId, copyId}], errors}` or `{failed}`.
     * Finish with {@link keepComponent} or {@link revertComponent}.
     */
    public static applyComponent(pageId: string, proposal: ComponentProposal, name: string, stepKey: string): string {
        return `${CleanupScripts.PRELUDE}
${CleanupScripts.MARKS}
const P = ${JSON.stringify({ pageId, memberIds: proposal.memberIds, name, key: stepKey })};
const page = await openPage(P.pageId);
const members = P.memberIds.map((id) => page.getShapeById(id));
if (members.some((m) => !m)) { throw new Error("Layer not found"); }
const kids = (shape) => {
  const list = safe(() => shape.children, null);
  if (!list) { return []; }
  const isFlex = shape.type === "board" && !!safe(() => shape.flex, null);
  return isFlex ? list.slice().reverse() : list.slice();
};
const carry = (from, to, errors) => {
  if (from.type === "text" && to.type === "text") {
    const text = safe(() => from.characters, null);
    if (typeof text === "string" && text !== safe(() => to.characters, null)) {
      try { to.characters = text; } catch (e) { errors.push(message(e)); }
    }
  }
  const fills = safe(() => from.fills, []);
  if (Array.isArray(fills) && fills.some((f) => f.fillImage)) {
    try { to.fills = fills; } catch (e) { errors.push(message(e)); }
  }
  const a = kids(from);
  const b = kids(to);
  for (let i = 0; i < Math.min(a.length, b.length); i++) { carry(a[i], b[i], errors); }
};
const errors = [];
const pairs = [];
let component = null;
let backup = null;
beginStep();
try {
  const first = members[0];
  backup = first.clone();
  backup.visible = false;
  MARK(backup, P.key + ":backup");
  component = penpot.library.local.createComponent([first]);
  const mainShape = safe(() => component.mainInstance(), null);
  if (mainShape) { MARK(mainShape, P.key + ":main"); }
  if (P.name) { try { component.name = P.name; } catch (e) { errors.push(message(e)); } }
  for (const member of members.slice(1)) {
    const parent = member.parent;
    const index = (safe(() => parent.children, []) || []).findIndex((c) => c.id === member.id);
    const copy = component.instance();
    MARK(copy, P.key + ":copy");
    parent.insertChild(Math.max(0, index), copy);
    const layoutChild = safe(() => member.layoutChild, null);
    const inFlow = !!safe(() => parent.flex, null) || !!safe(() => parent.grid, null);
    if (!inFlow || (layoutChild && layoutChild.absolute)) {
      if (layoutChild && layoutChild.absolute && copy.layoutChild) { copy.layoutChild.absolute = true; }
      copy.x = member.x;
      copy.y = member.y;
    }
    const ch = safe(() => member.constraintsHorizontal, null);
    const cv = safe(() => member.constraintsVertical, null);
    if (ch) { safe(() => { copy.constraintsHorizontal = ch; }, null); }
    if (cv) { safe(() => { copy.constraintsVertical = cv; }, null); }
    // a group main is wrapped in a new board: compare the member with the copy's group
    const inner = kids(copy);
    const target = first.type === "group" && copy.type === "board" && inner.length === 1 && inner[0].type === "group" ? inner[0] : copy;
    carry(member, target, errors);
    member.visible = false;
    pairs.push({ memberId: member.id, copyId: copy.id });
  }
} catch (e) {
  try { undoMarked(page, P.key, P.memberIds); } finally { endStep(); }
  return JSON.stringify({ failed: message(e) });
}
const main = component ? safe(() => component.mainInstance(), null) : null;
return JSON.stringify({
  componentId: component ? component.id : null,
  mainId: main ? main.id : P.memberIds[0],
  backupId: backup ? backup.id : null,
  pairs,
  errors,
});
`;
    }

    /**
     * Takes back a component step whose apply script did not answer (marked layers), then closes
     * the step's undo block.
     */
    public static recoverComponent(pageId: string, stepKey: string, memberIds: string[]): string {
        return `${CleanupScripts.PRELUDE}
${CleanupScripts.MARKS}
const P = ${JSON.stringify({ pageId, key: stepKey, memberIds })};
const page = await openPage(P.pageId);
try { undoMarked(page, P.key, P.memberIds); } finally { endStep(); }
return JSON.stringify({ recovered: true });
`;
    }

    /**
     * Keeps a component step: removes the hidden members and the backup, clears the marks of
     * `keepIds` and closes the step's undo block. JSON `{removed}`.
     */
    public static keepComponent(pageId: string, removeIds: string[], keepIds: string[]): string {
        return `${CleanupScripts.PRELUDE}
${CleanupScripts.MARKS}
const P = ${JSON.stringify({ pageId, removeIds, keepIds })};
const page = await openPage(P.pageId);
let removed = 0;
try {
  for (const id of P.removeIds) {
    const shape = page.getShapeById(id);
    if (shape) { shape.remove(); removed++; }
  }
  for (const id of P.keepIds) {
    const shape = page.getShapeById(id);
    if (shape) { MARK(shape, ""); }
  }
} finally {
  endStep();
}
return JSON.stringify({ removed });
`;
    }

    /**
     * Takes a component step back: removes the copies, shows the members again, deletes the
     * component (and its main) and shows the backup of the first member in its place, then closes
     * the step's undo block. JSON `{restoredId}`.
     */
    public static revertComponent(
        pageId: string,
        step: { componentId: string | null; backupId: string | null; pairs: { memberId: string; copyId: string }[] }
    ): string {
        return `${CleanupScripts.PRELUDE}
${CleanupScripts.MARKS}
const P = ${JSON.stringify({ pageId, ...step })};
const page = await openPage(P.pageId);
let restoredId = null;
try {
  for (const pair of P.pairs) {
    const copy = page.getShapeById(pair.copyId);
    if (copy) { copy.remove(); }
    const member = page.getShapeById(pair.memberId);
    if (member) { member.visible = true; }
  }
  const component = P.componentId ? penpot.library.local.components.find((c) => c.id === P.componentId) : null;
  if (component) { component.remove(); }
  const backup = P.backupId ? page.getShapeById(P.backupId) : null;
  if (backup) { backup.visible = true; MARK(backup, ""); restoredId = backup.id; }
} finally {
  endStep();
}
return JSON.stringify({ restoredId });
`;
    }
}

/** What {@link CleanupScripts.applyLayouts} records to take a layout back. */
export interface LayoutUndo {
    id: string;
    nodeId: string;
    boardId: string;
    converted: boolean;
    groupName?: string;
    /** constraints of a converted group, put back when it is taken back */
    groupConstraints?: [string | null, string | null];
    size: [number, number];
    order: string[];
    children: { id: string; x: number; y: number; w: number; h: number; ch: string | null; cv: string | null }[];
}
