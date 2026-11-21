import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import type { GameEngine, WorkflowContext } from "@penpot/mcp-common";
import { ensureCheckpoint } from "../checkpoints/Checkpoints";
import { DesignTokens } from "../tokens/DesignTokens";
import { PenpotTokenReader } from "../tokens/PenpotTokenReader";
import { RedesignError } from "./CodeRedesign";
import { LinkedProjectPrompt } from "./LinkedProjectPrompt";
import { LinkedToolFilter } from "./LinkedToolFilter";
import { LinkedWorkspace } from "./LinkedWorkspace";
import { type RedesignGitPlan, RedesignBranch } from "./RedesignBranch";
import { RedesignScreens, type ScreenBoard } from "./RedesignScreens";
import type { SourceIndex } from "./SourceInventory";

/** Params of the `game-ui-export` workflow. */
export interface GameUiExportParams {
    action?: "plan" | "run";
}

/** UI framework the guides target. */
export type GameUiFramework = "uitoolkit" | "ugui" | "umg";

/** One exported screen. */
export interface ExportedScreen {
    name: string;
    slug: string;
    /** paths relative to the game folder */
    png1x: string;
    png2x: string;
    guide: string;
}

/** `result` of a `run`. */
export interface GameUiExportRunResult {
    action: "run";
    folder: string | null;
    branch: string | null;
    commit: string | null;
    screens: ExportedScreen[];
    assets: number;
    engine: GameEngine | null;
    ui: GameUiFramework | null;
    cancelled?: true;
}

/** Library and layer facts read from the open file in one script. */
interface DesignFacts {
    colors: Array<{ name: string; path: string; color: string | null; opacity: number }>;
    typographies: Array<Record<string, unknown> & { name: string }>;
    fonts: Array<{ family: string; sizes: number[]; weights: string[] }>;
    assets: Array<{ id: string; name: string; kind: "icon" | "image"; width: number; height: number }>;
}

/**
 * Re-Design of a Game UI project (W38 workflow `game-ui-export`): no change to the game's code or
 * engine assets. Writes `PenforgeUI/` at the game root: `screens/<slug>.png` and `@2x.png` for
 * every screen board, `assets/` (PNG + SVG), `tokens.json`, `fonts.md`, `README.md` and
 * `guides/<slug>.md` (written by Claude: layout, anchors and sizes, states, 9-slice hints,
 * animations, engine steps for UI Toolkit / UGUI or UMG). With git, on a Penforge branch and
 * committing only `PenforgeUI/`. A new run rewrites the folder.
 */
export class GameUiExport {
    public static readonly FOLDER = "PenforgeUI";
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

    constructor(private readonly ctx: WorkflowContext) {}

    /** Tells what a run would do. */
    public async plan(): Promise<
        RedesignGitPlan & { action: "plan"; folder: string; screens: ScreenBoard[]; engine: GameEngine | null }
    > {
        const { root, engine } = this.folder();
        const git = await new RedesignBranch(this.ctx, root, "game").plan();
        return {
            action: "plan",
            ...git,
            folder: GameUiExport.FOLDER,
            screens: await new RedesignScreens(this.ctx).list(),
            engine,
        };
    }

    /** Exports the screens, assets, tokens and guides. */
    public async run(): Promise<GameUiExportRunResult> {
        const { root, engine } = this.folder();
        const boards = await new RedesignScreens(this.ctx).list();
        if (boards.length === 0) {
            throw new RedesignError("no-screens", "The file has no screen boards to export");
        }
        this.progress("git", "Preparing the git branch");
        const prepared = await new RedesignBranch(this.ctx, root, "game").prepare();
        if (prepared.state === "cancelled") {
            return {
                action: "run",
                folder: null,
                branch: null,
                commit: null,
                screens: [],
                assets: 0,
                engine,
                ui: null,
                cancelled: true,
            };
        }
        if (prepared.state === "ready") {
            this.progress("checkpoint", "Saving a checkpoint");
            await ensureCheckpoint(this.ctx, "Before Game UI export", "game-ui-export");
        }
        const out = this.ctx.workspace.resolve(join(root, GameUiExport.FOLDER));
        await rm(out, { recursive: true, force: true });
        for (const dir of ["screens", "assets", "guides"]) {
            await mkdir(join(out, dir), { recursive: true });
        }
        const screens = await this.exportScreens(out, boards);
        this.progress("assets", "Exporting icons and images");
        const facts = await this.designFacts(boards);
        const assets = await this.exportAssets(out, facts.assets);
        this.progress("tokens", "Writing tokens and fonts");
        await this.writeTokens(out, facts);
        await writeFile(join(out, "fonts.md"), GameUiExport.fontsMarkdown(facts), "utf8");
        const ui = await this.framework(engine);
        this.progress("guides", "Writing the engine guides");
        await this.writeGuides(root, out, boards, screens, engine, ui);
        await writeFile(join(out, "README.md"), GameUiExport.readme(screens, assets, engine, ui), "utf8");
        let commit: string | null = null;
        if (prepared.state === "ready") {
            this.progress("commit", "Committing PenforgeUI on the Penforge branch");
            commit = await prepared.git.commit("penforge(redesign): export the game UI to PenforgeUI", false, [
                GameUiExport.FOLDER,
            ]);
        }
        return {
            action: "run",
            folder: out,
            branch: prepared.state === "ready" ? prepared.branch : null,
            commit,
            screens,
            assets,
            engine,
            ui,
        };
    }

