import { OVERVIEW_KEY, PAGE_NAMES, PLUGIN_NAMESPACE } from "../DesignSystemScripts";
import { DEFAULT_ICON_STYLE } from "../../icons/IconScripts";

/** Read limits of the inventory script. */
export interface InventoryLimits {
    /** layers read at most (the rest is left out, `truncated`) */
    maxLayers: number;
    /** component candidate groups returned at most */
    maxGroups: number;
    /** icon candidates returned at most */
    maxIcons: number;
    /** largest side (px) of an icon candidate */
    maxIconSize: number;
}

export const DEFAULT_INVENTORY_LIMITS: InventoryLimits = {
    maxLayers: 60000,
    maxGroups: 3000,
    maxIcons: 600,
    maxIconSize: 48,
};

/** What the components stage changes (ids from the accepted plan). */
export interface ComponentOps {
    /** merged color → kept color (`#rrggbb`) */
    colorMap: Record<string, string>;
    /** color → token name */
    colorTokens: Record<string, string>;
    /** radius px → token name */
    radiusTokens: Record<string, string>;
    /** spacing px → token name */
    spacingTokens: Record<string, string>;
    candidates: {
        proposalId: string;
        name: string;
        variants: { sampleId: string; pageId: string; name: string }[];
    }[];
    renames: { componentId: string; name: string }[];
    groups: { path: string; componentIds: string[] }[];
    /** existing icon-like components moved under `Icons` */
    iconComponentIds: string[];
    /** unused components removed */
    drops: string[];
}

/** Report of the components stage. */
export interface ComponentReport {
    created: {
        proposalId: string;
        name: string;
        variants: boolean;
        components: { componentId: string; variant: string; sampleId: string }[];
    }[];
    bound: { fill: number; stroke: number; radius: number; spacing: number; typography: number; recolored: number };
    renamed: number;
    grouped: number;
    dropped: string[];
    relocated: number;
    warnings: { code: string; detail: string }[];
}

/** Report of the page cleanup stage. */
export interface PagesReport {
    removedPages: string[];
    componentPages: string[];
    removedLayers: number;
}

/** Report of the colors stage. */
export interface ColorsReport {
    /** `#rrggbb` → library color id that stands for it */
    byHex: Record<string, string>;
    created: number;
    kept: number;
    removed: number;
    warnings: { code: string; detail: string }[];
}

/** SVG markup of one icon candidate. */
export interface IconMarkup {
    id: string;
    svg: string | null;
}

/** Names of the pages the design system keeps besides its component pages. */
export const SYSTEM_PAGES = [PAGE_NAMES.colors, PAGE_NAMES.typography, PAGE_NAMES.tokens, DEFAULT_ICON_STYLE.pageName];

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
const num = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : null);
const str = (v) => (v === undefined || v === null ? "" : String(v));
const isMain = (s) => call(s, "isComponentMainInstance");
const isCopy = (s) => call(s, "isComponentCopyInstance");
const isContainer = (s) => call(s, "isVariantContainer");
const message = (e) => String(e && e.message ? e.message : e).slice(0, 200);`;

/**
 * Plugin code (plain JavaScript run by `execute_code`) of the `design-system-extract` workflow:
 * the inventory (read only), the components stage, the page cleanup and the icon markup. Tests
 * run the same text against a fake `penpot`.
 */
export class ExtractScripts {
    /**
     * Code that reads the whole file: pages, library, tokens, raw values with counts, repeated
     * group candidates and icon candidates. Changes nothing. Returns a `RawInventory`.
     */
    public static inventoryScript(limits: InventoryLimits = DEFAULT_INVENTORY_LIMITS): string {
        return `const limits = ${JSON.stringify(limits)};
