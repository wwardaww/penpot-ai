import type { WorkflowToolsApi } from "@penpot/mcp-common";
import { DesignSystemFailure } from "../DesignSystemRun";
import { PLUGIN_NAMESPACE } from "../DesignSystemScripts";
import type { FixOp } from "./types";

/** Shared plugin data key tagging a design system component made for a missing item. */
export const MISSING_ITEM_KEY = "designSystemItem";

/** Answer of the link script. */
export interface LinkReport {
    linked: boolean;
    /** the library was linked before */
    alreadyLinked: boolean;
    tokensSource: boolean;
    /** tokens of the file itself, inactive while the library is the tokens source */
    ownTokens: number;
    /** the library has tokens of its own */
    libraryTokens: number;
    warnings: { code: string; detail: string }[];
}

/** Answer of the fix script. */
export interface FixReport {
    applied: number;
    failed: { op: string; layerId: string; detail: string }[];
}

/** Local component as the brief script describes it for the design system tab. */
export interface ComponentBrief {
    componentId: string;
    name: string;
    width: number;
    height: number;
    /** indented outline of the main: type, name, size, colors, text */
    outline: string;
}

/** Scan scope. */
export interface ScanScope {
    /** `current` page, `all` pages, or the given page ids */
    pages: "current" | "all" | string[];
    /** only these top-level boards (and what they hold) */
    boardIds?: string[];
    /** layers read at most */
    maxLayers?: number;
}

/** Shared helpers of the scripts (plain JavaScript). */
const HELPERS = `const call = (s, m) => { try { return !!s && typeof s[m] === "function" ? !!s[m]() : false; } catch (e) { return false; } };
const kids = (s) => (s && Array.isArray(s.children) ? s.children : []);
const hex = (c) => {
  if (typeof c !== "string") { return null; }
  const t = c.trim().toLowerCase();
  const s = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (s) { return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]; }
  const l = /^#([0-9a-f]{6})/.exec(t);
  return l ? "#" + l[1] : null;
};
const num = (v) => { const n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? Math.round(n * 100) / 100 : null; };
const str = (v) => (v === undefined || v === null ? "" : String(v));
const message = (e) => String(e && e.message ? e.message : e).slice(0, 200);
const libraryOf = (id) => (penpot.library.connected || []).find((l) => l && l.id === id) || null;`;

/**
 * Plugin code (plain JavaScript run by `execute_code`) of the design system binding (W30): link
 * a design system library and make it the tokens source, read what the system offers, scan the
 * open file for drift, apply the planned fixes in one undo step. Tests run the same text against a
 * fake `penpot`.
 */
export class ConformanceScripts {
    constructor(private readonly tools: WorkflowToolsApi) {}

    /** Runs a script; Penpot errors become {@link DesignSystemFailure}s. */
    public async run<T>(code: string): Promise<T> {
        const result = await this.tools.call("execute_code", { code });
        if (result.isError) {
            throw new DesignSystemFailure("penpot-refused", `Penpot refused the change: ${result.text}`, {
                detail: result.text.slice(0, 500),
            });
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(result.text);
        } catch {
            throw new DesignSystemFailure(
                "penpot-answer",
                `Unexpected answer from Penpot: ${result.text.slice(0, 200)}`
            );
        }
        return (parsed as { result?: T }).result as T;
    }

    /**
     * Code that links the library to the open file (when it is not yet) and makes it the tokens
     * source when it has tokens. Returns a {@link LinkReport}.
     */
    public static linkScript(libraryId: string, tokensSource = true): string {
        return `const libraryId = ${JSON.stringify(libraryId)};
const wantSource = ${JSON.stringify(tokensSource)};
${HELPERS}
const report = { linked: false, alreadyLinked: false, tokensSource: false, ownTokens: 0, libraryTokens: 0, warnings: [] };
const countTokens = (catalog) => {
  let n = 0;
  try { for (const set of (catalog && catalog.sets) || []) { n += (set.tokens || []).length; } } catch (e) { /* none */ }
  return n;
};
let lib = libraryOf(libraryId);
report.alreadyLinked = !!lib;
if (!lib) {
  try { lib = await penpot.library.connectLibrary(libraryId); } catch (e) { report.warnings.push({ code: "link-failed", detail: message(e) }); }
}
report.linked = !!lib;
report.ownTokens = countTokens(penpot.library.local.tokens);
if (lib) {
  report.libraryTokens = countTokens(lib.tokens);
  const current = penpot.library.tokensSource;
  report.tokensSource = !!current && current.id === lib.id;
  if (wantSource && !report.tokensSource && report.libraryTokens > 0) {
    try { penpot.library.tokensSource = lib; report.tokensSource = true; } catch (e) { report.warnings.push({ code: "tokens-source-failed", detail: message(e) }); }
  }
}
return report;`;
    }

