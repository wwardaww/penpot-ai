import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { WorkflowContext, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { BuildLock } from "../build/BuildLock";
import { LinkedFolders } from "../linked/LinkedFolders";
import { LinkedToolFilter } from "../linked/LinkedToolFilter";
import { RedesignScreens, type ScreenBoard } from "../linked/RedesignScreens";
import { FolderPaths } from "../workspace/FolderPaths";
import type { ProjectOutput } from "../workspace/ProjectOutput";
import { DesignSpecExport, type ScreenFiles } from "./DesignSpecExport";
import { SpecFolder } from "./SpecFolder";

/** Params of the `instruct` workflow. */
export interface InstructParams {
    action?: "plan" | "run";
}

/** Why Instruct cannot run. */
export type InstructErrorCode =
    "wrong-type" | "no-folder" | "folder-missing" | "folder-refused" | "folder-taken" | "no-screens" | "busy";

/** Refusal of the `instruct` workflow, reported as `result {error, message}`. */
export class InstructError extends Error {
    constructor(
        public readonly code: InstructErrorCode,
        message: string
    ) {
        super(message);
        this.name = "InstructError";
    }
}

/** `result` of a `plan`. */
export interface InstructPlanResult {
    action: "plan";
    /** the `PenforgeUI` folder a run writes */
    folder: string;
    screens: ScreenBoard[];
}

/** `result` of a `run`. */
export interface InstructRunResult {
    action: "run";
    folder: string;
    /** paths relative to the picked folder; `captured` false when a PNG could not be taken */
    screens: Array<{ name: string; slug: string; png1x: string; png2x: string; guide: string; captured: boolean }>;
    assets: number;
    /** files the user had changed since the last run, moved to `PenforgeUI/kept/` */
    kept: string[];
}

/** Navigation of the design, from `get_prototype_graph`. */
interface FlowEdge {
    from: string;
    to: string;
    trigger: string;
    sourceName: string;
}

/**
 * Instruct (W41): writes the design of a web or mobile project as a specification for a developer,
 * without any code. The result is the `PenforgeUI/` folder in the folder the user picked:
 * `screens/` (PNG 1× and 2×), `assets/`, `tokens.json`, `fonts.md`, `README.md` and one
 * `guides/<screen>.md` per screen.
 *
 * Everything is prepared in the project's own `.penforge/instruct/` first; Claude works only
 * there. The daemon copies the files into the user's folder ({@link SpecFolder}) as they are
 * ready: the screens, assets and tokens first, then the guides after each Claude turn, so the
 * folder fills while the run goes on and a stopped run keeps what was done. Files of the last run
 * are removed only when the run ends. No git command runs.
 */
export class InstructExport {
    private static readonly GENERATOR = "penforge-instruct";
    /** screens per Claude turn */
    private static readonly BATCH = 6;
    private static readonly STAGING = "instruct";

    private readonly spec: DesignSpecExport;

    constructor(private readonly ctx: WorkflowContext) {
        this.spec = new DesignSpecExport(ctx, 2);
    }

    /** Tells what a run would write. */
    public async plan(): Promise<InstructPlanResult> {
        const folder = this.folder();
        return { action: "plan", folder, screens: await this.boards() };
    }

    /** Writes the specification. */
    public async run(): Promise<InstructRunResult> {
        const folder = this.folder();
        const release = BuildLock.tryAcquire(`${this.ctx.workspace.root}#instruct`);
        if (release === null) {
            throw new InstructError("busy", "Instruct is already running for this project");
        }
        const staging = this.ctx.workspace.resolve(join(this.ctx.workspace.metaDir, InstructExport.STAGING));
        try {
            const boards = await this.boards();
            if (boards.length === 0) {
                throw new InstructError("no-screens", "The file has no screen boards");
            }
            await rm(staging, { recursive: true, force: true });
            return await this.write(folder, staging, boards);
        } finally {
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
            release();
        }
    }

    private async write(folder: string, staging: string, boards: ScreenBoard[]): Promise<InstructRunResult> {
        const out = join(staging, SpecFolder.NAME);
        for (const dir of ["screens", "assets", "guides"]) {
            await mkdir(join(out, dir), { recursive: true });
        }
        const target = new SpecFolder(folder, this.ctx.workspace.projectId);
        const screens = await this.spec.screens(out, boards);
        this.progress("assets", "Exporting icons and images");
        const facts = await this.spec.facts(boards);
        const assets = await this.spec.assets(out, facts.assets);
        this.progress("tokens", "Writing tokens and fonts");
        await this.spec.tokens(out, facts, InstructExport.GENERATOR);
        await writeFile(
            join(out, "fonts.md"),
            DesignSpecExport.fontsMarkdown(facts, {
                intro: ["Families, sizes and weights used by the screens."],
                sizes: this.mobile ? "Sizes (pt / dp)" : "Sizes (px)",
            }),
            "utf8"
        );
        this.checkCancelled();
        // the screens are in the folder before Claude starts on the guides
        await target.publish(out, true);
        const edges = await this.flows();
        await this.writeGuides(staging, out, boards, screens, edges, () => target.publish(out, true));
        await writeFile(join(out, "README.md"), this.readme(boards, screens, assets, edges), "utf8");
        this.checkCancelled();
        this.progress("write", "Writing the folder");
        const published = await target.publish(out);
        return {
            action: "run",
            folder,
            screens: screens.map((screen) => ({
                name: screen.name,
                slug: screen.slug,
                png1x: `${SpecFolder.NAME}/${screen.png1x}`,
                png2x: `${SpecFolder.NAME}/${screen.png2x}`,
                guide: `${SpecFolder.NAME}/guides/${screen.slug}.md`,
                captured: screen.captured,
            })),
            assets,
            kept: published.kept,
        };
    }

    /** The `PenforgeUI` folder to write, checked again before every run. */
    private folder(): string {
        const type = this.ctx.context.projectType;
        if (type === "game" || type === "existing") {
            throw new InstructError("wrong-type", "Instruct is for web and mobile projects");
        }
        const workspace = this.ctx.workspace as WorkflowWorkspaceApi & { outputFolder?: ProjectOutput | null };
        const root = workspace.outputFolder?.outputRoot;
        if (!root) {
            throw new InstructError("no-folder", "Pick an output folder first");
        }
        if (!new FolderPaths().isRealFolder(root)) {
            throw new InstructError("folder-missing", "The output folder does not exist any more");
        }
        // <home>/projects/<id>
        if (new LinkedFolders(dirname(dirname(workspace.root))).isRefusedRoot(root)) {
            throw new InstructError("folder-refused", "This folder cannot be used");
        }
        const folder = join(root, SpecFolder.NAME);
        if (!SpecFolder.isFreeOrOwn(folder, workspace.projectId)) {
            throw new InstructError("folder-taken", "The PenforgeUI folder there was not written by this project");
        }
        return folder;
    }

    private async boards(): Promise<ScreenBoard[]> {
        return new RedesignScreens(this.ctx).list();
    }

    private get mobile(): boolean {
        return this.ctx.context.platform === "mobile";
    }

    private async flows(): Promise<FlowEdge[]> {
        const graph = await this.read("get_prototype_graph", {});
        const edges = (graph as { edges?: unknown } | null)?.edges;
        return (Array.isArray(edges) ? edges : [])
            .filter((edge) => edge !== null && typeof edge === "object")
            .map((edge: Record<string, unknown>) => ({
                from: String(edge.from ?? ""),
                to: String(edge.to ?? ""),
                trigger: String(edge.trigger ?? ""),
                sourceName: String(edge.sourceName ?? ""),
            }));
    }

    private async read(tool: string, args: Record<string, unknown>): Promise<unknown> {
        try {
            const result = await this.ctx.tools.call(tool, args);
            return result.isError ? null : JSON.parse(result.text);
        } catch {
            return null;
        }
    }

    private async writeGuides(
        staging: string,
        out: string,
        boards: ScreenBoard[],
        screens: ScreenFiles[],
        edges: FlowEdge[],
        publish: () => Promise<unknown>
    ): Promise<void> {
        const guidesDir = join(out, "guides");
        const factsDir = join(staging, "facts");
        await mkdir(factsDir, { recursive: true });
        const animations = await this.read("get_animation_spec", { fileId: this.ctx.context.fileId });
        await writeFile(join(factsDir, "animations.json"), `${JSON.stringify(animations ?? {}, null, 1)}\n`, "utf8");
        const names = new Map(boards.map((board) => [board.boardId, board.name]));
        const named = edges.map((edge) => ({
            ...edge,
            fromName: names.get(edge.from) ?? null,
            toName: names.get(edge.to) ?? null,
        }));
        await writeFile(join(factsDir, "flows.json"), `${JSON.stringify(named, null, 1)}\n`, "utf8");
        const expected = new Set(screens.map((screen) => `${screen.slug}.md`));
        for (let start = 0; start < screens.length; start += InstructExport.BATCH) {
            this.checkCancelled();
            this.ctx.emit("progress", {
                step: "guides",
                params: { done: start, total: screens.length },
                text: "Writing the guides",
            });
            const list = screens
                .slice(start, start + InstructExport.BATCH)
                .map((screen, index) => {
                    const board = boards[start + index];
                    return `- "${screen.name}" (boardId ${board.boardId}, ${board.width}×${board.height}) → ${join(guidesDir, `${screen.slug}.md`)}`;
                })
                .join("\n");
            const all = screens
                .map((screen, index) => `"${screen.name}" ${boards[index].width}×${boards[index].height}`)
                .join(", ");
            const before = await InstructExport.guideCount(guidesDir, expected);
            try {
                await this.ctx.runner.run({
                    prompt: [
                        "Write one guide per screen with the Write tool, to the path given:",
                        list,
                        "",
                        `All screens of the file: ${all}.`,
                        `The PNGs, assets, tokens.json and fonts.md are in \`${out}\`.`,
                        `Navigation between screens: \`${join(factsDir, "flows.json")}\`.`,
                        `Animations: \`${join(factsDir, "animations.json")}\`.`,
                    ].join("\n"),
                    promptName: "instruct",
                    toolFilter: new LinkedToolFilter(
                        this.ctx.workspace.root,
                        [this.ctx.workspace.root],
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
                    text: `Some guides could not be written: ${String(error)}`,
                });
            }
            await InstructExport.dropStrayFiles(guidesDir, expected);
            this.checkCancelled();
            await publish();
            if ((await InstructExport.guideCount(guidesDir, expected)) === before) {
                // the same would happen to the next screens: they get the short guide at once
                this.ctx.emit("log", {
                    code: "guides-stopped",
                    params: {},
                    text: "Claude wrote no guide in the last turn; the remaining screens get a short guide.",
                });
                break;
            }
        }
        const written = new Set(await readdir(guidesDir).catch(() => [] as string[]));
        for (const [index, screen] of screens.entries()) {
            if (!written.has(`${screen.slug}.md`)) {
                const guide = InstructExport.fallbackGuide(screen, boards[index], named);
                await writeFile(join(guidesDir, `${screen.slug}.md`), guide, "utf8");
            }
        }
        await InstructExport.dropStrayFiles(guidesDir, expected);
    }

    /** How many of the expected guides exist. */
    private static async guideCount(guidesDir: string, expected: Set<string>): Promise<number> {
        const names = await readdir(guidesDir).catch(() => [] as string[]);
        return names.filter((name) => expected.has(name)).length;
    }

    /** Removes anything but the guides, which does not belong in the folder. */
    private static async dropStrayFiles(guidesDir: string, expected: Set<string>): Promise<void> {
        for (const name of await readdir(guidesDir)) {
            if (!expected.has(name)) {
                await rm(join(guidesDir, name), { recursive: true, force: true });
            }
        }
    }

    private static fallbackGuide(
        screen: ScreenFiles,
        board: ScreenBoard,
        edges: Array<FlowEdge & { toName: string | null }>
    ): string {
        const links = edges
            .filter((edge) => edge.from === board.boardId && edge.toName !== null)
            .map((edge) => `- ${edge.sourceName || "Screen"} (${edge.trigger || "click"}) opens "${edge.toName}".`);
        return [
            `# ${screen.name}`,
            "",
            `![${screen.name}](../${screen.png1x})`,
            "",
            `- Size: ${board.width}×${board.height}.`,
            "- The detailed guide could not be written automatically; run Instruct again.",
            ...(links.length > 0 ? ["", "## Flows", ...links] : []),
            "",
        ].join("\n");
    }

    private readme(boards: ScreenBoard[], screens: ScreenFiles[], assets: number, edges: FlowEdge[]): string {
        const slugs = new Map(boards.map((board, index) => [board.boardId, screens[index]]));
        const links = edges
            .filter((edge) => slugs.has(edge.from) && slugs.has(edge.to))
            .map(
                (edge) =>
                    `- [${slugs.get(edge.from)!.name}](guides/${slugs.get(edge.from)!.slug}.md) — ` +
                    `${edge.sourceName || "screen"} (${edge.trigger || "click"}) → ` +
                    `[${slugs.get(edge.to)!.name}](guides/${slugs.get(edge.to)!.slug}.md)`
            );
        return [
            "# PenforgeUI",
            "",
            `Specification of ${this.mobile ? "a mobile app" : "a responsive web app"}, exported from Penpot by`,
            "Penforge. It holds no code: build the app from the screens, tokens and guides with any stack.",
            "",
            "## Folder",
            "- `screens/` — every screen as PNG at 1× and 2× (`<screen>@2x.png`).",
            `- \`assets/\` — ${assets} icons and images (PNG at 2×, SVG for vector icons).`,
            "- `tokens.json` — colours, type scale, spacing, radii and the design tokens (DTCG).",
            "- `fonts.md` — font families, sizes and where to get them.",
            this.mobile
                ? "- `guides/` — one guide per screen: layout tree, sizes and safe areas, states, flows, animations."
                : "- `guides/` — one guide per screen: layout tree, sizes and breakpoints, states, flows, animations.",
            "",
            "## Screens",
            ...screens.map((screen) => `- [${screen.name}](guides/${screen.slug}.md) — ![](${screen.png1x})`),
            ...(links.length > 0 ? ["", "## Flows between screens", ...links] : []),
            "",
            "Run Instruct again after design changes: the files listed in `.penforge-ui.json` are replaced. Files",
            "you add stay; files you changed are moved to `kept/` first.",
            "",
        ].join("\n");
    }

    private progress(step: "assets" | "tokens" | "write", text: string): void {
        this.ctx.emit("progress", { step, text });
    }

    private checkCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }
}
