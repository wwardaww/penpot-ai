import { writeFile } from "fs/promises";
import { join } from "path";
import type { WorkflowContext, WorkflowToolFilter } from "@penpot/mcp-common";
import type { ScreenBoard } from "../linked/RedesignScreens";
import type { ScreenFiles } from "./DesignSpecExport";
import { type OutlineNode, ScreenOutline } from "./ScreenOutline";

/** Navigation edge with the names of its screens. */
export interface NamedEdge {
    from: string;
    to: string;
    trigger: string;
    sourceName: string;
    fromName: string | null;
    toName: string | null;
}

/** Sections Claude writes for one screen. */
interface ScreenNotes {
    purpose: string;
    sections: Map<string, string>;
}

/** Denies every tool: Claude answers from the prompt alone. */
class NoTools implements WorkflowToolFilter {
    public readonly allowedTools: readonly string[] = [];

    public check(): string {
        return "No tool is available in this step: everything you need is in the message. Answer in text.";
    }
}

/**
 * Writes the screen guides of Instruct (W41). The daemon writes the design data itself (layer
 * tree with sizes, layouts, colours and tokens; flows; animations; assets) from one plugin call per
 * screen. Claude only adds what needs judgement (purpose, breakpoints or screen sizes, states,
 * accessibility, build order), for several screens per turn, without tools, from a short outline
 * in the prompt: a turn costs one model call instead of dozens of design reads.
 */
export class GuideWriter {
    /** screens per Claude turn */
    public static readonly BATCH = 8;
    /** Claude turns running together */
    public static readonly TURNS_AT_ONCE = 3;
    /** outline lines per screen given to Claude */
    public static readonly OUTLINE_LINES = 160;
    /** model of the notes: they need judgement, not the strongest model */
    public static readonly MODEL = "sonnet";

    private readonly outlines = new Map<string, OutlineNode | null>();
    private readonly notes = new Map<string, ScreenNotes>();

    /**
     * @param ctx - the workflow context
     * @param mobile - whether the project is a mobile app
     */
    constructor(
        private readonly ctx: WorkflowContext,
        private readonly mobile: boolean
    ) {}

    /**
     * Writes `guides/<slug>.md` for every screen: first the design data, then Claude's notes.
     *
     * @param guidesDir - the guides folder in the staging folder
     * @param screens - the exported screens
     * @param boards - their boards, in the same order
     * @param edges - navigation between screens
     * @param animations - the animation spec (`get_animation_spec`), or null
     * @param publish - copies the staging folder into the user's folder
     */
    public async write(
        guidesDir: string,
        screens: ScreenFiles[],
        boards: ScreenBoard[],
        edges: NamedEdge[],
        animations: unknown,
        publish: () => Promise<unknown>
    ): Promise<void> {
        const reader = new ScreenOutline(this.ctx.tools);
        for (const [index, screen] of screens.entries()) {
            this.checkCancelled();
            this.outlines.set(screen.slug, await reader.read(boards[index].boardId));
            await this.writeGuide(guidesDir, screen, boards[index], edges, animations);
        }
        await publish();
        this.progress(0, screens.length);

        const starts = Array.from(
            { length: Math.ceil(screens.length / GuideWriter.BATCH) },
            (_, n) => n * GuideWriter.BATCH
        );
        let next = 0;
        let stopped = false;
        // one copy into the user's folder at a time: copies share its manifest
        let copying: Promise<unknown> = Promise.resolve();
        const copy = () => (copying = copying.then(publish, publish));
        const turn = async (start: number) => {
            const batch = screens.slice(start, start + GuideWriter.BATCH);
            const found = await this.askNotes(
                batch,
                boards.slice(start, start + GuideWriter.BATCH),
                screens,
                boards,
                edges
            );
            for (const [offset, screen] of batch.entries()) {
                if (found.has(screen.slug)) {
                    this.notes.set(screen.slug, found.get(screen.slug)!);
                    await this.writeGuide(guidesDir, screen, boards[start + offset], edges, animations);
                }
            }
            this.checkCancelled();
            await copy();
            this.progress(this.notes.size, screens.length);
            if (found.size === 0 && !stopped) {
                // the same would happen to the next screens: they keep the design data only
                stopped = true;
                this.ctx.emit("log", {
                    code: "guides-stopped",
                    params: {},
                    text: "Claude wrote no notes in a turn; the remaining guides hold the design data only.",
                });
            }
        };
        const worker = async () => {
            while (!stopped && next < starts.length) {
                this.checkCancelled();
                await turn(starts[next++]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(GuideWriter.TURNS_AT_ONCE, starts.length) }, worker));
    }

