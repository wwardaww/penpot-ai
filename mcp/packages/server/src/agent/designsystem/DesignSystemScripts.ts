import type { PenpotImportPlan, PlannedTypography } from "../designmd/PenpotImportPlan";

/** Shared plugin data namespace of Penforge. */
export const PLUGIN_NAMESPACE = "penforge";

/** File-level shared plugin data key that marks a design system file. */
export const DESIGN_SYSTEM_KEY = "designSystem";

/** Shared plugin data key that marks the boards the overview pages generate. */
export const OVERVIEW_KEY = "designSystemPage";

/** File-level marker `penforge/designSystem` (JSON). */
export interface DesignSystemMarker {
    version: 1;
    name: string;
    /** ISO 8601 */
    createdAt: string;
    /** ISO 8601, set by `design-system-generate` */
    generatedAt?: string;
    /** the publish question was asked (asked once) */
    publishAsked?: boolean;
    /** last icon import */
    icons?: { count: number; source: string; license: string | null; importedAt: string };
}

/** Token added by W29 on top of W22's DESIGN.md plan. */
export interface ExtraToken {
    name: string;
    type: "fontSizes" | "fontWeights" | "fontFamilies";
    value: string;
}

/** Overview page kinds. */
export type OverviewKind = "colors" | "typography" | "tokens";

/** Page names of the overview pages and the components page. */
export const PAGE_NAMES: Record<OverviewKind | "components", string> = {
    colors: "Colors",
    typography: "Typography",
    tokens: "Tokens",
    components: "Components",
};

/** Report of an overview page script. */
export interface OverviewReport {
    page: string;
    items: number;
    truncated: boolean;
}

/** Counts of the design system as built. */
export interface DesignSystemSummary {
    colors: number;
    typographies: number;
    components: number;
    variantGroups: number;
    icons: number;
    tokens: number;
    tokenSets: number;
    /** DESIGN.md component keys tagged on a component (W22 `designMdComponent`) */
    taggedKeys: string[];
}

/**
 * Plugin code (plain JavaScript run by `execute_code`) of the design system workflows.
 */
export class DesignSystemScripts {
    /**
     * Wraps plugin code so that all its changes are one undo step.
     *
     * @param code - body of an async function; may `return`
     */
    public static undoable(code: string): string {
        return `const __undoBlock = penpot.history.undoBlockBegin();
try {
${code}
} finally {
  penpot.history.undoBlockFinish(__undoBlock);
}`;
    }

    /**
     * Code that merges `patch` into the file marker `penforge/designSystem` and returns the
     * marker. `createdAt` and `version` are set when missing.
     */
    public static markerScript(patch: Partial<DesignSystemMarker>, now: string): string {
        return `const ns = ${JSON.stringify(PLUGIN_NAMESPACE)};
const key = ${JSON.stringify(DESIGN_SYSTEM_KEY)};
const file = penpot.currentFile;
if (!file) {
  throw new Error("No file is open");
}
let current = {};
try {
  const raw = file.getSharedPluginData(ns, key);
  current = raw ? JSON.parse(raw) : {};
} catch (e) {
  current = {};
}
const next = Object.assign({ version: 1, name: file.name, createdAt: ${JSON.stringify(now)} }, current, ${JSON.stringify(patch)});
file.setSharedPluginData(ns, key, JSON.stringify(next));
return next;`;
    }

    /** Code that reads the file marker; returns it or null. */
    public static readMarkerScript(): string {
        return `const file = penpot.currentFile;
if (!file) {
  return null;
}
const raw = file.getSharedPluginData(${JSON.stringify(PLUGIN_NAMESPACE)}, ${JSON.stringify(DESIGN_SYSTEM_KEY)});
try {
  return raw ? JSON.parse(raw) : null;
} catch (e) {
  return null;
}`;
    }