    /** Code that reads what the linked library offers. Returns a `SystemCatalog`. */
    public static catalogScript(libraryId: string): string {
        return `const libraryId = ${JSON.stringify(libraryId)};
${HELPERS}
const lib = libraryOf(libraryId);
const source = penpot.library.tokensSource;
const out = { libraryId, name: lib ? str(lib.name) : "", linked: !!lib, tokensSource: !!lib && !!source && source.id === lib.id, colors: [], typographies: [], components: [], tokens: [] };
if (lib) {
  for (const c of lib.colors || []) {
    const h = hex(c.color);
    if (h) { out.colors.push({ id: c.id, name: str(c.name), path: str(c.path), hex: h, opacity: typeof c.opacity === "number" ? c.opacity : 1 }); }
  }
  for (const t of lib.typographies || []) {
    out.typographies.push({ id: t.id, name: str(t.name), path: str(t.path), fontFamily: str(t.fontFamily), fontSize: num(t.fontSize) || 0, fontWeight: str(t.fontWeight) || "400" });
  }
  for (const c of lib.components || []) {
    out.components.push({ id: c.id, name: str(c.name), path: str(c.path) });
  }
  const seen = {};
  const sets = (lib.tokens && lib.tokens.sets) || [];
  // active sets last, so their values win
  const ordered = sets.filter((s) => !s.active).concat(sets.filter((s) => s.active));
  for (const set of ordered) {
    for (const t of set.tokens || []) {
      const raw = t.resolvedValue !== undefined ? t.resolvedValue : t.value;
      let value = null;
      if (t.type === "color") { value = hex(str(raw)); }
      else if (typeof raw === "number") { value = raw; }
      else if (typeof raw === "string") { value = num(raw) !== null && /^-?[0-9.]+(px)?$/.test(raw.trim()) ? num(raw) : raw.slice(0, 120); }
      seen[t.name] = { name: str(t.name), type: str(t.type), value };
    }
  }
  out.tokens = Object.values(seen);
}
return out;`;
    }

    /** Code that tells whether the library is linked to the open file. Returns a boolean. */
    public static linkedScript(libraryId: string): string {
        return `const libraryId = ${JSON.stringify(libraryId)};
${HELPERS}
return !!libraryOf(libraryId);`;
    }