    /** Asks Claude for the notes of some screens; returns those it wrote, by slug. */
    private async askNotes(
        batch: ScreenFiles[],
        batchBoards: ScreenBoard[],
        screens: ScreenFiles[],
        boards: ScreenBoard[],
        edges: NamedEdge[]
    ): Promise<Map<string, ScreenNotes>> {
        const all = screens
            .map((screen, index) => `"${screen.name}" ${boards[index].width}×${boards[index].height}`)
            .join(", ");
        const blocks = batch.map((screen, index) => {
            const board = batchBoards[index];
            const outline = this.outlines.get(screen.slug);
            const tree = outline ? ScreenOutline.tree(outline, true).split("\n") : [];
            const shown = tree.slice(0, GuideWriter.OUTLINE_LINES);
            const flows = GuideWriter.flowLines(board.boardId, edges);
            return [
                `=== ${screen.slug} === "${screen.name}" ${board.width}×${board.height}`,
                flows.length > 0 ? `Flows:\n${flows.join("\n")}` : "Flows: none drawn.",
                shown.length > 0 ? `Layers:\n${shown.join("\n")}` : "Layers: could not be read.",
                tree.length > shown.length ? `(${tree.length - shown.length} more layer lines left out)` : "",
            ]
                .filter(Boolean)
                .join("\n");
        });
        const prompt = [
            `Write the notes of these ${batch.length} screens. Use no tool: everything you need is below.`,
            `All screens of the file: ${all}.`,
            "",
            ...blocks,
        ].join("\n");
        try {
            const result = await this.ctx.runner.run({
                prompt,
                promptName: "instruct",
                toolFilter: new NoTools(),
                model: GuideWriter.MODEL,
            });
            return GuideWriter.parseNotes(result.text, new Set(batch.map((screen) => screen.slug)));
        } catch (error) {
            if (this.ctx.signal.aborted) {
                throw error;
            }
            this.ctx.emit("log", {
                code: "guides-failed",
                params: {},
                text: `Some notes could not be written: ${String(error)}`,
            });
            return new Map();
        }
    }

