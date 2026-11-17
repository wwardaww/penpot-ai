import type { Workflow } from "@penpot/mcp-common";
import { Checkpoints } from "../checkpoints";

/**
 * Lists the project's checkpoints. Emits `result` `{checkpoints (newest first), undoTargetId}`.
 */
export const workflow: Workflow<Record<string, never>> = {
    name: "checkpoint-list",
    description: "List the checkpoints of the project.",
    run: async (ctx) => {
        const listing = await new Checkpoints(ctx).list();
        ctx.emit("result", listing);
        return { summary: `${listing.checkpoints.length} checkpoint(s)` };
    },
};