    /**
     * Code that reads the layers the check looks at: style values, applied tokens, component
     * links. Changes nothing. Returns a `ScanResult`.
     */
    public static scanScript(scope: ScanScope): string {
        return `const scope = ${JSON.stringify({ pages: scope.pages, boardIds: scope.boardIds ?? null, maxLayers: scope.maxLayers ?? 6000 })};
${HELPERS}
const isMain = (s) => call(s, "isComponentMainInstance");
const isCopy = (s) => call(s, "isComponentCopyInstance");
const fileId = penpot.currentFile ? penpot.currentFile.id : null;
const all = penpot.currentFile.pages || [];
const current = penpot.currentPage;
const pages = scope.pages === "all" ? all : scope.pages === "current" ? (current ? [current] : []) : all.filter((p) => scope.pages.indexOf(p.id) >= 0);
const out = { layers: [], truncated: false, pages: pages.map((p) => ({ id: p.id, name: str(p.name) })) };
const SPACING = { rowGap: "rowGap", columnGap: "columnGap", topPadding: "paddingTop", rightPadding: "paddingRight", bottomPadding: "paddingBottom", leftPadding: "paddingLeft" };
const paints = (list, colorKey, refId, refFile, opacityKey) => {
  const res = [];
  (Array.isArray(list) ? list : []).forEach((p, index) => {
    if (!p || p.fillImage || p.fillColorGradient || p.strokeColorGradient) { return; }
    const h = hex(p[colorKey]);
    if (!h) { return; }
    res.push({ index, hex: h, opacity: typeof p[opacityKey] === "number" ? p[opacityKey] : 1, refId: p[refId] || null, refFile: p[refFile] || null });
  });
  return res;
};
const componentOf = (s) => {
  const main = isMain(s);
  const copy = isCopy(s);
  if (!main && !copy) { return null; }
  let c = null;
  try { c = s.component(); } catch (e) { c = null; }
  if (!c) { return null; }
  return { id: c.id, name: str(c.name), path: str(c.path), libraryId: c.libraryId || fileId, main, copy: copy && !main };
};
const visit = (page, s, ctx) => {
  if (out.layers.length >= scope.maxLayers) { out.truncated = true; return; }
  const component = componentOf(s);
  const tokens = {};
  try { const t = s.tokens || {}; for (const k of Object.keys(t)) { tokens[k] = str(t[k]); } } catch (e) { /* none */ }
  let text = null;
  if (s.type === "text") {
    const size = s.fontSize === "mixed" ? null : num(s.fontSize);
    text = { fontFamily: str(s.fontFamily), fontSize: size, fontWeight: str(s.fontWeight) || "400" };
  }
  let spacing = null;
  const layout = s.flex || s.grid;
  if (layout) {
    spacing = {};
    for (const k of Object.keys(SPACING)) { const v = num(layout[k]); if (v !== null) { spacing[SPACING[k]] = v; } }
  }
  const radius = s.type !== "text" ? num(s.borderRadius) : null;
  out.layers.push({
    id: s.id, name: str(s.name), type: str(s.type), pageId: page.id,
    boardId: ctx.board ? ctx.board.id : s.id, boardName: ctx.board ? str(ctx.board.name) : str(s.name),
    topLevel: ctx.parent === null, parentId: ctx.parent, insideCopy: ctx.insideCopy, insideMains: ctx.mains.slice(),
    fills: s.type === "group" ? [] : paints(s.fills, "fillColor", "fillColorRefId", "fillColorRefFile", "fillOpacity"),
    strokes: paints(s.strokes, "strokeColor", "strokeColorRefId", "strokeColorRefFile", "strokeOpacity"),
    tokens, text, radius, spacing,
    shadows: (Array.isArray(s.shadows) ? s.shadows : []).filter((x) => x && !x.hidden).length,
    childCount: kids(s).length, component,
  });
  const next = {
    board: ctx.board || s,
    parent: s.id,
    insideCopy: ctx.insideCopy || (component !== null && component.copy),
    mains: component && component.main ? [component.id].concat(ctx.mains) : ctx.mains,
  };
  for (const c of kids(s)) { visit(page, c, next); }
};
for (const page of pages) {
  const tops = kids(page.root).filter((s) => !scope.boardIds || scope.boardIds.indexOf(s.id) >= 0);
  for (const top of tops) { visit(page, top, { board: null, parent: null, insideCopy: false, mains: [] }); }
}
return out;`;
    }

