import type { Workflow } from "@penpot/mcp-common";
import { Checkpoints } from "../checkpoints";

/** Params of `checkpoint-diff`. */
export interface CheckpointDiffParams {
    id: string;
}

/**
 * Compares the code with a checkpoint (developer persona). Emits `result`
 * `{checkpoint, design: RepoDiff, appSrc: RepoDiff}` (`RepoDiff = {stat, patch, truncated,
 * untracked}`; diff of the working tree against the checkpoint commit).
 */
export const workflow: Workflow<CheckpointDiffParams> = {
    name: "checkpoint-diff",
    description: "Show what changed in the code since a checkpoint.",
    run: async (ctx, params) => {
        const diff = await new Checkpoints(ctx).diff(params?.id);
        ctx.emit("result", diff);
        return { summary: `Changes since checkpoint #${diff.checkpoint.n}` };
    },
};