    /**
     * Typography tokens derived from the plan's text styles (`font-size.<n>`, `font-weight.<n>`,
     * `font-family.<n>`), so that the Tokens panel holds the type scale too.
     */
    public static typographyTokens(typographies: PlannedTypography[]): ExtraToken[] {
        const tokens: ExtraToken[] = [];
        const families = new Map<string, string>();
        for (const typography of typographies) {
            const name = tokenSegment(typography.name);
            if (!name) {
                continue;
            }
            tokens.push({ name: `font-size.${name}`, type: "fontSizes", value: typography.fontSize });
            tokens.push({ name: `font-weight.${name}`, type: "fontWeights", value: typography.fontWeight });
            const familyKey = tokenSegment(typography.fontFamily);
            if (familyKey && !families.has(familyKey)) {
                families.set(familyKey, typography.fontFamily);
            }
        }
        for (const [key, family] of families) {
            tokens.push({ name: `font-family.${key}`, type: "fontFamilies", value: family });
        }
        return tokens;
    }

    /** The W22 plan plus the typography tokens, in the token set of the plan. */
    public static extendPlan(plan: PenpotImportPlan): PenpotImportPlan {
        const extra = DesignSystemScripts.typographyTokens(plan.typographies);
        const taken = new Set(plan.tokens.map((token) => token.name));
        return {
            ...plan,
            tokens: [
                ...plan.tokens,
                ...(extra.filter((token) => !taken.has(token.name)) as unknown as PenpotImportPlan["tokens"]),
            ],
        };
    }

    /**
     * Code that (re)builds an overview page: "Colors" (a swatch per library color), "Typography"
     * (a sample per text style) or "Tokens" (every token, color tokens with a swatch bound to the
     * token). The board it made before (marked with shared plugin data) is replaced. One undo
     * step. Returns an {@link OverviewReport}.
     */
    public static overviewScript(kind: OverviewKind, maxItems: number = 400): string {
        const body: Record<OverviewKind, string> = {
            colors: COLORS_BODY,
            typography: TYPOGRAPHY_BODY,
            tokens: TOKENS_BODY,
        };
        return `const kind = ${JSON.stringify(kind)};
const title = ${JSON.stringify(PAGE_NAMES[kind])};
const maxItems = ${maxItems};
const ns = ${JSON.stringify(PLUGIN_NAMESPACE)};
const key = ${JSON.stringify(OVERVIEW_KEY)};
let page = penpot.currentFile.pages.find((p) => p.name === title);
if (!page) {
  page = penpot.createPage();
  page.name = title;
}
await penpot.openPage(page);
const lib = penpot.library.local;
const ink = "#1F2937";
const muted = "#6B7280";
const block = penpot.history.undoBlockBegin();
try {
  for (const old of [...page.root.children]) {
    if (old.getSharedPluginData(ns, key) === kind) {
      old.remove();
    }
  }
  const frame = penpot.createBoard();
  frame.name = title;
  frame.setSharedPluginData(ns, key, kind);
  frame.fills = [{ fillColor: "#FFFFFF", fillOpacity: 1 }];
  const place = (shape, x, y) => {
    frame.appendChild(shape);
    shape.x = frame.x + x;
    shape.y = frame.y + y;
    return shape;
  };
  const label = (text, x, y, size, color) => {
    const t = penpot.createText(text);
    if (!t) {
      return null;
    }
    t.growType = "auto-width";
    t.fontSize = String(size);
    t.fills = [{ fillColor: color || ink, fillOpacity: 1 }];
    return place(t, x, y);
  };
  const swatch = (x, y, w, h) => {
    const r = penpot.createRectangle();
    r.resize(w, h);
    r.borderRadius = 8;
    r.strokes = [{ strokeColor: "#E5E7EB", strokeWidth: 1, strokeOpacity: 1, strokeStyle: "solid", strokeAlignment: "inner" }];
    return place(r, x, y);
  };
${body[kind]}
} finally {
  penpot.history.undoBlockFinish(block);
}`;
    }