    private folder(): { root: string; engine: GameEngine | null } {
        if (this.ctx.context.projectType !== "game") {
            throw new RedesignError("wrong-type", "The game UI export is for Game UI projects");
        }
        const folder = LinkedWorkspace.of(this.ctx);
        if (folder.state !== "linked") {
            throw new RedesignError("not-linked", "The project's folder is not linked on this computer");
        }
        return { root: folder.root, engine: folder.link.engine };
    }

    private async exportScreens(out: string, boards: ScreenBoard[]): Promise<ExportedScreen[]> {
        const slugs = new Set<string>();
        const screens: ExportedScreen[] = [];
        for (const [index, board] of boards.entries()) {
            this.checkCancelled();
            this.ctx.emit("progress", {
                step: "screens",
                params: { done: index, total: boards.length, name: board.name },
                text: `Exporting ${board.name}`,
            });
            const slug = GameUiExport.uniqueSlug(board.name, slugs);
            const png1x = `screens/${slug}.png`;
            const png2x = `screens/${slug}@2x.png`;
            await this.capture(board.boardId, 1, join(out, ...png1x.split("/")));
            await this.capture(board.boardId, 2, join(out, ...png2x.split("/")));
            screens.push({
                name: board.name,
                slug,
                png1x: `${GameUiExport.FOLDER}/${png1x}`,
                png2x: `${GameUiExport.FOLDER}/${png2x}`,
                guide: `${GameUiExport.FOLDER}/guides/${slug}.md`,
            });
        }
        return screens;
    }

    private async capture(nodeId: string, scale: number, file: string): Promise<boolean> {
        const result = await this.ctx.tools.call("capture_node_screenshot", { nodeId, scale, format: "png" });
        const image = (result.content as Array<{ type?: unknown; data?: unknown }>).find(
            (part) => part?.type === "image" && typeof part.data === "string"
        ) as { data: string } | undefined;
        if (result.isError || !image) {
            this.ctx.emit("log", { code: "capture-failed", params: { nodeId }, text: `Could not capture ${nodeId}` });
            return false;
        }
        await writeFile(file, Buffer.from(image.data, "base64"));
        return true;
    }

