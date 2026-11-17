import type { WorkflowContext } from "@penpot/mcp-common";

/**
 * Failure of the build pipeline whose message is already worded for the user's persona.
 *
 * Workflows report it as a `failed` event (`{code, message}`) before the run ends. Clients
 * translate by `code` (`no-boards`, `plan-failed`, `stale-plan`, `busy`, `gave-up`); `message`
 * is the English fallback (for developers it holds the technical detail). Any other error stays
 * technical and is shown to developers only.
 */
export class BuildError extends Error {
    constructor(
        message: string,
        public readonly code: "no-boards" | "plan-failed" | "stale-plan" | "busy" | "gave-up"
    ) {
        super(message);
        this.name = "BuildError";
    }

    /**
     * Runs a build step and reports a {@link BuildError} as a `failed` event.
     *
     * @param ctx - the workflow context
     * @param step - the step to run
     */
    public static async report<T>(ctx: WorkflowContext, step: () => Promise<T>): Promise<T> {
        try {
            return await step();
        } catch (error) {
            if (error instanceof BuildError) {
                ctx.emit("failed", { code: error.code, message: error.message });
            }
            throw error;
        }
    }
}
