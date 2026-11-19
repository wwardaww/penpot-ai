import type { WorkflowContext } from "@penpot/mcp-common";
import { DesignSystemRun } from "../DesignSystemRun";

/** Steps `design-system-extract` reports (`progress {step, params?, text}`). */
export type ExtractStep =
    | "inventory"
    | "checkpoint"
    | "tokens"
    | "colors"
    | "typography"
    | "components"
    | "icons"
    | "pages"
    | "screens"
    | "design-md"
    | "source-map"
    | "publish";

/** Codes of `log` events. */
export type ExtractLogCode =
    | "checkpoint-failed"
    | "stage-failed"
    | "stage-warnings"
    | "inventory-truncated"
    | "icons-skipped"
    | "tokens-from-library";

/** Codes of the `failed` event. */
export type ExtractFailureCode =
    "bad-mode" | "not-a-copy" | "plan-changed" | "penpot-refused" | "penpot-answer" | "cancelled" | "internal";

/** Failure a client can explain: code + params, English message. */
export class ExtractFailure extends Error {
    constructor(
        public readonly code: ExtractFailureCode,
        message: string,
        public readonly params: Record<string, unknown> = {}
    ) {
        super(message);
    }
}

/**
 * Events of one `design-system-extract` run (W13 contract): progress and logs carry a stable
 * code and params next to an English `text`; failures emit `failed {code, params, message}`
 * before the run ends.
 */
export class ExtractRun {
    constructor(private readonly ctx: WorkflowContext) {}

    /** Reports a step. */
    public progress(step: ExtractStep, text: string, params?: Record<string, unknown>): void {
        this.ctx.emit("progress", params ? { step, params, text } : { step, text });
    }

    /** Reports something that does not stop the run. */
    public log(code: ExtractLogCode, text: string, params?: Record<string, unknown>): void {
        this.ctx.emit("log", params ? { code, params, text } : { code, text });
    }

    /** Stops the run when it was cancelled. */
    public stopIfCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new ExtractFailure("cancelled", "Cancelled");
        }
    }

    /** Runs the workflow body; known failures become a `failed` event before the run ends. */
    public async guard<T>(body: () => Promise<T>): Promise<T> {
        try {
            return await body();
        } catch (error) {
            const failure = ExtractRun.failureOf(error);
            if (failure) {
                this.ctx.emit("failed", { code: failure.code, params: failure.params, message: failure.message });
                throw failure;
            }
            throw error;
        }
    }

    private static failureOf(error: unknown): ExtractFailure | null {
        if (error instanceof ExtractFailure) {
            return error;
        }
        const other = DesignSystemRun.failureOf(error);
        if (!other) {
            return null;
        }
        const known: Partial<Record<string, ExtractFailureCode>> = {
            "penpot-refused": "penpot-refused",
            "penpot-answer": "penpot-answer",
            cancelled: "cancelled",
        };
        return new ExtractFailure(known[other.code] ?? "internal", other.message, other.params);
    }
}