    /**
     * Code that applies fix ops in one undo step, page by page (the Plugin API writes only on the
     * active page), then returns to the page the user was on. Returns a {@link FixReport}.
     *
     * @param libraryId - the design system library
     * @param ops - ops in run order ({@link ConformanceChecker.ops})
     * @param pageOf - page id of each layer
     */
    public static fixScript(libraryId: string, ops: FixOp[], pageOf: Record<string, string>): string {
        return `const libraryId = ${JSON.stringify(libraryId)};
const ops = ${JSON.stringify(ops)};
const pageOf = ${JSON.stringify(pageOf)};
${HELPERS}
const report = { applied: 0, failed: [] };
const lib = libraryOf(libraryId);
if (!lib) { return { applied: 0, failed: [{ op: "all", layerId: "", detail: "design system library not linked" }] }; }
const fail = (op, e) => report.failed.push({ op: op.op, layerId: op.layerId, detail: message(e) });
const tokenByName = (name) => {
  const catalogs = [lib.tokens, penpot.library.local.tokens];
  for (const catalog of catalogs) {
    let found = null;
    for (const set of (catalog && catalog.sets) || []) {
      const t = (set.tokens || []).find((x) => x.name === name);
      if (t && (found === null || set.active)) { found = t; }
    }
    if (found) { return found; }
  }
  return null;
};
const colorById = (id) => (lib.colors || []).find((c) => c.id === id) || null;
const componentById = (id) => (lib.components || []).find((c) => c.id === id) || null;
const typographyById = (id) => (lib.typographies || []).find((t) => t.id === id) || null;
const RADIUS = ["borderRadiusTopLeft", "borderRadiusTopRight", "borderRadiusBottomRight", "borderRadiusBottomLeft"];
const LAYOUT = { rowGap: "rowGap", columnGap: "columnGap", paddingTop: "topPadding", paddingRight: "rightPadding", paddingBottom: "bottomPadding", paddingLeft: "leftPadding" };
const texts = (s, acc) => { if (s.type === "text") { acc.push(s); } for (const c of kids(s)) { texts(c, acc); } return acc; };
const paint = (s, op) => {
  // a color token wins: it sets the value and keeps the binding the code export reads (W21)
  const token = op.token ? tokenByName(op.token) : null;
  if (token) {
    try { s.applyToken(token, [op.op === "fill" ? "fill" : "strokeColor"]); return; } catch (e) { /* use the library color */ }
  }
  const key = op.op === "fill" ? "fills" : "strokes";
  const list = (Array.isArray(s[key]) ? s[key] : []).slice();
  const old = list[op.index];
  if (!old) { throw new Error("paint gone"); }
  const color = op.colorId ? colorById(op.colorId) : null;
  if (color) {
    if (op.op === "fill") {
      const f = color.asFill();
      if (typeof old.fillOpacity === "number" && old.fillOpacity < 1) { f.fillOpacity = old.fillOpacity; }
      list[op.index] = f;
    } else {
      const k = color.asStroke();
      list[op.index] = Object.assign({}, old, { strokeColor: k.strokeColor, strokeColorRefId: k.strokeColorRefId, strokeColorRefFile: k.strokeColorRefFile });
    }
    s[key] = list;
  } else {
    if (op.op === "fill") { list[op.index] = Object.assign({}, old, { fillColor: op.hex, fillColorRefId: undefined, fillColorRefFile: undefined }); }
    else { list[op.index] = Object.assign({}, old, { strokeColor: op.hex, strokeColorRefId: undefined, strokeColorRefFile: undefined }); }
    s[key] = list;
  }
};
const replace = (s, comp) => {
  const parent = s.parent;
  const inst = comp.instance();
  if (parent && typeof parent.insertChild === "function") {
    const index = kids(parent).indexOf(s);
    parent.insertChild(index < 0 ? kids(parent).length : index, inst);
  } else if (parent) {
    parent.appendChild(inst);
  }
  inst.x = s.x;
  inst.y = s.y;
  // carry the texts over: same name first, then in order
  const before = texts(s, []);
  const after = texts(inst, []);
  const used = {};
  for (const t of after) {
    let src = before.find((b, i) => !used[i] && str(b.name) === str(t.name));
    if (!src) { src = before.find((b, i) => !used[i]); }
    if (!src) { break; }
    used[before.indexOf(src)] = true;
    try { if (str(src.characters).length > 0) { t.characters = src.characters; } } catch (e) { /* keep the default text */ }
  }
  s.remove();
};
const apply = (s, op) => {
  if (op.op === "fill" || op.op === "stroke") { paint(s, op); return; }
  if (op.op === "typography") {
    const t = typographyById(op.typographyId);
    if (!t) { throw new Error("text style gone"); }
    t.applyToText(s);
    return;
  }
  if (op.op === "token") {
    const token = tokenByName(op.token);
    const radius = op.properties.indexOf("borderRadius") >= 0;
    if (token) { s.applyToken(token, radius ? RADIUS : op.properties); return; }
    if (radius) { s.borderRadius = op.value; return; }
    const layout = s.flex || s.grid;
    if (!layout) { throw new Error("no layout"); }
    for (const p of op.properties) { if (LAYOUT[p]) { layout[LAYOUT[p]] = op.value; } }
    return;
  }
  const comp = componentById(op.componentId);
  if (!comp) { throw new Error("component gone"); }
  if (op.op === "swap") { s.swapComponent(comp); return; }
  replace(s, comp);
};
const start = penpot.currentPage;
const pages = {};
for (const p of penpot.currentFile.pages || []) { pages[p.id] = p; }
const order = [];
for (const op of ops) { const pid = pageOf[op.layerId]; if (pid && order.indexOf(pid) < 0) { order.push(pid); } }
const block = penpot.history.undoBlockBegin();
try {
  for (const pid of order) {
    const page = pages[pid];
    if (!page) { continue; }
    if (!penpot.currentPage || penpot.currentPage.id !== pid) { await penpot.openPage(page); }
    for (const op of ops) {
      if (pageOf[op.layerId] !== pid) { continue; }
      try {
        const s = page.getShapeById(op.layerId);
        if (!s) { throw new Error("layer gone"); }
        apply(s, op);
        report.applied++;
      } catch (e) { fail(op, e); }
    }
  }
} finally {
  penpot.history.undoBlockFinish(block);
}
if (start && penpot.currentPage && penpot.currentPage.id !== start.id) { try { await penpot.openPage(start); } catch (e) { /* stay */ } }
return report;`;
    }

