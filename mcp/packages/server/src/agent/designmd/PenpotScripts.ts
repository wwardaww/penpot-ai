import type { WorkflowToolsApi } from "@penpot/mcp-common";
import type { PenpotImportPlan } from "./PenpotImportPlan";

/** Changes an import made to one kind of element. */
export interface ImportCounts {
    created: string[];
    updated: string[];
    unchanged: string[];
}

/** Report of the import script. */
export interface ImportReport {
    colors: ImportCounts;
    typographies: ImportCounts;
    tokens: ImportCounts;
    warnings: string[];
}

/** Library color as read by the snapshot script. */
export interface SnapshotColor {
    id: string;
    name: string;
    path: string;
    /** `#rrggbb`, or null for gradients and images */
    color: string | null;
    opacity: number;
}

/** Library typography as read by the snapshot script (Penpot string values). */
export interface SnapshotTypography {
    id: string;
    name: string;
    path: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    letterSpacing: string;
}

/** Token as read by the snapshot script. */
export interface SnapshotToken {
    name: string;
    type: string;
    /** the raw value (string, or object for composite tokens) */
    value: unknown;
}

/** Token set as read by the snapshot script. */
export interface SnapshotTokenSet {
    name: string;
    active: boolean;
    tokens: SnapshotToken[];
}

/** Solid fill of a shape. */
export interface SnapshotFill {
    color: string;
    opacity: number;
    /** id of the library color the fill uses, if any */
    refId: string | null;
}

/** Text inside a component's main instance. */
export interface SnapshotText {
    fill: SnapshotFill | null;
    tokens: Record<string, string>;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    letterSpacing: string;
}

/** Main instance of a component, reduced to what DESIGN.md describes. */
export interface SnapshotMain {
    type: string;
    width: number;
    height: number;
    radius: number;
    fill: SnapshotFill | null;
    tokens: Record<string, string>;
    /** flex padding `[top, right, bottom, left]`, or null without flex layout */
    padding: number[] | null;
    text: SnapshotText | null;
}

/** Library component as read by the snapshot script. */
export interface SnapshotComponent {
    id: string;
    name: string;
    path: string;
    /** DESIGN.md key recorded on the component, or "" */
    key: string;
    main: SnapshotMain | null;
}

/** Design system of the open file, as read by the snapshot script. */
export interface PenpotSnapshot {
    fileName: string;
    colors: SnapshotColor[];
    typographies: SnapshotTypography[];
    tokenSets: SnapshotTokenSet[];
    components: SnapshotComponent[];
}

/** Result of the component tagging script. */
export interface TagReport {
    tagged: { key: string; componentId: string; name: string }[];
    missing: string[];
}

/**
 * Plugin API code that DESIGN.md workflows run in the open Penpot file through the `execute_code`
 * tool, plus the runner that sends it and reads the result back.
 *
 * The code is plain JavaScript text (not compiled TypeScript), so it runs as written inside the
 * plugin sandbox; tests run the same text against a fake `penpot` object.
 */
export class PenpotScripts {
    /** shared plugin data namespace and key that link a component to its DESIGN.md key */
    public static readonly PLUGIN_NAMESPACE = "penforge";
    public static readonly COMPONENT_KEY = "designMdComponent";

    /**
     * @param tools - the workflow's MCP tools
     */
    constructor(private readonly tools: WorkflowToolsApi) {}

