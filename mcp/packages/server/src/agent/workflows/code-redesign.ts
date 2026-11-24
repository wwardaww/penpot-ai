import type { Workflow } from "@penpot/mcp-common";
import { CodeRedesign, type CodeRedesignParams, RedesignError } from "../linked/CodeRedesign";

/**
 * Re-Design of an Existing project's code (W38): applies the new look from Penpot to the linked
 * app on its own git branch `penforge/redesign-<yyyymmdd-hhmm>`, look only.
 *
 * Params `{action?: "plan"|"run"|"revert", instructions?, decisions?, files?}`. `plan` (default) compares
 * the design with the app (`progress {step: compare}`, read-only) and emits `result {action:"plan",
 * git, dirty, currentBranch, branch, continuing, screens, checklist}` (`checklist` = `{state:"ready",
 * items:[{key, name, kind: component|feature, screens, what, why, checked, decided}]}` or `{state:
 * "failed", message}`); `run` takes the user's choices (`decisions: [{key, build}]`), may ask (`stash` /
 * `commit` / `cancel`, `init` / `cancel`), emits `progress {step: git|checkpoint|edit|commit|guard}`
 * and `result` (`CodeRedesignRunResult`: branch, files changed, screens, unmatched, `outsideLook`,
 * `items: [{key, name, kind, outcome: added|left-out|not-done, note?}]`);
 * `revert {files}` takes files of the `outsideLook` list back (`result {action:"revert", reverted,
 * commit}`). Refusals emit `result {action, error: code, message}` and fail the run.
 */
export const workflow: Workflow<CodeRedesignParams> = {
    name: "code-redesign",
    description: "Applies the new look from Penpot to an Existing project's code, on its own git branch.",
    run: async (ctx, params) => {
        const action = params?.action ?? "plan";
        const redesign = new CodeRedesign(ctx);
        try {
            if (action === "plan") {
                const plan = await redesign.plan();
                ctx.emit("result", plan);
                return {
                    summary: `Re-Design would use branch ${plan.branch ?? "(none)"} for ${plan.screens.length} screens`,
                };
            }
            if (action === "revert") {
                const reverted = await redesign.revert(params?.files);
                ctx.emit("result", reverted);
                return { summary: `Reverted ${reverted.reverted.length} file(s)` };
            }
            if (action !== "run") {
                throw new Error(`Unknown action ${JSON.stringify(action)}`);
            }
            const result = await redesign.run(params ?? {});
            ctx.emit("result", result);
            if (result.cancelled) {
                return { summary: "Re-Design cancelled; nothing changed" };
            }
            return {
                summary:
                    `Re-Design on ${result.branch}: ${result.filesChanged.length} file(s) changed` +
                    (result.outsideLook.length > 0 ? `, ${result.outsideLook.length} outside the look` : ""),
            };
        } catch (error) {
            if (error instanceof RedesignError) {
                ctx.emit("result", { action, error: error.code, message: error.message });
            }
            throw error;
        }
    },
};
