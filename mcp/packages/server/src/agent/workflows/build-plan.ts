import { BuildError } from "../build/BuildError";
import type { Workflow } from "@penpot/mcp-common";
import { type BuildPlanParams, BuildPlanner } from "../build/BuildPlanner";

/**
 * First step of the Build button: reads the design, plans the app (stack, screens, routes) and
 * emits a `plan` event in the persona's language. The client confirms by running `build-run`
 * with the `planId`. See `wiki/architecture.md` §7 (build pipeline).
 */
export const workflow: Workflow<BuildPlanParams> = {
    name: "build-plan",
    description: "Plans how to build the app from the design (stack, screens, routes).",
    run: (ctx, params) => BuildError.report(ctx, () => new BuildPlanner(ctx).plan(params ?? {})),
};
