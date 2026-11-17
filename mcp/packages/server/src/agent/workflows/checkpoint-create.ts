import type { Workflow, WorkflowResult } from "@penpot/mcp-common";
import { Checkpoints, type Checkpoint, type CheckpointCreateParams } from "../checkpoints";

/** Result of `checkpoint-create`; `checkpoint` is there for workflows that run it directly. */
export interface CheckpointCreateResult extends WorkflowResult {
    checkpoint: Checkpoint;
}

/**
 * Saves a checkpoint: a Penpot version of the open file plus a commit (and tag `penforge-cp-<n>`)
 * in `design/` and `app-src/`, recorded in `.penforge/checkpoints.json`.
 *
 * Emits `checkpoint` `{action: "created", checkpoint}` and `result` `{checkpoint}`. Other
 * workflows call it before an AI change, see `ensureCheckpoint` in `../checkpoints`.
 */
export const workflow: Workflow<CheckpointCreateParams> = {
    name: "checkpoint-create",
    description: "Save the design and the code so that a later AI change can be undone.",
    run: async (ctx, params): Promise<CheckpointCreateResult> => {
        const checkpoint = await new Checkpoints(ctx).create(params ?? {});
        ctx.emit("result", { checkpoint });
        const summary = checkpoint.fileVersion
            ? `Checkpoint #${checkpoint.n} saved`
            : `Checkpoint #${checkpoint.n} saved (code only)`;
        return { summary, checkpoint };
    },
};
