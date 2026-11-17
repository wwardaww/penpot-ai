import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import { AppBuilder, type BuildRunParams, type PreBuildRunner } from "../build/AppBuilder";

/**
 * Runner of `stack.json` `preBuild` workflows through the shipped workflow registry.
 */
class RegistryPreBuildRunner implements PreBuildRunner {
    public async run(workflowId: string, ctx: WorkflowContext): Promise<boolean> {
        // loaded lazily: the registry module imports this one
        const { WorkflowRegistry } = await import("./WorkflowRegistry");
        const workflow = WorkflowRegistry.withShippedWorkflows().get(workflowId);
        if (!workflow || workflow.name === "build-run" || workflow.name === "build-plan") {
            return false;
        }
        await workflow.run(ctx, {});
        return true;
    }
}

/**
 * Second step of the Build button: builds the confirmed plan into `app-src/` (full or
 * incremental), checks it, fixes errors, commits and emits `result`; the client then starts the
 * preview (W09). See `wiki/architecture.md` §7 (build pipeline).
 */
export const workflow: Workflow<BuildRunParams> = {
    name: "build-run",
    description: "Builds the app in app-src from the confirmed plan, then checks and commits it.",
    run: (ctx, params) => new AppBuilder(ctx, { preBuild: new RegistryPreBuildRunner() }).build(params ?? {}),
};
