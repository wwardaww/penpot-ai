import type { WorkflowToolsApi } from "@penpot/mcp-common";

/** One layer of a screen as Instruct describes it. */
export interface OutlineNode {
    name: string;
    type: string;
    w: number;
    h: number;
    /** position in the parent, when the parent has no flex or grid layout */
    x?: number;
    y?: number;
    hidden?: boolean;
    /** component of a copy */
    component?: string;
    /** flex layout: direction, gaps, paddings (top, right, bottom, left), alignment, wrap */
    flex?: {
        dir: string;
        rowGap: number;
        columnGap: number;
        pad: number[];
        align?: string;
        justify?: string;
        wrap?: boolean;
    };
    grid?: { rows: number; columns: number; rowGap: number; columnGap: number };
    /** sizing in the parent's layout: fix, fill or auto */
    sizing?: { h: string; v: string };
    fill?: string;
    image?: boolean;
    stroke?: string;
    radius?: number;
    opacity?: number;
    /** design tokens applied, by attribute */
    tokens?: Record<string, string>;
    text?: { characters: string; family?: string; size?: string; weight?: string; grow?: string; align?: string };
    children?: OutlineNode[];
    /** children left out at the node limit */
    more?: number;
}

/**
 * Outline of a screen board, read in one plugin call and written as Markdown without Claude: the
 * part of an Instruct guide that is plain design data (layers, sizes, layouts, colours, tokens).
 */
export class ScreenOutline {
    /** layers per screen at most */
    public static readonly MAX_NODES = 700;

    private static readonly SCRIPT = `
const MAX = MAX_NODES;
let count = 0;
const r = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : undefined);
const safe = (f) => { try { return f(); } catch (e) { return undefined; } };
const solid = (list) => {
  const f = Array.isArray(list) ? list.find((x) => x && (x.fillColor || x.strokeColor || x.fillImage)) : null;
  if (!f) return undefined;
  if (f.fillImage) return "image";
  const c = f.fillColor || f.strokeColor;
  const o = f.fillOpacity ?? f.strokeOpacity;
  return o != null && o < 1 ? c + " " + Math.round(o * 100) + "%" : c;
};
const visit = (s, layoutParent, top) => {
  count++;
  const n = { name: s.name, type: s.type, w: r(s.width), h: r(s.height) };
  if (!top && !layoutParent && s.parent) {
    const p = s.parent;
    n.x = r(s.x - p.x);
    n.y = r(s.y - p.y);
  }
  if (s.hidden) n.hidden = true;
  // only the head of a copy names its component; the layers inside it are part of it
  const head = safe(() => (s.isComponentHead ? s.isComponentHead() : s.isComponentRoot && s.isComponentRoot()));
  const comp = head && !safe(() => s.isComponentMainInstance()) ? safe(() => s.component()?.name) : undefined;
  if (comp) n.component = comp;
  const flex = safe(() => s.flex);
  if (flex) {
    n.flex = { dir: flex.dir, rowGap: r(flex.rowGap) || 0, columnGap: r(flex.columnGap) || 0,
      pad: [flex.topPadding, flex.rightPadding, flex.bottomPadding, flex.leftPadding].map((v) => r(v) || 0),
      align: flex.alignItems, justify: flex.justifyContent, wrap: flex.wrap === "wrap" || undefined };
  }
  const grid = safe(() => s.grid);
  if (grid) {
    n.grid = { rows: (grid.rows || []).length, columns: (grid.columns || []).length, rowGap: r(grid.rowGap) || 0, columnGap: r(grid.columnGap) || 0 };
  }
  if (layoutParent) {
    const lc = safe(() => s.layoutChild);
    if (lc) n.sizing = { h: lc.horizontalSizing, v: lc.verticalSizing };
  }
  const fill = safe(() => solid(s.fills));
  if (fill === "image") n.image = true; else if (fill) n.fill = fill;
  const stroke = safe(() => {
    const k = Array.isArray(s.strokes) ? s.strokes[0] : null;
    if (!k) return undefined;
    const sides = [k.strokeWidthTop, k.strokeWidthRight, k.strokeWidthBottom, k.strokeWidthLeft];
    const width = sides.some((v) => typeof v === "number") && sides.some((v) => v !== sides[0])
      ? sides.map((v) => v ?? k.strokeWidth ?? 0).join("/") + "px (top/right/bottom/left)"
      : (k.strokeWidth ?? 1) + "px";
    return solid(s.strokes) + " " + width;
  });
  if (stroke) n.stroke = stroke;
  const radius = safe(() => s.borderRadius);
  if (typeof radius === "number" && radius > 0) n.radius = r(radius);
  if (typeof s.opacity === "number" && s.opacity < 1) n.opacity = r(s.opacity);
  const tokens = safe(() => s.tokens);
  if (tokens && Object.keys(tokens).length) n.tokens = tokens;
  if (s.type === "text") {
    n.text = { characters: String(s.characters || "").slice(0, 160), family: safe(() => s.fontFamily), size: safe(() => String(s.fontSize)),
      weight: safe(() => String(s.fontWeight)), grow: safe(() => s.growType), align: safe(() => s.align) };
  }
  // vectors and icons are leaves; their paths are no layout
  const leaf = s.type === "path" || s.type === "bool" || s.type === "svg-raw" || (comp && /icon|logo/i.test(comp + " " + s.name) && s.width <= 64);
  if (leaf && comp && Array.isArray(s.children) && s.children[0]) {
    // an icon's colour is the colour of its glyph
    const glyph = s.children[0];
    const colour = safe(() => solid(glyph.fills));
    const token = safe(() => glyph.tokens && glyph.tokens.fill);
    if (colour && colour !== "image" && !n.fill) n.fill = colour;
    if (token) n.tokens = Object.assign({}, n.tokens, { fill: token });
  }
  const kids = !leaf && Array.isArray(s.children) ? s.children : [];
  if (kids.length) {
    const inLayout = !!(flex || grid);
    n.children = [];
    for (const k of kids) {
      if (count >= MAX) { n.more = (n.more || 0) + 1; continue; }
      n.children.push(visit(k, inLayout, false));
    }
  }
  return n;
};
// a screen is a top-level board: no walk through every shape of the file
let shape = null;
for (const page of penpot.currentFile.pages) {
  const root = safe(() => page.root);
  shape = root && Array.isArray(root.children) ? root.children.find((c) => c.id === BOARD_ID) : null;
  if (shape) break;
}
if (!shape) return null;
return visit(shape, false, true);
`;

