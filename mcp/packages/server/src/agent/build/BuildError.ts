import type { WorkflowContext } from "@penpot/mcp-common";

/**
 * Failure of the build pipeline whose message is already worded for the user's persona.
 *
 * Workflows report it as a `failed` event (`{message}`) before the run ends, so clients can show
 * it as is; any other error stays technical and is shown to developers only.
 */
export class BuildError extends Error {
    constructor(message: string) {
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
                ctx.emit("failed", { message: error.message });
            }
            throw error;
        }
    }
}
