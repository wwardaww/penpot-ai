import type { Workflow } from "@penpot/mcp-common";
import { VisualQaFlow, type VisualQaParams } from "../qa/VisualQaFlow";

/**
 * Visual QA (W18): screenshots of the running app compared with the design boards, scored with a
 * pixel difference and SSIM; in `fix` mode Claude changes the app's code until each screen matches
 * closely. See `wiki/architecture.md` §7 (`visual-qa`).
 */
export const workflow: Workflow<VisualQaParams> = {
    name: "visual-qa",
    description: "Compares the running app with the design boards and fixes the code until they match.",
    run: (ctx, params) => new VisualQaFlow(ctx).run(params ?? {}),
};