    /** Code that counts what the design system file holds. Returns a {@link DesignSystemSummary}. */
    public static summaryScript(): string {
        return `const lib = penpot.library.local;
const ns = ${JSON.stringify(PLUGIN_NAMESPACE)};
const groups = new Set();
let icons = 0;
const tagged = new Set();
for (const component of lib.components) {
  if (component.getSharedPluginData(ns, "icon")) {
    icons++;
  }
  const keyTag = component.getSharedPluginData(ns, "designMdComponent");
  if (keyTag) {
    tagged.add(keyTag);
  }
  if (typeof component.isVariant === "function" && component.isVariant()) {
    const id = component.variants && component.variants.id ? component.variants.id : component.name;
    groups.add(id);
  }
}
let tokens = 0;
for (const set of lib.tokens.sets) {
  tokens += set.tokens.length;
}
return {
  colors: lib.colors.length,
  typographies: lib.typographies.length,
  components: lib.components.length,
  variantGroups: groups.size,
  icons,
  tokens,
  tokenSets: lib.tokens.sets.length,
  taggedKeys: [...tagged].sort(),
};`;
    }
}

const COLORS_BODY = `  const colors = lib.colors.filter((c) => typeof c.color === "string").slice(0, maxItems);
  const columns = 6;
  const cellW = 176;
  const cellH = 136;
  const rows = Math.max(1, Math.ceil(colors.length / columns));
  frame.resize(32 + columns * cellW, 96 + rows * cellH);
  label(title, 32, 32, 28);
  colors.forEach((c, i) => {
    const x = 32 + (i % columns) * cellW;
    const y = 96 + Math.floor(i / columns) * cellH;
    const r = swatch(x, y, cellW - 16, 72);
    r.name = c.name;
    r.fills = [c.asFill()];
    label((c.path ? c.path + " / " : "") + c.name, x, y + 80, 13);
    label(String(c.color).toUpperCase() + (c.opacity !== undefined && c.opacity < 1 ? " " + Math.round(c.opacity * 100) + "%" : ""), x, y + 100, 12, muted);
  });
  return { page: title, items: colors.length, truncated: lib.colors.length > colors.length };`;

const TYPOGRAPHY_BODY = `  const styles = lib.typographies.slice(0, maxItems);
  const sample = "The quick brown fox jumps over the lazy dog";
  const rowHeight = (t) => Math.max(56, Math.ceil((parseFloat(t.fontSize) || 16) * (parseFloat(t.lineHeight) || 1.2)) + 40);
  const height = styles.reduce((sum, t) => sum + rowHeight(t), 0);
  frame.resize(1200, 112 + height);
  label(title, 32, 32, 28);
  let y = 96;
  for (const t of styles) {
    label((t.path ? t.path + " / " : "") + t.name + " · " + t.fontFamily + " " + t.fontWeight + " · " + t.fontSize + "/" + t.lineHeight, 32, y, 12, muted);
    const text = label(sample, 32, y + 20, 16);
    if (text) {
      text.name = t.name;
      t.applyToText(text);
    }
    y += rowHeight(t);
  }
  return { page: title, items: styles.length, truncated: lib.typographies.length > styles.length };`;

const TOKENS_BODY = `  const rows = [];
  for (const set of lib.tokens.sets) {
    rows.push({ set });
    for (const token of set.tokens) {
      rows.push({ set, token });
    }
  }
  const shown = rows.slice(0, maxItems);
  frame.resize(960, 112 + shown.length * 36);
  label(title, 32, 32, 28);
  let y = 96;
  for (const row of shown) {
    if (!row.token) {
      label(row.set.name + (row.set.active ? "" : " (inactive)"), 32, y + 8, 16);
      y += 36;
      continue;
    }
    const token = row.token;
    const value = typeof token.value === "string" ? token.value : JSON.stringify(token.value);
    if (token.type === "color") {
      const r = swatch(48, y + 4, 24, 24);
      r.name = token.name;
      const resolved = token.resolvedValueString;
      r.fills = [{ fillColor: typeof resolved === "string" && /^#/.test(resolved) ? resolved.slice(0, 7) : "#FFFFFF", fillOpacity: 1 }];
      try {
        token.applyToShapes([r], ["fill"]);
      } catch (e) {
        // an inactive set: the swatch keeps the resolved color
      }
    }
    label(token.name, 88, y + 8, 13);
    label(token.type + " · " + value, 420, y + 8, 12, muted);
    y += 36;
  }
  return { page: title, items: shown.filter((row) => row.token).length, truncated: rows.length > shown.length };`;

function tokenSegment(name: string): string {
    return String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
