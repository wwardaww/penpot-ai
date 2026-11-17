import type { WorkflowContext } from "@penpot/mcp-common";

/** Codes of the steps a DESIGN.md workflow reports (`progress` event `{code, summary}`). */
export type DesignMdProgressCode =
    "checkpoint" | "import-library" | "build-components" | "read-file" | "write-notes" | "draft";

/** Codes of the reasons a DESIGN.md workflow stops (`failure` event `{code, params}`). */
export type DesignMdFailureCode =
    | "no-file"
    | "has-errors"
    | "stopped"
    | "no-draft"
    | "too-large"
    | "missing-content"
    | "missing-prompt"
    | "penpot-refused"
    | "penpot-answer";

/**
 * Failure of a DESIGN.md workflow that the panel can explain in the user's language: it carries
 * a code and parameters besides the English message the chat shows.
 */
export class DesignMdFailure extends Error {
    constructor(
        public readonly code: DesignMdFailureCode,
        message: string,
        public readonly params: Record<string, string | number> = {}
    ) {
        super(message);
    }
}

/**
 * One run of a DESIGN.md workflow as seen by the panel: progress and failures as codes (the
 * frontend translates them), with English text for the chat and logs.
 */
export class DesignMdRun {
    /** option ids of the question asked when the checkpoint cannot be saved */
    public static readonly APPLY_WITHOUT_CHECKPOINT = "apply-without-checkpoint";
    public static readonly STOP = "stop";

    /**
     * @param ctx - the workflow context
     */
    constructor(private readonly ctx: WorkflowContext) {}

    /**
     * Runs a workflow body; a {@link DesignMdFailure} is reported as a `failure` event before it
     * ends the run.
     */
    public async guard<T>(body: () => Promise<T>): Promise<T> {
        try {
            return await body();
        } catch (error) {
            if (error instanceof DesignMdFailure) {
                this.ctx.emit("failure", { code: error.code, params: error.params });
            }
            throw error;
        }
    }

    /** Reports a step. */
    public progress(code: DesignMdProgressCode, summary: string): void {
        this.ctx.emit("progress", { code, summary });
    }
}