    /**
     * Splits Claude's answer into the notes of each screen.
     *
     * @param text - the answer: blocks starting with `=== <slug> ===`
     * @param slugs - the screens asked for
     */
    public static parseNotes(text: string, slugs: Set<string>): Map<string, ScreenNotes> {
        const result = new Map<string, ScreenNotes>();
        const parts = text.split(/^===\s*([\w-]+)\s*===.*$/m);
        for (let i = 1; i + 1 < parts.length; i += 2) {
            const slug = parts[i];
            if (!slugs.has(slug)) {
                continue;
            }
            const body = parts[i + 1].trim();
            const [lead, ...rest] = body.split(/^##\s+/m);
            const sections = new Map<string, string>();
            for (const section of rest) {
                const [heading, ...lines] = section.split("\n");
                const content = lines.join("\n").trim();
                if (content) {
                    sections.set(heading.trim(), content);
                }
            }
            if (lead.trim() || sections.size > 0) {
                result.set(slug, { purpose: lead.trim(), sections });
            }
        }
        return result;
    }

    private async writeGuide(
        guidesDir: string,
        screen: ScreenFiles,
        board: ScreenBoard,
        edges: NamedEdge[],
        animations: unknown
    ): Promise<void> {
        await writeFile(join(guidesDir, `${screen.slug}.md`), this.guide(screen, board, edges, animations), "utf8");
    }

    private guide(screen: ScreenFiles, board: ScreenBoard, edges: NamedEdge[], animations: unknown): string {
        const outline = this.outlines.get(screen.slug) ?? null;
        const notes = this.notes.get(screen.slug);
        const sections = new Map(notes?.sections ?? []);
        const take = (heading: string): string[] => {
            const key = [...sections.keys()].find((name) => name.toLowerCase().startsWith(heading.toLowerCase()));
            if (key === undefined) {
                return [];
            }
            const body = sections.get(key)!;
            sections.delete(key);
            return [`## ${key}`, body, ""];
        };
        const sizesHeading = this.mobile ? "Screen sizes" : "Breakpoints";
        const flows = GuideWriter.flowLines(board.boardId, edges);
        const motion = GuideWriter.animationLines(board.boardId, animations);
        const assets = outline ? ScreenOutline.assets(outline) : [];
        const lines = [
            `# ${screen.name}`,
            "",
            `![${screen.name}](../${screen.png1x})`,
            "",
            ...(notes?.purpose ? [notes.purpose, ""] : []),
            `- Size: ${board.width}×${board.height}. Values in the tree are design values (px); colours name their token when one is applied.`,
            ...(notes
                ? []
                : ["- The notes (purpose, states, accessibility, build order) are missing: run Instruct again."]),
            "",
            "## Layout tree",
            outline ? ScreenOutline.tree(outline) : "The layers could not be read.",
            "",
            ...take(sizesHeading),
            ...take("States"),
            "## Flows",
            ...(flows.length > 0 ? flows : ["No navigation is drawn for this screen."]),
            "",
            ...(motion.length > 0 ? ["## Animations", ...motion, ""] : []),
            "## Assets",
            ...(assets.length > 0
                ? [
                      "Files are in `../assets/` (PNG at 2×, SVG for vector icons).",
                      ...assets.map((asset) => `- ${asset.name}: ${asset.w}×${asset.h}`),
                  ]
                : ["No icons or images."]),
            "",
            ...take("Accessibility"),
            ...take("Build order"),
            ...[...sections.entries()].flatMap(([heading, body]) => [`## ${heading}`, body, ""]),
        ];
        return `${lines.join("\n").trimEnd()}\n`;
    }

    private static flowLines(boardId: string, edges: NamedEdge[]): string[] {
        const out = edges
            .filter((edge) => edge.from === boardId && edge.toName !== null)
            .map((edge) => `- ${edge.sourceName || "Screen"} (${edge.trigger || "click"}) opens "${edge.toName}".`);
        const into = edges
            .filter((edge) => edge.to === boardId && edge.fromName !== null)
            .map(
                (edge) =>
                    `- Reached from "${edge.fromName}" by ${edge.sourceName || "a control"} (${edge.trigger || "click"}).`
            );
        return [...new Set([...out, ...into])];
    }

    private static animationLines(boardId: string, animations: unknown): string[] {
        const pages = (animations as { pages?: Array<{ boards?: Array<{ boardId?: string; layers?: unknown[] }> }> })
            ?.pages;
        const board = (Array.isArray(pages) ? pages : [])
            .flatMap((page) => (Array.isArray(page.boards) ? page.boards : []))
            .find((entry) => entry.boardId === boardId);
        const layers = Array.isArray(board?.layers) ? board.layers : [];
        return layers.map((layer) => {
            const { name, ...rest } = (layer ?? {}) as Record<string, unknown>;
            return `- ${typeof name === "string" ? name : "Layer"}: \`${JSON.stringify(rest)}\``;
        });
    }

    private progress(done: number, total: number): void {
        this.ctx.emit("progress", { step: "guides", params: { done, total }, text: "Writing the guides" });
    }

    private checkCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }
}