    constructor(private readonly tools: WorkflowToolsApi) {}

    /**
     * Reads the outline of a board, or null when it cannot be read.
     *
     * @param boardId - the screen board
     */
    public async read(boardId: string): Promise<OutlineNode | null> {
        const code = ScreenOutline.SCRIPT.replace("BOARD_ID", JSON.stringify(boardId)).replace(
            "MAX_NODES",
            String(ScreenOutline.MAX_NODES)
        );
        const result = await this.tools.call("execute_code", { code });
        if (result.isError) {
            return null;
        }
        try {
            // a slow call carries a note after the JSON
            const json = result.text.split("\n\nNOTE: ")[0];
            const parsed = JSON.parse(json) as { result?: OutlineNode | null };
            return parsed.result ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Layer tree as a Markdown list: one line per layer with its size, layout, colours and tokens.
     *
     * @param root - the screen
     * @param brief - names, kinds, layouts and texts only (for Claude), without colours and tokens
     */
    public static tree(root: OutlineNode, brief = false): string {
        const lines: string[] = [];
        const walk = (node: OutlineNode, depth: number) => {
            lines.push(`${"  ".repeat(depth)}- ${ScreenOutline.line(node, brief)}`);
            for (const child of node.children ?? []) {
                walk(child, depth + 1);
            }
            if (node.more) {
                lines.push(`${"  ".repeat(depth + 1)}- … ${node.more} more layers`);
            }
        };
        walk(root, 0);
        return lines.join("\n");
    }

    /** Layers whose name or component says icon, logo or image, and layers with an image fill. */
    public static assets(root: OutlineNode): Array<{ name: string; w: number; h: number }> {
        const found = new Map<string, { name: string; w: number; h: number }>();
        const walk = (node: OutlineNode) => {
            const label = node.component ?? node.name;
            if (node.image || /icon|logo|image|photo|avatar/i.test(label)) {
                found.set(`${label}:${node.w}x${node.h}`, { name: label, w: node.w, h: node.h });
            }
            node.children?.forEach(walk);
        };
        walk(root);
        return [...found.values()];
    }

    private static line(node: OutlineNode, brief: boolean): string {
        const parts: string[] = [];
        const name = node.text ? `"${node.text.characters.replace(/\s+/g, " ")}"` : `**${node.name}**`;
        const kind = node.component ? `copy of ${node.component}` : node.type;
        parts.push(`${name} (${kind}, ${node.w}×${node.h})`);
        if (node.hidden) {
            parts.push("hidden");
        }
        if (node.flex) {
            const f = node.flex;
            const gap = f.dir === "row" || f.dir === "row-reverse" ? f.columnGap : f.rowGap;
            const pad = f.pad.every((v) => v === f.pad[0]) ? `${f.pad[0]}` : f.pad.join("/");
            parts.push(
                `flex ${f.dir}, gap ${gap}, padding ${pad}` +
                    (f.align ? `, align ${f.align}` : "") +
                    (f.justify ? `, justify ${f.justify}` : "") +
                    (f.wrap ? ", wraps" : "")
            );
        }
        if (node.grid) {
            parts.push(`grid ${node.grid.rows}×${node.grid.columns}, gap ${node.grid.rowGap}/${node.grid.columnGap}`);
        }
        if (node.sizing && (node.sizing.h !== "fix" || node.sizing.v !== "fix")) {
            parts.push(`width ${node.sizing.h}, height ${node.sizing.v}`);
        }
        if (node.x !== undefined && node.y !== undefined && !brief) {
            parts.push(`at ${node.x},${node.y}`);
        }
        if (node.text) {
            const t = node.text;
            parts.push(
                [
                    t.family,
                    t.size && `${t.size}px`,
                    t.weight,
                    !brief && t.grow,
                    !brief && t.align && t.align !== "left" && t.align,
                ]
                    .filter(Boolean)
                    .join(" ")
            );
        }
        if (!brief) {
            const tokens = node.tokens ?? {};
            const fillToken = tokens.fill;
            if (node.fill) {
                parts.push(`fill ${fillToken ? `${fillToken} (${node.fill})` : node.fill}`);
            }
            if (node.image) {
                parts.push("image fill");
            }
            if (node.stroke) {
                const strokeToken = tokens.strokeColor ?? tokens["stroke-color"];
                parts.push(`stroke ${strokeToken ? `${strokeToken} ${node.stroke}` : node.stroke}`);
            }
            if (node.radius) {
                parts.push(`radius ${node.radius}`);
            }
            if (node.opacity !== undefined) {
                parts.push(`opacity ${node.opacity}`);
            }
            const other = Object.entries(tokens).filter(
                ([attr]) => !["fill", "strokeColor", "stroke-color"].includes(attr)
            );
            if (other.length > 0) {
                parts.push(`tokens ${other.map(([attr, token]) => `${attr}=${token}`).join(", ")}`);
            }
        }
        return parts.filter(Boolean).join(" · ");
    }
}
