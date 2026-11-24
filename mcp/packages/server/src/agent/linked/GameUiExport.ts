import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import type { GameEngine, WorkflowContext } from "@penpot/mcp-common";
import { ensureCheckpoint } from "../checkpoints/Checkpoints";
import { DesignSpecExport } from "../instruct/DesignSpecExport";
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
    private static readonly FONTS_TEXT = {
        intro: [
            "Families and sizes used by the screens. Import each font into the engine",
            "(Unity: Font Asset / TextMeshPro SDF; Unreal: Font Face + Font asset).",
        ],
        sizes: "Sizes (px at 1920×1080)",
    };

    private readonly spec: DesignSpecExport;

    constructor(private readonly ctx: WorkflowContext) {
        this.spec = new DesignSpecExport(ctx);
    }

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
        const screens = (await this.spec.screens(out, boards)).map((screen) => ({
            name: screen.name,
            slug: screen.slug,
            png1x: `${GameUiExport.FOLDER}/${screen.png1x}`,
            png2x: `${GameUiExport.FOLDER}/${screen.png2x}`,
            guide: `${GameUiExport.FOLDER}/guides/${screen.slug}.md`,
        }));
        this.progress("assets", "Exporting icons and images");
        const facts = await this.spec.facts(boards);
        const assets = await this.spec.assets(out, facts.assets);
        this.progress("tokens", "Writing tokens and fonts");
        await this.spec.tokens(out, facts, "penforge-game-ui-export");
        await writeFile(join(out, "fonts.md"), DesignSpecExport.fontsMarkdown(facts, GameUiExport.FONTS_TEXT), "utf8");
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

    private progress(step: "git" | "checkpoint" | "assets" | "tokens" | "guides" | "commit", text: string): void {
        this.ctx.emit("progress", { step, text });
    }
}
