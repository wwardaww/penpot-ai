import type { WorkflowContext } from "@penpot/mcp-common";

/**
 * Known failure codes of `token-sync`; the client translates them.
 *
 * - `penpot-unreachable`: the tokens could not be read (no plugin connected, script failed)
 * - `broken-block`: the theme file has a begin marker without an end marker (or the reverse)
 * - `unsafe-theme-path`: `stack.json` `themeFile` points outside `app-src/`, or the theme file is a link
 * - `theme-check-failed`: the app did not type-check with the new tokens; the theme was put back
 */
export type TokenSyncErrorCode = "penpot-unreachable" | "broken-block" | "unsafe-theme-path" | "theme-check-failed";

/**
 * Known failure of a token sync, reported to the client as a `failed` event `{code, message}`
 * before the run ends with `workflow.done ok:false`.
 */
export class TokenSyncError extends Error {
    constructor(
        public readonly code: TokenSyncErrorCode,
        message: string
    ) {
        super(message);
        this.name = "TokenSyncError";
    }

    /**
     * Runs a sync and reports a known failure as a `failed` event, then rethrows it.
     *
     * @param ctx - the workflow context
     * @param run - the sync
     */
    public static async report<T>(ctx: WorkflowContext, run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error) {
            if (error instanceof TokenSyncError) {
                ctx.emit("failed", { code: error.code, message: error.message });
            }
            throw error;
        }
    }
}
