import type { Workflow } from "@penpot/mcp-common";
import { Checkpoints, type CheckpointRestoreParams } from "../checkpoints";

/**
 * Goes back to a checkpoint (`{id}`, or `{last: true}` for "Undo last AI change"): saves the
 * current state as a new checkpoint, restores the Penpot version and resets `design/` and
 * `app-src/` (`git reset --hard`). Asks the user first unless `confirmed` is true.
 *
 * Emits `checkpoint` `{action: "restored", checkpoint, safety, design}` and `result` with the same
 * fields, or `result` `{cancelled: true}` when the user said no. A running preview dev server
 * picks up the changed files itself.
 */
export const workflow: Workflow<CheckpointRestoreParams> = {
    name: "checkpoint-restore",
    description: "Bring the design and the code back to a checkpoint.",
    run: async (ctx, params) => {
        const result = await new Checkpoints(ctx).restore(params ?? {});
        if (!result) {
            ctx.emit("result", { cancelled: true });
            return { summary: "Kept the current design and code" };
        }
        ctx.emit("result", result);
        return { summary: Checkpoints.restoreSummary(result) };
    },
};
