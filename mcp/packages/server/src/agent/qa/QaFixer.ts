import { writeFile } from "fs/promises";
import type { WorkflowContext } from "@penpot/mcp-common";
import { AppSourceGit } from "../build/AppSourceGit";
import type { Region } from "./PixelCompare";
import type { QaSettings } from "./QaConfig";
import { QaToolFilter } from "./QaToolFilter";
import type { QaShot, VisualQa } from "./VisualQa";

/** Outcome of the fix loop of one screen. */
export interface ScreenFix {
    /** comparison before any fix */
    before: QaShot;
    /** best comparison reached (the code on disk matches it) */
    after: QaShot;
    /** Claude turns used */
    attempts: number;
    /** files changed and kept, relative to `app-src/` */
    changedFiles: string[];
}

/**
 * Fix loop of the visual QA: for each screen below the threshold, Claude gets the design, the
 * app screenshot, the heatmap and the screen's files, changes the code (and only the code), and
 * the daemon checks again. A change that does not raise the score is reverted at once, and the
 * loop of a screen ends when it matches, after `maxIterations` turns, or when a turn changes
 * nothing or does not help.
 */
export class QaFixer {
    private readonly git: AppSourceGit;
    private readonly filter: QaToolFilter;

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly qa: VisualQa,
        private readonly settings: QaSettings,
        /** sleeps between a fix and the next screenshot (hot reload); replaceable in tests */
        private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
    ) {
        this.git = new AppSourceGit(ctx.workspace.appSrcDir);
        this.filter = new QaToolFilter(ctx.workspace.root, ctx.workspace.appSrcDir);
    }

    /**
     * Fixes one screen.
     *
     * @param first - the screen's current comparison (below the threshold)
     * @param maxIterations - Claude turns allowed for this screen
     */
    public async fix(first: QaShot, maxIterations = this.settings.maxIterations): Promise<ScreenFix> {
        const { screen } = first;
        let best = first;
        let attempts = 0;
        let sessionId: string | undefined;
        const kept = new Set<string>();
        while (attempts < maxIterations && !best.passed) {
            this.checkAborted();
            attempts++;
            this.ctx.emit("progress", {
                step: "fix",
                params: { name: screen.name, attempt: attempts, of: maxIterations },
                text: `Fixing ${screen.name} (try ${attempts} of ${maxIterations})`,
            });
            const before = await this.git.snapshot();
            const turn = await this.ctx.runner.run({
                prompt: QaFixer.prompt(best, attempts, this.qa),
                promptName: "visual-qa",
                resumeSessionId: sessionId,
                attachments: [
                    { kind: "image", mime: "image/png", base64: best.design.toString("base64") },
                    { kind: "image", mime: "image/png", base64: best.app.toString("base64") },
                    { kind: "image", mime: "image/png", base64: best.diff.toString("base64") },
                ],
                toolFilter: this.filter,
            });
            sessionId = turn.sessionId ?? sessionId;
            this.checkAborted();
            const changed = await this.git.changedFiles(before, await this.git.snapshot());
            if (changed.length === 0) {
                break;
            }
            await this.wait(this.settings.reloadDelayMs);
            const next = await this.qa.check(screen);
            if (next.score > best.score) {
                best = next;
                changed.forEach((file) => kept.add(file));
                continue;
            }
            // no better: put the files back and keep the saved images of the best state
            this.ctx.emit("log", {
                code: "fix-reverted",
                params: { name: screen.name, score: next.score, best: best.score },
                text: `A change to ${screen.name} did not help (${next.score} vs ${best.score}); undone.`,
            });
            await this.git.restore(before, changed);
            await Promise.all([writeFile(best.paths.app, best.app), writeFile(best.paths.diff, best.diff)]);
            break;
        }
        return { before: first, after: best, attempts, changedFiles: [...kept].sort() };
    }

    /**
     * User prompt of one fix turn; the three images follow in the order named here.
     */
    public static prompt(shot: QaShot, attempt: number, qa: VisualQa): string {
        const { screen } = shot;
        const lines = [
            attempt === 1
                ? `Make the screen "${screen.name}" of the app look like its design board.`
                : `The app now scores ${shot.score}. Keep going: make "${screen.name}" closer to the design.`,
            "",
            `- Route: ${screen.route}; viewport ${screen.width}×${screen.height} px (the board size).`,
            `- Match score: ${shot.score} / 100 (pixels that differ: ${(shot.diffRatio * 100).toFixed(1)} %, ` +
                `structure similarity: ${shot.ssim.toFixed(3)}). Goal: at least ${qa.threshold}.`,
            `- Screen files (in app-src/): ${screen.files.length > 0 ? screen.files.join(", ") : "unknown; find them from the route"}.`,
            `- Design board id: ${screen.boardId} (read it with get_node_properties / generate_code_hints for exact values).`,
            `- Areas that differ most (x, y, width × height in px): ${QaFixer.regions(shot.regions)}.`,
            `- Saved images: ${qa.projectPath(shot.paths.design)}, ${qa.projectPath(shot.paths.app)}, ${qa.projectPath(shot.paths.diff)}.`,
            "",
            "Images attached, in this order: 1. the design, 2. the app as it renders now, " +
                "3. the differences (red = pixels that differ, grey = the design).",
        ];
        return lines.join("\n");
    }

    private static regions(regions: Region[]): string {
        if (regions.length === 0) {
            return "none found";
        }
        return regions.map((r) => `(${r.x}, ${r.y}, ${r.width} × ${r.height})`).join(", ");
    }

    private checkAborted(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }
}