const ns = ${JSON.stringify(PLUGIN_NAMESPACE)};
const overviewKey = ${JSON.stringify(OVERVIEW_KEY)};
${HELPERS}
const file = penpot.currentFile;
const lib = penpot.library.local;
const values = { fills: {}, strokes: {}, fonts: {}, spacing: {}, radius: {}, shadows: {} };
const inc = (map, key, n) => { map[key] = (map[key] || 0) + (n || 1); };
const refUses = {};
const instances = {};
const mainPage = {};
const groups = [];
const icons = [];
let visited = 0;
let truncated = false;
const VECTOR = { path: 1, boolean: 1, rectangle: 1, ellipse: 1, "svg-raw": 1, group: 1, board: 1 };
const DRAWN = { path: 1, boolean: 1, "svg-raw": 1 };
const shortHash = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) { h = ((h << 5) + h + text.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(16);
};
const solid = (f) => f && f.fillColor && !f.fillImage && !f.fillColorGradient;
const record = (s) => {
  for (const f of Array.isArray(s.fills) ? s.fills : []) {
    const h = solid(f) ? hex(f.fillColor) : null;
    if (h) { inc(values.fills, h); }
    if (f && f.fillColorRefId) { inc(refUses, f.fillColorRefId); }
  }
  for (const k of Array.isArray(s.strokes) ? s.strokes : []) {
    const h = k && k.strokeColor && !k.strokeColorGradient ? hex(k.strokeColor) : null;
    if (h) { inc(values.strokes, h); }
    if (k && k.strokeColorRefId) { inc(refUses, k.strokeColorRefId); }
  }
  const r = num(s.borderRadius);
  if (s.type !== "text" && r !== null && r > 0) { inc(values.radius, String(r)); }
  for (const sh of Array.isArray(s.shadows) ? s.shadows : []) {
    if (!sh || sh.hidden || sh.style === "inner-shadow" || !sh.color) { continue; }
    const h = hex(sh.color.color);
    if (!h) { continue; }
    const o = typeof sh.color.opacity === "number" ? sh.color.opacity : 1;
    const key = [num(sh.offsetX) || 0, num(sh.offsetY) || 0, num(sh.blur) || 0, num(sh.spread) || 0, h, Math.round(o * 100)].join("/");
    const entry = values.shadows[key] || { offsetX: num(sh.offsetX) || 0, offsetY: num(sh.offsetY) || 0, blur: num(sh.blur) || 0, spread: num(sh.spread) || 0, hex: h, opacity: o, count: 0 };
    entry.count++;
    values.shadows[key] = entry;
  }
  const layout = s.flex || s.grid;
  if (layout) {
    for (const k of ["rowGap", "columnGap", "topPadding", "rightPadding", "bottomPadding", "leftPadding"]) {
      const v = num(layout[k]);
      if (v !== null && v > 0) { inc(values.spacing, String(v)); }
    }
  }
  if (s.type === "text") {
    const parts = [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight, s.letterSpacing].map(str);
    if (parts[0] && parts[1] && parts.indexOf("mixed") < 0) {
      const key = parts.join("|");
      const entry = values.fonts[key] || { fontFamily: parts[0], fontSize: parts[1], fontWeight: parts[2] || "400", lineHeight: parts[3] || "1.2", letterSpacing: parts[4] || "0", count: 0 };
      entry.count++;
      values.fonts[key] = entry;
    }
  }
};
const lookOf = (s) => {
  if (s.type === "text") { return "T"; }
  const fills = (Array.isArray(s.fills) ? s.fills : []).map((f) => (solid(f) ? hex(f.fillColor) : f && f.fillImage ? "img" : "")).join(",");
  const strokes = (Array.isArray(s.strokes) ? s.strokes : []).map((k) => hex(k && k.strokeColor) || "").join(",");
  return fills + ";" + strokes + ";" + (num(s.borderRadius) || 0);
};
const walk = (s, ctx) => {
  if (visited >= limits.maxLayers) { truncated = true; return { hash: "", look: "", texts: 0, vector: false, drawn: false }; }
  visited++;
  if (s.visible === false || s.hidden === true) { return { hash: "hidden", look: "", texts: 0, vector: true, drawn: false }; }
  record(s);
  const main = isMain(s);
  const copy = isCopy(s);
  const container = isContainer(s);
  if (main || copy) {
    let component = null;
    try { component = s.component(); } catch (e) { component = null; }
    if (component && main) { mainPage[component.id] = ctx.page.id; }
    if (component && copy && (call(s, "isComponentHead") || call(s, "isComponentRoot"))) { inc(instances, component.id); }
  }
  const image = (Array.isArray(s.fills) ? s.fills : []).some((f) => f && f.fillImage) || s.type === "image";
  const inComponent = ctx.inComponent || main || copy || container;
  const child = {
    page: ctx.page,
    screenId: ctx.depth === 0 ? s.id : ctx.screenId,
    inComponent,
    ancestors: ctx.ancestors,
    depth: ctx.depth + 1,
    inIcon: ctx.inIcon,
  };
  const w = num(s.width) || 0;
  const h = num(s.height) || 0;
  const smallSquare = w >= 8 && h >= 8 && w <= limits.maxIconSize && h <= limits.maxIconSize && w / h >= 0.5 && w / h <= 2;
  const iconHere = !ctx.inIcon && !inComponent && smallSquare && s.type !== "text" && !image && ctx.depth > 0;
  const eligible = !inComponent && ctx.depth > 0 && (s.type === "group" || s.type === "board") && kids(s).length >= 2;
  if (eligible) { child.ancestors = ctx.ancestors.concat([s.id]); }
  if (iconHere) { child.inIcon = true; }
  const sub = kids(s).map((c) => walk(c, child));
  const texts = sub.reduce((n, x) => n + x.texts, 0) + (s.type === "text" ? 1 : 0);
  const vector = !!VECTOR[s.type] && !image && sub.every((x) => x.vector);
  const drawn = !!DRAWN[s.type] || sub.some((x) => x.drawn);
  const drawing = DRAWN[s.type] && s.content ? ":" + shortHash(typeof s.content === "string" ? s.content : JSON.stringify(s.content)) : "";
  const kind = (s.type === "text" ? "T" : image ? "I" : s.type) + drawing;
  const hash = kind + (sub.length ? "(" + sub.map((x) => x.hash).join(",") + ")" : "");
  const look = lookOf(s) + (sub.length ? "[" + sub.map((x) => x.look).join("|") + "]" : "");
  if (iconHere && vector && drawn && icons.length < limits.maxIcons) {
    icons.push({ id: s.id, pageId: ctx.page.id, name: str(s.name), width: w, height: h, hash: shortHash(hash + "@" + Math.round(w) + "x" + Math.round(h) + ":" + look) });
  } else if (eligible && !(smallSquare && vector && drawn)) {
    if (groups.length < limits.maxGroups) {
      groups.push({ id: s.id, pageId: ctx.page.id, screenId: ctx.screenId, name: str(s.name), type: s.type, hash: shortHash(hash), look: shortHash(look), width: w, height: h, texts, ancestors: ctx.ancestors });
    } else {
      truncated = true;
    }
  }
  return { hash, look, texts, vector, drawn };
};
const pages = [];
for (const page of file.pages) {
  let screens = 0;
  let mains = 0;
  let overview = null;
  for (const top of kids(page.root)) {
    const tag = typeof top.getSharedPluginData === "function" ? top.getSharedPluginData(ns, overviewKey) : "";
    if (tag) { overview = tag; continue; }
    if (isMain(top) || isContainer(top)) { mains++; } else { screens++; }
    walk(top, { page, screenId: top.id, inComponent: false, ancestors: [], depth: 0, inIcon: false });
  }
  pages.push({ id: page.id, name: page.name, screens, mains, overview });
}
for (const page of pages) {
  page.mains = Object.keys(mainPage).filter((id) => mainPage[id] === page.id).length;
}
const firstText = (s, depth) => {
  if (!s || depth > 8) { return ""; }
  if (s.type === "text") { return str(s.characters).trim(); }
  for (const c of kids(s)) { const t = firstText(c, depth + 1); if (t) { return t; } }
  return "";
};
const vectorOnly = (s) => s.type !== "text" && s.type !== "image" && !(Array.isArray(s.fills) ? s.fills : []).some((f) => f && f.fillImage) && kids(s).every(vectorOnly);
const drawnIn = (s) => !!DRAWN[s.type] || kids(s).some(drawnIn);
const components = lib.components.map((c) => {
  let main = null;
  try { main = c.mainInstance(); } catch (e) { main = null; }
  const w = main ? num(main.width) || 0 : 0;
  const h = main ? num(main.height) || 0 : 0;
  const variant = typeof c.isVariant === "function" && c.isVariant();
  return {
    id: c.id,
    name: str(c.name),
    path: str(c.path),
    mainId: main ? main.id : null,
    pageId: mainPage[c.id] || null,
    instances: instances[c.id] || 0,
    variantContainerId: variant && main && main.parent ? main.parent.id : null,
    firstText: main ? firstText(main, 0).slice(0, 60) : "",
    iconLike: !!main && w > 0 && h > 0 && w <= limits.maxIconSize && h <= limits.maxIconSize && w / h >= 0.5 && w / h <= 2 && vectorOnly(main) && drawnIn(main),
    width: w,
    height: h,
  };
});
const fonts = Object.values(values.fonts);
const colors = lib.colors.map((c) => {
  const h = c.color && !c.gradient && !c.image ? hex(c.color) : null;
  const byValue = h ? (values.fills[h] || 0) + (values.strokes[h] || 0) : 0;
  return { id: c.id, name: str(c.name), path: str(c.path), hex: h, opacity: typeof c.opacity === "number" ? c.opacity : 1, uses: Math.max(byValue, refUses[c.id] || 0) };
});
const typographies = lib.typographies.map((t) => {
  const uses = fonts
    .filter((f) => f.fontFamily.toLowerCase() === str(t.fontFamily).toLowerCase() && f.fontSize === str(t.fontSize) && f.fontWeight === str(t.fontWeight))
    .reduce((n, f) => n + f.count, 0);
  return { id: t.id, name: str(t.name), path: str(t.path), fontFamily: str(t.fontFamily), fontSize: str(t.fontSize), fontWeight: str(t.fontWeight), lineHeight: str(t.lineHeight), letterSpacing: str(t.letterSpacing), uses };
});
return {
  fileName: file ? str(file.name) : "",
  truncated,
  pages,
  components,
  colors,
  typographies,
  tokenSets: lib.tokens.sets.map((s) => ({ name: s.name, active: !!s.active, tokens: s.tokens.map((t) => ({ name: t.name, type: t.type, value: t.value })) })),
  values: { fills: values.fills, strokes: values.strokes, fonts, spacing: values.spacing, radius: values.radius, shadows: Object.values(values.shadows) },
  groups,
  icons,
};`;
    }

    /**
     * Code of the components stage, one undo step: repeated layers become components (one
     * variant per look; variants combined when they sit on one page), nested main components move
     * to their page's root, every main component's colors, radius, spacing and texts get bound
     * to the tokens and text styles, then renames, groups, the `Icons` path for icon-like
     * components and the removal of unused ones. Returns a {@link ComponentReport}.
     */
    public static componentsScript(ops: ComponentOps): string {
        return `const ops = ${JSON.stringify(ops)};
${HELPERS}
const lib = penpot.library.local;
const report = { created: [], bound: { fill: 0, stroke: 0, radius: 0, spacing: 0, typography: 0, recolored: 0 }, renamed: 0, grouped: 0, dropped: [], relocated: 0, warnings: [] };
const warn = (code, e) => report.warnings.push({ code, detail: message(e) });
const pages = penpot.currentFile.pages;
const pageById = (id) => pages.find((p) => p.id === id) || null;
const tokens = {};
const tokenByName = (name) => {
  if (!name) { return null; }
  if (tokens[name] !== undefined) { return tokens[name]; }
  let found = null;
  for (const set of lib.tokens.sets) {
    const t = set.tokens.find((x) => x.name === name);
    if (t && (found === null || set.active)) { found = t; }
  }
  tokens[name] = found;
  return found;
};
const bind = (shape, name, props, counter) => {
  const token = tokenByName(name);
  if (!token) { return; }
  try { shape.applyToken(token, props); report.bound[counter]++; } catch (e) { warn("bind-failed", e); }
};
const recolor = (list, key) => {
  let changed = false;
  const next = list.map((item) => {
    const h = item && item[key] ? hex(item[key]) : null;
    const to = h ? ops.colorMap[h] : null;
    if (!to) { return item; }
    changed = true;
    const copy = Object.assign({}, item);
    copy[key] = to;
    delete copy[key + "RefId"];
    delete copy[key + "RefFile"];
    return copy;
  });
  return changed ? next : null;
};
const RADIUS = ["borderRadiusTopLeft", "borderRadiusTopRight", "borderRadiusBottomRight", "borderRadiusBottomLeft"];
const SPACING = { rowGap: "rowGap", columnGap: "columnGap", topPadding: "paddingTop", rightPadding: "paddingRight", bottomPadding: "paddingBottom", leftPadding: "paddingLeft" };
const normalize = (s, depth) => {
  if (depth > 40) { return; }
  try {
    const fills = Array.isArray(s.fills) ? s.fills : [];
    const nextFills = recolor(fills, "fillColor");
    if (nextFills) { s.fills = nextFills; report.bound.recolored++; }
    const first = (nextFills || fills)[0];
    if (first && first.fillColor && !first.fillImage) { bind(s, ops.colorTokens[hex(first.fillColor)], ["fill"], "fill"); }
    const strokes = Array.isArray(s.strokes) ? s.strokes : [];
    const nextStrokes = recolor(strokes, "strokeColor");
    if (nextStrokes) { s.strokes = nextStrokes; report.bound.recolored++; }
    const stroke = (nextStrokes || strokes)[0];
    if (stroke && stroke.strokeColor) { bind(s, ops.colorTokens[hex(stroke.strokeColor)], ["strokeColor"], "stroke"); }
    const r = num(s.borderRadius);
    if (s.type !== "text" && r !== null && r > 0) { bind(s, ops.radiusTokens[String(r)], RADIUS, "radius"); }
    const layout = s.flex || s.grid;
    if (layout) {
      for (const k of Object.keys(SPACING)) {
        const v = num(layout[k]);
        if (v !== null && v > 0) { bind(s, ops.spacingTokens[String(v)], [SPACING[k]], "spacing"); }
      }
    }
    if (s.type === "text") {
      const t = lib.typographies.find((x) => str(x.fontFamily).toLowerCase() === str(s.fontFamily).toLowerCase() && str(x.fontSize) === str(s.fontSize) && str(x.fontWeight) === str(s.fontWeight));
      if (t) { t.applyToText(s); report.bound.typography++; }
    }
  } catch (e) {
    warn("normalize-failed", e);
  }
  for (const c of kids(s)) {
    if (!isCopy(c)) { normalize(c, depth + 1); }
  }
};
const systemPages = ${JSON.stringify(SYSTEM_PAGES)};
const block = penpot.history.undoBlockBegin();
try {
  // project pages named like a design system page keep their screens apart
  for (const page of pages) {
    if (systemPages.indexOf(page.name) >= 0) { page.name = page.name + " (project)"; }
  }
  for (const cand of ops.candidates) {
    const made = [];
    for (const v of cand.variants) {
      const page = pageById(v.pageId);
      if (!page) { warn("sample-missing", v.sampleId); continue; }
      try {
        await penpot.openPage(page);
        const shape = page.getShapeById(v.sampleId);
        if (!shape) { warn("sample-missing", v.sampleId); continue; }
        page.root.appendChild(shape);
        const component = lib.createComponent([shape]);
        component.name = cand.name;
        made.push({ component, variant: v });
      } catch (e) {
        warn("component-failed", e);
      }
    }
    let variants = false;
    if (made.length > 1 && made.every((m) => m.variant.pageId === made[0].variant.pageId)) {
      if (typeof penpotUtils !== "undefined" && penpotUtils && typeof penpotUtils.createVariantContainer === "function") {
        try {
          const container = penpotUtils.createVariantContainer(made.map((m) => ({ shape: m.component.mainInstance(), properties: { Style: m.variant.name } })));
          if (container) { container.name = cand.name; }
          variants = true;
        } catch (e) {
          warn("variants-failed", e);
        }
      } else {
        warn("variants-unavailable", cand.name);
      }
    } else if (made.length > 1) {
      warn("variants-other-pages", cand.name);
    }
    report.created.push({
      proposalId: cand.proposalId,
      name: cand.name,
      variants,
      components: made.map((m) => ({ componentId: m.component.id, variant: m.variant.name, sampleId: m.variant.sampleId })),
    });
  }
  for (const page of pages) {
    const tops = kids(page.root);
    const nested = [];
    const find = (s) => {
      for (const c of kids(s)) {
        if (isMain(c) || isContainer(c)) { nested.push(c); } else if (!isCopy(c)) { find(c); }
      }
    };
    for (const top of tops) {
      if (!isMain(top) && !isContainer(top)) { find(top); }
    }
    const roots = tops.filter((s) => isMain(s) || isContainer(s));
    if (nested.length === 0 && roots.length === 0) { continue; }
    await penpot.openPage(page);
    for (const s of nested) {
      try { page.root.appendChild(s); report.relocated++; } catch (e) { warn("relocate-failed", e); }
    }
    for (const s of roots.concat(nested)) { normalize(s, 0); }
  }
  const byId = (id) => lib.components.find((c) => c.id === id) || null;
  for (const r of ops.renames) {
    const c = byId(r.componentId);
    if (c) { c.name = r.name; report.renamed++; }
  }
  for (const g of ops.groups) {
    for (const id of g.componentIds) {
      const c = byId(id);
      if (c) { c.path = g.path; report.grouped++; }
    }
  }
  for (const id of ops.iconComponentIds) {
    const c = byId(id);
    if (c) { c.path = ${JSON.stringify(DEFAULT_ICON_STYLE.pageName)}; report.grouped++; }
  }
  for (const id of ops.drops) {
    const c = byId(id);
    if (!c) { continue; }
    try { c.remove(); report.dropped.push(id); } catch (e) { warn("drop-failed", e); }
  }
} finally {
  penpot.history.undoBlockFinish(block);
}
return report;`;
    }

    /**
     * Code that removes the screens, one undo step: pages without main components (except the
     * design system pages) are removed, the other pages keep only their main components and
     * variant containers, laid out in rows, and are named "Components" (the one with the most)
     * or "Components / <old name>". Returns a {@link PagesReport}.
     */
    public static pagesScript(): string {
        return `const systemPages = ${JSON.stringify(SYSTEM_PAGES)};
const componentsName = ${JSON.stringify(PAGE_NAMES.components)};
${HELPERS}
const report = { removedPages: [], componentPages: [], removedLayers: 0 };
const pages = penpot.currentFile.pages.slice();
const keep = (s) => isMain(s) || isContainer(s);
const block = penpot.history.undoBlockBegin();
try {
  const withComponents = [];
  const empty = [];
  for (const page of pages) {
    if (systemPages.indexOf(page.name) >= 0) { continue; }
    const count = kids(page.root).filter(keep).length;
    if (count > 0) { withComponents.push({ page, count }); } else { empty.push(page); }
  }
  withComponents.sort((a, b) => b.count - a.count);
  for (const entry of withComponents) {
    const page = entry.page;
    await penpot.openPage(page);
    for (const s of kids(page.root).slice()) {
      if (!keep(s)) { s.remove(); report.removedLayers++; }
    }
    let x = 0;
    let y = 0;
    let row = 0;
    for (const s of kids(page.root).filter(keep)) {
      if (x > 0 && x + s.width > 2400) { x = 0; y += row + 64; row = 0; }
      s.x = x;
      s.y = y;
      x += s.width + 64;
      row = Math.max(row, s.height);
    }
  }
  withComponents.forEach((entry, index) => {
    const name = index === 0 ? componentsName : componentsName + " / " + entry.page.name;
    entry.page.name = name;
    report.componentPages.push(name);
  });
  const remaining = penpot.currentFile.pages.length - empty.length;
  if (remaining < 1 && empty.length > 0) { empty.pop(); }
  for (const page of empty) {
    report.removedPages.push(page.name);
    page.remove();
  }
} finally {
  penpot.history.undoBlockFinish(block);
}
return report;`;
    }

    /**
     * Code of the colors stage, one undo step: every color token gets a library color (an
     * existing library color keeps its name and group; a raw value gets one named after the
     * token key), merged and unused library colors are removed. Returns {@link ColorsReport}.
     *
     * @param colors - accepted color tokens
     * @param drops - library color ids to remove
     */
    public static colorsScript(
        colors: { hex: string; opacity: number; token: string; libraryColorId: string | null }[],
        drops: string[]
    ): string {
        return `const colors = ${JSON.stringify(colors)};
const drops = ${JSON.stringify(drops)};
${HELPERS}
const lib = penpot.library.local;
const report = { byHex: {}, created: 0, kept: 0, removed: 0, warnings: [] };
const block = penpot.history.undoBlockBegin();
try {
  for (const c of colors) {
    try {
      let item = c.libraryColorId ? lib.colors.find((x) => x.id === c.libraryColorId) : null;
      if (!item) {
        item = lib.colors.find((x) => hex(x.color) === c.hex && drops.indexOf(x.id) < 0) || null;
      }
      if (item) {
        report.kept++;
      } else {
        item = lib.createColor();
        item.name = c.token.replace(/^color\\./, "");
        item.color = c.hex;
        item.opacity = c.opacity;
        report.created++;
      }
      report.byHex[c.hex] = item.id;
    } catch (e) {
      report.warnings.push({ code: "color-failed", detail: message(e) });
    }
  }
  for (const id of drops) {
    const item = lib.colors.find((x) => x.id === id);
    if (!item) { continue; }
    try { item.remove(); report.removed++; } catch (e) { report.warnings.push({ code: "drop-failed", detail: message(e) }); }
  }
} finally {
  penpot.history.undoBlockFinish(block);
}
return report;`;
    }

    /**
     * Code (no return, no undo block of its own) that removes library typographies; put before
     * W22's import script inside one undo block.
     *
     * @param ids - typography ids
     */
    public static dropTypographiesCode(ids: string[]): string {
        return `for (const id of ${JSON.stringify(ids)}) {
  const item = penpot.library.local.typographies.find((x) => x.id === id);
  if (item) {
    try { item.remove(); } catch (e) { /* kept: Penpot refused */ }
  }
}`;
    }

    /** Code that returns the ids of the library typographies by name. */
    public static typographyIdsScript(): string {
        return `const out = {};
for (const t of penpot.library.local.typographies) { out[t.name] = t.id; }
return out;`;
    }

    /**
     * Code that renders icon candidates to SVG (`penpot.generateMarkup`). Changes nothing.
     * Returns {@link IconMarkup} entries.
     *
     * @param shapes - the candidates and their pages
     */
    public static iconMarkupScript(shapes: { id: string; pageId: string }[]): string {
        return `const shapes = ${JSON.stringify(shapes)};
const out = [];
for (const entry of shapes) {
  const page = penpot.currentFile.pages.find((p) => p.id === entry.pageId);
  const shape = page ? page.getShapeById(entry.id) : null;
  let svg = null;
  if (shape) {
    try { svg = penpot.generateMarkup([shape], { type: "svg" }); } catch (e) { svg = null; }
  }
  out.push({ id: entry.id, svg: typeof svg === "string" && svg.length > 0 ? svg : null });
}
return out;`;
    }
}
