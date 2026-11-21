import type { Workflow } from "@penpot/mcp-common";
import { RedesignError } from "../linked/CodeRedesign";
import { GameUiExport, type GameUiExportParams } from "../linked/GameUiExport";

/**
 * Re-Design of a Game UI project (W38): exports the UI spec into `PenforgeUI/` at the game root
 * (PNG of every screen at 1× and 2×, assets, `tokens.json`, `fonts.md`, `README.md`, one engine
 * guide per screen). No change to the game's code or engine assets.
 *
 * Params `{action?: "plan"|"run"}`. `plan` (default) emits `result {action:"plan", git, dirty,
 * currentBranch, branch, continuing, folder, screens, engine}`; `run` may ask (`init` / `skip`,
 * `stash` / `commit` / `cancel`), emits `progress {step: git|checkpoint|screens|assets|tokens|
 * guides|commit}` and `result` (`GameUiExportRunResult`). Refusals emit `result {action, error:
 * code, message}` and fail the run.
 */
export const workflow: Workflow<GameUiExportParams> = {
    name: "game-ui-export",
    description: "Exports a Game UI project's screens, assets, tokens and engine guides into PenforgeUI/.",
    run: async (ctx, params) => {
        const action = params?.action ?? "plan";
        const exporter = new GameUiExport(ctx);
        try {
            if (action === "plan") {
                const plan = await exporter.plan();
                ctx.emit("result", plan);
                return { summary: `Game UI export would write ${plan.screens.length} screens to ${plan.folder}` };
            }
            if (action !== "run") {
                throw new Error(`Unknown action ${JSON.stringify(action)}`);
            }
            const result = await exporter.run();
            ctx.emit("result", result);
            return {
                summary: result.cancelled
                    ? "Game UI export cancelled; nothing changed"
                    : `Exported ${result.screens.length} screens and ${result.assets} assets to ${result.folder}`,
            };
        } catch (error) {
            if (error instanceof RedesignError) {
                ctx.emit("result", { action, error: error.code, message: error.message });
            }
            throw error;
        }
    },
};