    /**
     * Runs plugin code and returns what it returned.
     *
     * @param code - body of an async function with `penpot` in scope
     * @throws Error when the tool or the code fails
     */
    public async run<T>(code: string): Promise<T> {
        const result = await this.tools.call("execute_code", { code });
        if (result.isError) {
            throw new Error(`Penpot refused the change: ${result.text}`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(result.text);
        } catch {
            throw new Error(`Unexpected answer from Penpot: ${result.text.slice(0, 200)}`);
        }
        return (parsed as { result?: T }).result as T;
    }

    /**
     * Code that creates or updates library colors, typographies, tokens and the DESIGN.md theme.
     * Returns an {@link ImportReport}.
     */
    public static importScript(plan: PenpotImportPlan): string {
        return `const plan = ${JSON.stringify(plan)};
const lib = penpot.library.local;
const counts = () => ({ created: [], updated: [], unchanged: [] });
const report = { colors: counts(), typographies: counts(), tokens: counts(), warnings: [] };
const step = (label, fn) => {
  try { fn(); } catch (e) { report.warnings.push(label + ": " + (e && e.message ? e.message : String(e))); }
};
const sameName = (item, name) => item.name === name && !item.path;

for (const c of plan.colors) {
  step("color " + c.name, () => {
    const item = lib.colors.find((x) => sameName(x, c.name));
    if (!item) {
      const created = lib.createColor();
      created.name = c.name;
      created.color = c.hex;
      created.opacity = c.opacity;
      report.colors.created.push(c.name);
    } else if (String(item.color || "").toLowerCase() === c.hex && Math.abs((item.opacity ?? 1) - c.opacity) < 0.005) {
      report.colors.unchanged.push(c.name);
    } else {
      item.color = c.hex;
      item.opacity = c.opacity;
      report.colors.updated.push(c.name);
    }
  });
}

for (const t of plan.typographies) {
  step("typography " + t.name, () => {
    let item = lib.typographies.find((x) => sameName(x, t.name));
    const isNew = !item;
    const values = (x) => [x.fontFamily, String(x.fontSize), String(x.fontWeight), String(x.lineHeight), String(x.letterSpacing)].join("|");
    const before = isNew ? null : values(item);
    if (isNew) {
      item = lib.createTypography();
      item.name = t.name;
    }
    const font = penpot.fonts.findByName(t.fontFamily);
    if (font) {
      const variants = font.variants || [];
      const variant =
        variants.find((v) => String(v.fontWeight) === t.fontWeight && (v.fontStyle || "normal") === t.fontStyle) ||
        variants.find((v) => String(v.fontWeight) === t.fontWeight);
      if (variant) {
        item.setFont(font, variant);
      } else {
        item.setFont(font);
        item.fontWeight = t.fontWeight;
        report.warnings.push("typography " + t.name + ": " + t.fontFamily + " has no weight " + t.fontWeight);
      }
    } else {
      item.fontFamily = t.fontFamily;
      item.fontWeight = t.fontWeight;
      report.warnings.push("typography " + t.name + ": font " + t.fontFamily + " was not found");
    }
    item.fontSize = t.fontSize;
    item.lineHeight = t.lineHeight;
    item.letterSpacing = t.letterSpacing;
    if (isNew) {
      report.typographies.created.push(t.name);
    } else if (values(item) === before) {
      report.typographies.unchanged.push(t.name);
    } else {
      report.typographies.updated.push(t.name);
    }
  });
}

step("tokens", () => {
  const catalog = lib.tokens;
  if (plan.tokens.length === 0) {
    return;
  }
  if (!catalog.isEditableTokens) {
    report.warnings.push("tokens: this file takes its tokens from a library, so they were not changed");
    return;
  }
  let set = catalog.sets.find((s) => s.name === plan.setName);
  if (!set) {
    set = catalog.addSet({ name: plan.setName, active: true });
  } else if (!set.active) {
    set.active = true;
  }
  for (const tok of plan.tokens) {
    step("token " + tok.name, () => {
      const existing = set.tokens.find((x) => x.name === tok.name);
      if (existing && existing.type === tok.type) {
        if (String(existing.value) === tok.value) {
          report.tokens.unchanged.push(tok.name);
        } else {
          existing.value = tok.value;
          report.tokens.updated.push(tok.name);
        }
      } else {
        if (existing) {
          existing.remove();
        }
        set.addToken({ type: tok.type, name: tok.name, value: tok.value });
        (existing ? report.tokens.updated : report.tokens.created).push(tok.name);
      }
    });
  }
  let theme = catalog.themes.find((th) => th.group === "" && th.name === plan.themeName);
  if (!theme) {
    theme = catalog.addTheme({ group: "", name: plan.themeName });
  }
  if (!theme.activeSets.some((s) => s.id === set.id)) {
    theme.addSet(set);
  }
  if (!theme.active) {
    theme.active = true;
  }
});

return report;`;
    }

    /**
     * Code that reads the design system of the open file. Returns a {@link PenpotSnapshot}.
     */
    public static snapshotScript(): string {
        return `const lib = penpot.library.local;
const ns = ${JSON.stringify(PenpotScripts.PLUGIN_NAMESPACE)};
const key = ${JSON.stringify(PenpotScripts.COMPONENT_KEY)};
const str = (v) => (v === undefined || v === null ? "" : String(v));
const fill = (shape) => {
  const fills = Array.isArray(shape.fills) ? shape.fills : [];
  const f = fills[0];
  if (!f || !f.fillColor) {
    return null;
  }
  return { color: String(f.fillColor).toLowerCase(), opacity: f.fillOpacity ?? 1, refId: f.fillColorRefId || null };
};
const findText = (shape, depth) => {
  if (shape.type === "text") {
    return shape;
  }
  if (depth > 6 || !Array.isArray(shape.children)) {
    return null;
  }
  for (const child of shape.children) {
    const found = findText(child, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
};
const describe = (main) => {
  if (!main) {
    return null;
  }
  const text = findText(main, 0);
  const flex = main.flex;
  return {
    type: main.type,
    width: main.width,
    height: main.height,
    radius: typeof main.borderRadius === "number" ? main.borderRadius : 0,
    fill: main.type === "text" ? null : fill(main),
    tokens: Object.assign({}, main.tokens || {}),
    padding: flex ? [flex.topPadding || 0, flex.rightPadding || 0, flex.bottomPadding || 0, flex.leftPadding || 0] : null,
    text: text
      ? {
          fill: fill(text),
          tokens: Object.assign({}, text.tokens || {}),
          fontFamily: str(text.fontFamily),
          fontSize: str(text.fontSize),
          fontWeight: str(text.fontWeight),
          lineHeight: str(text.lineHeight),
          letterSpacing: str(text.letterSpacing),
        }
      : null,
  };
};
const file = penpot.currentFile;
return {
  fileName: file ? str(file.name) : "",
  colors: lib.colors.map((c) => ({
    id: c.id, name: c.name, path: str(c.path),
    color: c.color && !c.gradient && !c.image ? String(c.color).toLowerCase() : null,
    opacity: c.opacity ?? 1,
  })),
  typographies: lib.typographies.map((t) => ({
    id: t.id, name: t.name, path: str(t.path), fontFamily: str(t.fontFamily), fontSize: str(t.fontSize),
    fontWeight: str(t.fontWeight), lineHeight: str(t.lineHeight), letterSpacing: str(t.letterSpacing),
  })),
  tokenSets: lib.tokens.sets.map((s) => ({
    name: s.name,
    active: !!s.active,
    tokens: s.tokens.map((t) => ({ name: t.name, type: t.type, value: t.value })),
  })),
  components: lib.components.map((c) => {
    let main = null;
    try { main = c.mainInstance(); } catch (e) { main = null; }
    return { id: c.id, name: c.name, path: str(c.path), key: str(c.getSharedPluginData(ns, key)), main: describe(main) };
  }),
};`;
    }

    /**
     * Code that links built components to their DESIGN.md keys (shared plugin data on the library
     * component). A component matches a key by exact name, then by its slug. Returns a
     * {@link TagReport}.
     *
     * @param keys - the component keys of the DESIGN.md
     */
    public static tagComponentsScript(keys: string[]): string {
        return `const keys = ${JSON.stringify(keys)};
const ns = ${JSON.stringify(PenpotScripts.PLUGIN_NAMESPACE)};
const key = ${JSON.stringify(PenpotScripts.COMPONENT_KEY)};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const components = penpot.library.local.components;
const report = { tagged: [], missing: [] };
for (const k of keys) {
  const found =
    components.find((c) => c.getSharedPluginData(ns, key) === k) ||
    components.find((c) => c.name === k) ||
    components.find((c) => slug((c.path ? c.path + " " : "") + c.name) === slug(k)) ||
    components.find((c) => slug(c.name) === slug(k));
  if (!found) {
    report.missing.push(k);
    continue;
  }
  found.setSharedPluginData(ns, key, k);
  report.tagged.push({ key: k, componentId: found.id, name: found.name });
}
return report;`;
    }

    /**
     * Code that saves a named version of the file (the checkpoint before an import). Returns the
     * version label.
     */
    public static saveVersionScript(label: string): string {
        return `const file = penpot.currentFile;
if (!file) {
  throw new Error("No file is open");
}
await file.saveVersion(${JSON.stringify(label)});
return ${JSON.stringify(label)};`;
    }
}
