import { writeFile } from "fs/promises";
import { join } from "path";
import type { WorkflowContext } from "@penpot/mcp-common";
import type { ScreenBoard } from "../linked/RedesignScreens";
import { DesignTokens } from "../tokens/DesignTokens";
import { PenpotTokenReader } from "../tokens/PenpotTokenReader";

/** Library and layer facts read from the open file in one script. */
export interface DesignFacts {
    colors: Array<{ name: string; path: string; color: string | null; opacity: number }>;
    typographies: Array<Record<string, unknown> & { name: string }>;
    fonts: Array<{ family: string; sizes: number[]; weights: string[] }>;
    assets: Array<{ id: string; name: string; kind: "icon" | "image"; width: number; height: number }>;
}

/** Files of one exported screen, relative to the spec folder. */
export interface ScreenFiles {
    name: string;
    slug: string;
    png1x: string;
    png2x: string;
    /** both PNGs were written */
    captured: boolean;
}

/** Wording of a `fonts.md` file. */
export interface FontsText {
    /** lines between the title and the families */
    intro: string[];
    /** label of the size list */
    sizes: string;
}

/**
 * Export of the open design's screens, assets, tokens and fonts into a folder: the parts the Game
 * UI export (W38) and Instruct (W41) share. Reads the design only; writes only below the folder it
 * is given.
 */
export class DesignSpecExport {
    public static readonly MAX_ASSETS = 80;

    private static readonly FACTS_SCRIPT = `
const ids = new Set(BOARD_IDS);
const lib = penpot.library.local;
const colors = (lib.colors || []).slice(0, 300).map((c) => ({ name: c.name, path: c.path || "", color: c.color || null, opacity: c.opacity == null ? 1 : c.opacity }));
const typographies = (lib.typographies || []).slice(0, 150).map((t) => ({ name: t.name, fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight, fontStyle: t.fontStyle, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing }));
const fonts = {};
const assets = [];
const seen = new Set();
const visit = (shape, depth) => {
  if (!shape || depth > 40) return;
  try {
    if (shape.type === "text") {
      const family = typeof shape.fontFamily === "string" ? shape.fontFamily : null;
      if (family) {
        const entry = fonts[family] || (fonts[family] = { family, sizes: [], weights: [] });
        const size = Number(shape.fontSize);
        if (size && !entry.sizes.includes(size)) entry.sizes.push(size);
        const weight = String(shape.fontWeight || "");
        if (weight && weight !== "mixed" && !entry.weights.includes(weight)) entry.weights.push(weight);
      }
    }
    const image = Array.isArray(shape.fills) && shape.fills.some((f) => f && f.fillImage);
    const vector = shape.type === "svg-raw" || shape.type === "path" || shape.type === "bool";
    const iconLike = /icon|logo|badge|emblem/i.test(shape.name || "") && shape.type !== "text";
    if ((image || vector || iconLike) && shape.width >= 8 && shape.height >= 8 && assets.length < MAX_ASSETS) {
      const key = (shape.name || "") + ":" + Math.round(shape.width) + "x" + Math.round(shape.height);
      if (!seen.has(key)) {
        seen.add(key);
        assets.push({ id: shape.id, name: shape.name || shape.type, kind: image ? "image" : "icon", width: Math.round(shape.width), height: Math.round(shape.height) });
      }
      if (vector || iconLike) return;
    }
    if (Array.isArray(shape.children)) for (const child of shape.children) visit(child, depth + 1);
  } catch (e) {}
};
for (const page of penpot.currentFile.pages) {
  let root;
  try { root = page.root; } catch (e) { root = null; }
  if (!root || !Array.isArray(root.children)) continue;
  for (const board of root.children) if (ids.has(board.id)) visit(board, 0);
}
return { colors, typographies, fonts: Object.values(fonts), assets };
`;

    /**
     * @param ctx - the workflow context
     * @param attempts - tries per screenshot
     */
    constructor(
        private readonly ctx: WorkflowContext,
        private readonly attempts = 1
    ) {}

    /**
     * Writes `screens/<slug>.png` (1×) and `screens/<slug>@2x.png` (2×) of every board; emits one
     * `progress` event per board.
     *
     * @param out - the spec folder (with a `screens/` folder)
     * @param boards - the screen boards
     */
    public async screens(out: string, boards: readonly ScreenBoard[]): Promise<ScreenFiles[]> {
        const slugs = new Set<string>();
        const screens: ScreenFiles[] = [];
        for (const [index, board] of boards.entries()) {
            this.checkCancelled();
            this.ctx.emit("progress", {
                step: "screens",
                params: { done: index, total: boards.length, name: board.name },
                text: `Exporting ${board.name}`,
            });
            const slug = DesignSpecExport.uniqueSlug(board.name, slugs);
            const png1x = `screens/${slug}.png`;
            const png2x = `screens/${slug}@2x.png`;
            const first = await this.capture(board.boardId, 1, join(out, ...png1x.split("/")));
            const second = await this.capture(board.boardId, 2, join(out, ...png2x.split("/")));
            screens.push({ name: board.name, slug, png1x, png2x, captured: first && second });
        }
        return screens;
    }