    /**
     * Code that describes local components for the design system tab (outline of each main, 3
     * levels). Returns {@link ComponentBrief}[].
     */
    public static briefScript(componentIds: string[]): string {
        return `const ids = ${JSON.stringify(componentIds)};
${HELPERS}
const out = [];
const lib = penpot.library.local;
const line = (s, depth) => {
  const fill = (Array.isArray(s.fills) ? s.fills : []).map((f) => hex(f && f.fillColor)).filter(Boolean)[0];
  const bits = [str(s.type), JSON.stringify(str(s.name).slice(0, 60)), Math.round(num(s.width) || 0) + "x" + Math.round(num(s.height) || 0)];
  if (fill) { bits.push("fill " + fill); }
  if (num(s.borderRadius)) { bits.push("radius " + num(s.borderRadius)); }
  if (s.type === "text") { bits.push(JSON.stringify(str(s.characters).slice(0, 80)), str(s.fontFamily) + " " + str(s.fontSize) + "/" + str(s.fontWeight)); }
  return "  ".repeat(depth) + "- " + bits.join(", ");
};
const outline = (s, depth, acc) => {
  if (acc.length >= 40) { return acc; }
  acc.push(line(s, depth));
  if (depth < 3) { for (const c of kids(s)) { outline(c, depth + 1, acc); } }
  return acc;
};
for (const id of ids) {
  const c = (lib.components || []).find((x) => x.id === id);
  if (!c) { continue; }
  let main = null;
  try { main = c.mainInstance(); } catch (e) { main = null; }
  out.push({ componentId: id, name: str(c.name), width: main ? num(main.width) || 0 : 0, height: main ? num(main.height) || 0 : 0, outline: main ? outline(main, 0, []).join("\\n") : "" });
}
return out;`;
    }

    /**
     * Code (design system file) that lists the components tagged for missing items. Returns
     * `{itemId, componentId, name}[]`.
     */
    public static taggedItemsScript(): string {
        return `const ns = ${JSON.stringify(PLUGIN_NAMESPACE)};
const key = ${JSON.stringify(MISSING_ITEM_KEY)};
${HELPERS}
const out = [];
for (const c of penpot.library.local.components || []) {
  let main = null;
  try { main = c.mainInstance(); } catch (e) { main = null; }
  let tag = "";
  try { tag = (main && main.getSharedPluginData(ns, key)) || c.getSharedPluginData(ns, key) || ""; } catch (e) { tag = ""; }
  if (tag) { out.push({ itemId: str(tag), componentId: c.id, name: str(c.name) }); }
}
return out;`;
    }
}

/** The scan scope of the open page. */
export function currentPageScope(boardIds?: string[]): ScanScope {
    return { pages: "current", boardIds };
}
