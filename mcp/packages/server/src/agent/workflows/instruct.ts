import type { Workflow } from "@penpot/mcp-common";
import { InstructError, InstructExport, type InstructParams } from "../instruct/InstructExport";

/**
 * Instruct of a web or mobile project (W41): writes the design as a specification without code into
 * `PenforgeUI/` of the output folder the user picked (`project.output.set`): PNG of every screen at
 * 1× and 2×, assets, `tokens.json`, `fonts.md`, `README.md` and one guide per screen. Runs no git
 * command and no install.
 *
 * Params `{action?: "plan"|"run"}`. `plan` (default) emits `result {action:"plan", folder,
 * screens}`; `run` emits `progress {step: screens|assets|tokens|guides|write, params?, text}` and
 * `result` (`InstructRunResult`). Refusals emit `result {action, error: code, message}` and fail
 * the run.
 */
export const workflow: Workflow<InstructParams> = {
    name: "instruct",
    description: "Writes the design of a web or mobile project as a specification (PenforgeUI/) without code.",
    run: async (ctx, params) => {
        const action = params?.action ?? "plan";
        const instruct = new InstructExport(ctx);
        try {
            if (action === "plan") {
                const plan = await instruct.plan();
                ctx.emit("result", plan);
                return { summary: `Instruct would write ${plan.screens.length} screens to ${plan.folder}` };
            }
            if (action !== "run") {
                throw new Error(`Unknown action ${JSON.stringify(action)}`);
            }
            const result = await instruct.run();
            ctx.emit("result", result);
            return {
                summary: `Wrote ${result.screens.length} screens and ${result.assets} assets to ${result.folder}`,
            };
        } catch (error) {
            if (error instanceof InstructError) {
                ctx.emit("result", { action, error: error.code, message: error.message });
            }
            throw error;
        }
    },
};
