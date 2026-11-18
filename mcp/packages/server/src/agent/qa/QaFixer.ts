import { writeFile } from "fs/promises";
import type { Attachment, WorkflowContext } from "@penpot/mcp-common";
import { AppSourceGit } from "../build/AppSourceGit";
import { DesignToolFilter } from "../tools/DesignToolFilter";
import type { Region } from "./PixelCompare";
import { PngImages } from "./PngImages";
import type { QaBudget } from "./QaBudget";
import type { QaSettings } from "./QaConfig";
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

/** One earlier try of a screen, told to the next fresh turn. */
interface TryNote {
    attempt: number;
    from: number;
    to: number;
    files: string[];
}

/**
 * Fix loop of the visual QA: for each screen below the threshold, Claude gets the design, the
 * app screenshot, the heatmap and the screen's files, changes the code (and only the code), and
 * the daemon checks again. A change that does not raise the score is reverted at once, and the
 * loop of a screen ends when it matches, after `maxIterations` turns, when a turn changes nothing
 * or does not help, or when the run's {@link QaBudget} is spent.
 *
 * Every turn is a fresh Claude session with only the current three images (scaled to the API
 * limits); what earlier tries did is summed up in the prompt instead.
 */
export class QaFixer {
    private readonly git: AppSourceGit;
    private readonly filter: DesignToolFilter;

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly qa: VisualQa,
        private readonly settings: QaSettings,
        private readonly budget: QaBudget,
        /** sleeps between a fix and the next screenshot (hot reload); replaceable in tests */
        private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
    ) {
        this.git = new AppSourceGit(ctx.workspace.appSrcDir);
        this.filter = new DesignToolFilter(
            ctx.workspace.root,
            ctx.workspace.appSrcDir,
            "Not available during a visual check: Penforge reloads and checks the app itself."
        );
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
        const kept = new Set<string>();
        const notes: TryNote[] = [];
        while (attempts < maxIterations && !best.passed && this.budget.takeTurn()) {
            attempts++;
            this.ctx.emit("progress", {
                step: "fix",
                params: { name: screen.name, attempt: attempts, of: maxIterations },
                text: `Fixing ${screen.name} (try ${attempts} of ${maxIterations})`,
            });
            const before = await this.git.snapshot();
            let changed: string[];
            try {
                await this.ctx.runner.run({
                    prompt: QaFixer.prompt(best, attempts, this.qa, notes),
                    promptName: "visual-qa",
                    attachments: await QaFixer.images(best),
                    toolFilter: this.filter,
                });
                this.checkAborted();
                changed = await this.git.changedFiles(before, await this.git.snapshot());
            } catch (error) {
                // stopped or failed mid-try: never leave half-made edits behind
                await this.revertSince(before);
                throw error;
            }
            if (changed.length === 0) {
                break;
            }
            await this.wait(this.settings.reloadDelayMs);
            let next: QaShot;
            try {
                this.checkAborted();
                next = await this.qa.check(screen);
            } catch (error) {
                await this.revertSince(before);
                throw error;
            }
            if (next.score > best.score) {
                notes.push({ attempt: attempts, from: best.score, to: next.score, files: changed });
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
            // the files of the undone attempt show the best state again
            await Promise.all([writeFile(next.paths.app, best.app), writeFile(next.paths.diff, best.diff)]);
            break;
        }
        return { before: first, after: best, attempts, changedFiles: [...kept].sort() };
    }

    /**
     * User prompt of one fix turn; the three images follow in the order named here.
     */
    public static prompt(shot: QaShot, attempt: number, qa: VisualQa, notes: TryNote[] = []): string {
        const { screen } = shot;
        const lines = [
            `Make the screen "${screen.name}" of the app look like its design board.`,
            "",
            `- Route: ${screen.route}; viewport ${screen.width}×${screen.height} px (the board size).`,
            `- Match score: ${shot.score} / 100 (pixels that differ: ${(shot.diffRatio * 100).toFixed(1)} %, ` +
                `structure similarity: ${shot.ssim.toFixed(3)}). Goal: at least ${qa.threshold}.`,
            `- Screen files (in app-src/): ${screen.files.length > 0 ? screen.files.join(", ") : "unknown; find them from the route"}.`,
            `- Design board id: ${screen.boardId} (read it with get_node_properties / generate_code_hints for exact values).`,
            `- Areas that differ most (x, y, width × height in board px): ${QaFixer.regions(shot.regions)}.`,
            `- Saved full-size images: ${qa.projectPath(shot.paths.design)}, ${qa.projectPath(shot.paths.app)}, ${qa.projectPath(shot.paths.diff)}.`,
        ];
        if (attempt > 1 && notes.length > 0) {
            lines.push(
                `- This is try ${attempt}. Earlier tries (already in the code): ` +
                    notes
                        .map(
                            (n) => `try ${n.attempt} raised the score from ${n.from} to ${n.to} (${n.files.join(", ")})`
                        )
                        .join("; ") +
                    "."
            );
        }
        lines.push(
            "",
            "Images attached, in this order: 1. the design, 2. the app as it renders now, " +
                "3. the differences (red = pixels that differ, grey = the design). Large images are scaled down."
        );
        return lines.join("\n");
    }

    /** The three images of a comparison, within Claude's image limits. */
    private static async images(shot: QaShot): Promise<Attachment[]> {
        const parts = await Promise.all([shot.design, shot.app, shot.diff].map((png) => PngImages.forClaude(png)));
        return parts.map((part) => ({ kind: "image", mime: part.mime, base64: part.base64 }));
    }

    private static regions(regions: Region[]): string {
        if (regions.length === 0) {
            return "none found";
        }
        return regions.map((r) => `(${r.x}, ${r.y}, ${r.width} × ${r.height})`).join(", ");
    }

    /** Puts back every file changed since a snapshot (best effort while stopping). */
    private async revertSince(before: string): Promise<void> {
        try {
            await this.git.restore(before, await this.git.changedFiles(before, await this.git.snapshot()));
        } catch {
            // the run is ending anyway; the checkpoint taken first can restore the code
        }
    }

    private checkAborted(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }
}