    /**
     * Reads the library colours and typographies, and the fonts and assets of the boards.
     *
     * @param boards - the screen boards
     */
    public async facts(boards: readonly ScreenBoard[]): Promise<DesignFacts> {
        const empty: DesignFacts = { colors: [], typographies: [], fonts: [], assets: [] };
        const code = DesignSpecExport.FACTS_SCRIPT.replace(
            "BOARD_IDS",
            JSON.stringify(boards.map((board) => board.boardId))
        ).replace("MAX_ASSETS", String(DesignSpecExport.MAX_ASSETS));
        const result = await this.ctx.tools.call("execute_code", { code });
        if (result.isError) {
            return empty;
        }
        try {
            const parsed = JSON.parse(result.text) as { result?: DesignFacts } & Partial<DesignFacts>;
            const facts = (parsed.result ?? parsed) as Partial<DesignFacts>;
            return {
                colors: Array.isArray(facts.colors) ? facts.colors : [],
                typographies: Array.isArray(facts.typographies) ? facts.typographies : [],
                fonts: Array.isArray(facts.fonts) ? facts.fonts : [],
                assets: Array.isArray(facts.assets) ? facts.assets.slice(0, DesignSpecExport.MAX_ASSETS) : [],
            };
        } catch {
            return empty;
        }
    }

    /**
     * Writes `assets/<slug>.png` (2×), and `.svg` for vector icons.
     *
     * @param out - the spec folder (with an `assets/` folder)
     * @param assets - the assets
     * @returns how many were written
     */
    public async assets(out: string, assets: DesignFacts["assets"]): Promise<number> {
        const slugs = new Set<string>();
        let count = 0;
        for (const asset of assets) {
            this.checkCancelled();
            const slug = DesignSpecExport.uniqueSlug(asset.name, slugs);
            const png = await this.capture(asset.id, 2, join(out, "assets", `${slug}.png`));
            if (asset.kind === "icon") {
                const svg = await this.ctx.tools.call("export_shape", { shapeId: asset.id, format: "svg" });
                if (!svg.isError && svg.text.includes("<svg")) {
                    await writeFile(join(out, "assets", `${slug}.svg`), svg.text, "utf8");
                }
            }
            count += png ? 1 : 0;
        }
        return count;
    }

    /**
     * Writes `tokens.json`: colours, type scale, spacing, radii and the design tokens (DTCG).
     *
     * @param out - the spec folder
     * @param facts - the design facts
     * @param generator - name of the export, recorded in the file
     */
    public async tokens(out: string, facts: DesignFacts, generator: string): Promise<void> {
        let designTokens: unknown = {};
        let spacing: Array<{ name: string; value: number }> = [];
        let radii: Array<{ name: string; value: number }> = [];
        try {
            const tokens = DesignTokens.fromSnapshot(await new PenpotTokenReader(this.ctx.tools).read());
            designTokens = tokens.toDtcg();
            const dimension = (category: string) =>
                tokens.tokens
                    .filter((token) => token.category === category && token.value.kind === "dimension")
                    .map((token) => ({ name: token.name, value: (token.value as { value: number }).value }));
            spacing = dimension("spacing");
            radii = dimension("radius");
        } catch {
            // a file without tokens: colours and type still come from the library
        }
        const tokensJson = {
            generator,
            colors: facts.colors.map((color) => ({
                name: color.path ? `${color.path}/${color.name}` : color.name,
                hex: color.color,
                opacity: color.opacity,
            })),
            typeScale: facts.typographies,
            spacing,
            radii,
            designTokens,
        };
        await writeFile(join(out, "tokens.json"), `${JSON.stringify(tokensJson, null, 2)}\n`, "utf8");
    }

    /**
     * Text of `fonts.md`.
     *
     * @param facts - the design facts
     * @param text - the wording
     */
    public static fontsMarkdown(facts: DesignFacts, text: FontsText): string {
        const lines = ["# Fonts", "", ...text.intro, ""];
        if (facts.fonts.length === 0) {
            lines.push("No text layers found.");
        }
        for (const font of facts.fonts) {
            const sizes = [...font.sizes].sort((a, b) => a - b).join(", ");
            lines.push(
                `## ${font.family}`,
                `- ${text.sizes}: ${sizes || "—"}`,
                `- Weights: ${font.weights.join(", ") || "—"}`,
                `- Where to get it: https://fonts.google.com/?query=${encodeURIComponent(font.family)} (check the licence; system and commercial fonts need their own licence)`,
                ""
            );
        }
        return `${lines.join("\n")}\n`;
    }

    /** File-safe slug of a name, unique within `taken`. */
    public static uniqueSlug(name: string, taken: Set<string>): string {
        const base =
            name
                .normalize("NFKD")
                .replace(/[̀-ͯ]/g, "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 60) || "screen";
        let slug = base;
        for (let n = 2; taken.has(slug); n++) {
            slug = `${base}-${n}`;
        }
        taken.add(slug);
        return slug;
    }

    private async capture(nodeId: string, scale: number, file: string): Promise<boolean> {
        for (let attempt = 0; attempt < this.attempts; attempt++) {
            const result = await this.ctx.tools.call("capture_node_screenshot", { nodeId, scale, format: "png" });
            const image = (result.content as Array<{ type?: unknown; data?: unknown }>).find(
                (part) => part?.type === "image" && typeof part.data === "string"
            ) as { data: string } | undefined;
            if (!result.isError && image) {
                await writeFile(file, Buffer.from(image.data, "base64"));
                return true;
            }
            this.checkCancelled();
        }
        this.ctx.emit("log", { code: "capture-failed", params: { nodeId }, text: `Could not capture ${nodeId}` });
        return false;
    }

    private checkCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }
}