    private async designFacts(boards: ScreenBoard[]): Promise<DesignFacts> {
        const empty: DesignFacts = { colors: [], typographies: [], fonts: [], assets: [] };
        const code = GameUiExport.FACTS_SCRIPT.replace(
            "BOARD_IDS",
            JSON.stringify(boards.map((board) => board.boardId))
        ).replace("MAX_ASSETS", String(GameUiExport.MAX_ASSETS));
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
                assets: Array.isArray(facts.assets) ? facts.assets.slice(0, GameUiExport.MAX_ASSETS) : [],
            };
        } catch {
            return empty;
        }
    }

    private async exportAssets(out: string, assets: DesignFacts["assets"]): Promise<number> {
        const slugs = new Set<string>();
        let count = 0;
        for (const asset of assets) {
            this.checkCancelled();
            const slug = GameUiExport.uniqueSlug(asset.name, slugs);
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

    private async writeTokens(out: string, facts: DesignFacts): Promise<void> {
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
            generator: "penforge-game-ui-export",
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

    /** UI Toolkit, UGUI or UMG, from the files the background read found. */
    private async framework(engine: GameEngine | null): Promise<GameUiFramework | null> {
        if (engine === "unreal") {
            return "umg";
        }
        if (engine !== "unity") {
            return null;
        }
        const index = await this.ctx.workspace.readJson<SourceIndex | null>("source-index.json", null);
        const files = index?.files ?? [];
        const toolkit = files.some((file) => /\.(uxml|uss)$/i.test(file.path));
        const ugui = files.some((file) => /\.prefab$/i.test(file.path));
        return toolkit || !ugui ? "uitoolkit" : "ugui";
    }

    private async writeGuides(
        root: string,
        out: string,
        boards: ScreenBoard[],
        screens: ExportedScreen[],
        engine: GameEngine | null,
        ui: GameUiFramework | null
    ): Promise<void> {
        const guidesDir = join(out, "guides");
        const list = screens
            .map(
                (screen, index) =>
                    `- "${screen.name}" (boardId ${boards[index].boardId}, ${boards[index].width}×${boards[index].height}) → ${join(guidesDir, `${screen.slug}.md`)}`
            )
            .join("\n");
        try {
            await this.ctx.runner.run({
                prompt: [
                    `Write one engine guide per screen of this ${engine === "unreal" ? "Unreal Engine 5" : "Unity"} game, ` +
                        `for ${GameUiExport.frameworkName(ui)}. Write each guide with the Write tool to the path given:`,
                    list,
                    "",
                    `The screens' PNGs, assets, tokens.json and fonts.md are in \`${out}\`. The game is in \`${root}\`.`,
                    LinkedProjectPrompt.LOOK_ONLY_RULE,
                ].join("\n"),
                promptName: "game-ui-export",
                toolFilter: new LinkedToolFilter(
                    this.ctx.workspace.root,
                    [root, this.ctx.workspace.root],
                    guidesDir,
                    true
                ),
            });
        } catch (error) {
            if (this.ctx.signal.aborted) {
                throw error;
            }
            this.ctx.emit("log", {
                code: "guides-failed",
                params: {},
                text: `The guides could not be written: ${String(error)}`,
            });
        }
        const written = new Set(await readdir(guidesDir).catch(() => [] as string[]));
        for (const [index, screen] of screens.entries()) {
            if (!written.has(`${screen.slug}.md`)) {
                await writeFile(
                    join(guidesDir, `${screen.slug}.md`),
                    GameUiExport.fallbackGuide(screen, boards[index], ui),
                    "utf8"
                );
            }
        }
    }

    private static frameworkName(ui: GameUiFramework | null): string {
        switch (ui) {
            case "uitoolkit":
                return "Unity UI Toolkit (UXML/USS)";
            case "ugui":
                return "Unity UGUI (Canvas, RectTransform, prefabs)";
            case "umg":
                return "UMG (Widget Blueprints)";
            default:
                return "the game's UI system";
        }
    }

    private static fallbackGuide(screen: ExportedScreen, board: ScreenBoard, ui: GameUiFramework | null): string {
        return [
            `# ${screen.name}`,
            "",
            `![${screen.name}](../screens/${screen.slug}.png)`,
            "",
            `- Size: ${board.width}×${board.height} px; reference resolution for ${GameUiExport.frameworkName(ui)}.`,
            "- The detailed guide could not be written automatically; ask the Penforge AI chat to write it again.",
            "",
        ].join("\n");
    }

    private static fontsMarkdown(facts: DesignFacts): string {
        const lines = [
            "# Fonts",
            "",
            "Families and sizes used by the screens. Import each font into the engine",
            "(Unity: Font Asset / TextMeshPro SDF; Unreal: Font Face + Font asset).",
            "",
        ];
        if (facts.fonts.length === 0) {
            lines.push("No text layers found.");
        }
        for (const font of facts.fonts) {
            const sizes = [...font.sizes].sort((a, b) => a - b).join(", ");
            lines.push(
                `## ${font.family}`,
                `- Sizes (px at 1920×1080): ${sizes || "—"}`,
                `- Weights: ${font.weights.join(", ") || "—"}`,
                `- Where to get it: https://fonts.google.com/?query=${encodeURIComponent(font.family)} (check the licence; system and commercial fonts need their own licence)`,
                ""
            );
        }
        return `${lines.join("\n")}\n`;
    }

    private static readme(
        screens: ExportedScreen[],
        assets: number,
        engine: GameEngine | null,
        ui: GameUiFramework | null
    ): string {
        return [
            "# PenforgeUI",
            "",
            `UI specification exported from Penpot by Penforge for this ${engine === "unreal" ? "Unreal Engine 5" : "Unity"} game.`,
            `Target UI system: ${GameUiExport.frameworkName(ui)}. Nothing in the game itself was changed.`,
            "",
            "## Folder",
            "- `screens/` — every screen as PNG at 1× and 2× (`<screen>@2x.png`).",
            `- \`assets/\` — ${assets} icons and images (PNG at 2×, SVG for vector icons).`,
            "- `tokens.json` — colours, type scale, spacing, radii and the design tokens (DTCG).",
            "- `fonts.md` — font families, sizes and where to get them.",
            "- `guides/` — one guide per screen: layout tree, anchors and sizes, states, 9-slice hints,",
            "  animations and the engine steps.",
            "",
            "## Screens",
            ...screens.map(
                (screen) => `- [${screen.name}](guides/${screen.slug}.md) — ![](screens/${screen.slug}.png)`
            ),
            "",
            "Re-run Re-Design in Penforge after design changes: this folder is rewritten.",
            "",
        ].join("\n");
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

    private progress(step: "git" | "checkpoint" | "assets" | "tokens" | "guides" | "commit", text: string): void {
        this.ctx.emit("progress", { step, text });
    }

    private checkCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }
}
