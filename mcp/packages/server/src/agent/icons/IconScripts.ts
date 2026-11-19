import type { CollectedIcon } from "./IconCollector";

/** How icons are normalized in Penpot. */
export interface IconStyle {
    /** icon board size in px (square) */
    size: number;
    /** name of the color token bound to strokes and fills */
    tokenName: string;
    /** page that holds the main components */
    pageName: string;
    /** icons per row on that page */
    columns: number;
    /** distance between two icons on the page (cell size) */
    cell: number;
}

/** Defaults of the W29 brief: 24 px, color bound to `color.icon`. */
export const DEFAULT_ICON_STYLE: IconStyle = {
    size: 24,
    tokenName: "color.icon",
    pageName: "Icons",
    columns: 24,
    cell: 64,
};

/** Token set that holds the icon color token when the file has no DESIGN.md set. */
export const ICON_TOKEN_SET = "DESIGN.md";

/** Report of one import chunk. */
export interface IconChunkReport {
    imported: { id: string; componentId: string }[];
    skipped: { name: string; reason: "exists" | "unreadable" | "failed"; detail?: string }[];
    tokenBound: boolean;
}

/** Report of {@link IconScripts.ensureTokenScript}. */
export interface IconTokenReport {
    token: string;
    /** the token's value (a reference such as `{color.on-surface}`, or a hex color) */
    value: string;
    created: boolean;
    /** the token set holding it */
    set: string | null;
    /** set when the tokens of the file cannot be edited (they come from a library) */
    warning?: "tokens-from-library";
}

/** Color tokens tried, in order, as the value of the icon color token. */
export const ICON_COLOR_CANDIDATES = [
    "color.on-surface",
    "color.on-background",
    "color.text",
    "color.text-primary",
    "color.foreground",
    "color.neutral-900",
    "color.primary",
];

/** Shared plugin data key that marks an icon component (value = icon id). */
export const ICON_PLUGIN_KEY = "icon";

/**
 * Plugin code (plain JavaScript run by `execute_code`) of the icon import: the color token,
 * then chunks of icons, each chunk one undo step.
 */
export class IconScripts {
    /**
     * Code that makes sure the icon color token exists (in the active set that holds a candidate
     * color, else in the DESIGN.md set). Returns an {@link IconTokenReport}.
     */
    public static ensureTokenScript(style: IconStyle = DEFAULT_ICON_STYLE): string {
        return `const tokenName = ${JSON.stringify(style.tokenName)};
const candidates = ${JSON.stringify(ICON_COLOR_CANDIDATES)};
const fallbackSet = ${JSON.stringify(ICON_TOKEN_SET)};
const catalog = penpot.library.local.tokens;
const find = (name) => {
  for (const set of catalog.sets) {
    const token = set.tokens.find((t) => t.name === name && t.type === "color");
    if (token) { return { set, token }; }
  }
  return null;
};
const existing = find(tokenName);
if (existing) {
  return { token: tokenName, value: String(existing.token.value), created: false, set: existing.set.name };
}
const base = candidates.map(find).find((x) => x !== null) || null;
const value = base ? "{" + base.token.name + "}" : "#1F2937";
if (!catalog.isEditableTokens) {
  return { token: tokenName, value, created: false, set: null, warning: "tokens-from-library" };
}
let set = base ? base.set : catalog.sets.find((s) => s.name === fallbackSet);
if (!set) {
  set = catalog.addSet({ name: fallbackSet });
}
if (!set.active && !catalog.themes.some((th) => th.active)) {
  set.active = true;
}
set.addToken({ type: "color", name: tokenName, value });
return { token: tokenName, value, created: true, set: set.name };`;
    }

    /**
     * Code that imports one chunk of icons as components: each SVG becomes a square board of
     * `size` px holding the shape scaled to fit and centered, the color token is bound to its
     * strokes and fills, the board becomes a main component named after the icon under path
     * `Icons…`, tagged with shared plugin data `penforge/icon`. Icons already imported (same tag)
     * are skipped. The whole chunk is one undo step. Returns an {@link IconChunkReport}.
     */
    public static importChunkScript(icons: CollectedIcon[], style: IconStyle = DEFAULT_ICON_STYLE): string {
        return `const icons = ${JSON.stringify(icons.map((icon) => ({ id: icon.id, name: icon.name, path: icon.path, svg: icon.svg })))};
const style = ${JSON.stringify(style)};
const ns = "penforge";
const key = ${JSON.stringify(ICON_PLUGIN_KEY)};
let page = penpot.currentFile.pages.find((p) => p.name === style.pageName);
if (!page) {
  page = penpot.createPage();
  page.name = style.pageName;
}
await penpot.openPage(page);
const lib = penpot.library.local;
const done = new Set();
for (const component of lib.components) {
  const tag = component.getSharedPluginData(ns, key);
  if (tag) { done.add(tag); }
}
// tokens apply by name; prefer the one of an active set
let token = null;
for (const set of lib.tokens.sets) {
  const found = set.tokens.find((t) => t.name === style.tokenName && t.type === "color");
  if (found && (token === null || set.active)) { token = found; }
}
const leaves = (shape, into) => {
  const children = shape.children || [];
  if (children.length === 0) { into.push(shape); }
  for (const child of children) { leaves(child, into); }
  return into;
};
const report = { imported: [], skipped: [], tokenBound: token !== null };
let index = done.size;
const block = penpot.history.undoBlockBegin();
try {
  for (const icon of icons) {
    if (done.has(icon.id)) {
      report.skipped.push({ name: icon.id, reason: "exists" });
      continue;
    }
    try {
      const shape = penpot.createShapeFromSvg(icon.svg);
      if (!shape) {
        report.skipped.push({ name: icon.id, reason: "unreadable" });
        continue;
      }
      const board = penpot.createBoard();
      board.name = icon.name;
      board.fills = [];
      board.resize(style.size, style.size);
      board.x = (index % style.columns) * style.cell;
      board.y = Math.floor(index / style.columns) * style.cell;
      const width = shape.width > 0 ? shape.width : style.size;
      const height = shape.height > 0 ? shape.height : style.size;
      const scale = Math.min(style.size / width, style.size / height);
      if (Math.abs(scale - 1) > 0.001) {
        shape.resize(Math.max(0.01, width * scale), Math.max(0.01, height * scale));
      }
      board.appendChild(shape);
      shape.x = board.x + (style.size - shape.width) / 2;
      shape.y = board.y + (style.size - shape.height) / 2;
      if (token) {
        for (const leaf of leaves(shape, [])) {
          const props = [];
          if (Array.isArray(leaf.strokes) && leaf.strokes.length > 0) { props.push("strokeColor"); }
          if (Array.isArray(leaf.fills) && leaf.fills.some((f) => f && f.fillColor)) { props.push("fill"); }
          if (props.length > 0) { leaf.applyToken(token, props); }
        }
      }
      const component = lib.createComponent([board]);
      component.name = icon.name;
      component.path = icon.path;
      component.setSharedPluginData(ns, key, icon.id);
      done.add(icon.id);
      report.imported.push({ id: icon.id, componentId: component.id });
      index++;
    } catch (e) {
      report.skipped.push({ name: icon.id, reason: "failed", detail: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  }
} finally {
  penpot.history.undoBlockFinish(block);
}
return report;`;
    }
}
