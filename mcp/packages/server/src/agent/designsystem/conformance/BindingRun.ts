import type { WorkflowContext } from "@penpot/mcp-common";
import { DesignSystemRun } from "../DesignSystemRun";

/** Steps of the W30 workflows (`progress {step, params?, text}`). */
export type BindingStep =
    | "link"
    | "source-map"
    | "design-md"
    | "checkpoint"
    | "catalog"
    | "scan"
    | "fix"
    | "restyle"
    | "recheck"
    | "prepare"
    | "open-tab"
    | "wait"
    | "build"
    | "swap";

/** Codes of `log` events. */
export type BindingLogCode =
    | "own-tokens-inactive"
    | "link-warnings"
    | "checkpoint-failed"
    | "design-md-skipped"
    | "fix-failed"
    | "restyle-failed"
    | "source-map-applied";

/** Codes of the `failed` event. */
export type BindingFailureCode =
    | "bad-params"
    | "not-linked"
    | "not-allowed"
    | "link-failed"
    | "no-items"
    | "task-missing"
    | "wrong-file"
    | "timeout"
    | "library-not-updated"
    | "penpot-refused"
    | "penpot-answer"
    | "cancelled"
    | "internal";

/** Failure a client can explain: code + params, English message. */
export class BindingFailure extends Error {
    constructor(
        public readonly code: BindingFailureCode,
        message: string,
        public readonly params: Record<string, unknown> = {}
    ) {
        super(message);
    }
}

/** Events of one W30 workflow run (W13 contract: codes + params + English text). */
export class BindingRun {
    constructor(private readonly ctx: WorkflowContext) {}

    public progress(step: BindingStep, text: string, params?: Record<string, unknown>): void {
        this.ctx.emit("progress", params ? { step, params, text } : { step, text });
    }

    public log(code: BindingLogCode, text: string, params?: Record<string, unknown>): void {
        this.ctx.emit("log", params ? { code, params, text } : { code, text });
    }

    public stopIfCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new BindingFailure("cancelled", "Cancelled");
        }
    }

    /** Runs the workflow body; known failures become a `failed` event before the run ends. */
    public async guard<T>(body: () => Promise<T>): Promise<T> {
        try {
            return await body();
        } catch (error) {
            const failure = BindingRun.failureOf(error, this.ctx.signal.aborted);
            if (failure) {
                this.ctx.emit("failed", { code: failure.code, params: failure.params, message: failure.message });
                throw failure;
            }
            throw error;
        }
    }

    private static failureOf(error: unknown, aborted: boolean): BindingFailure | null {
        if (error instanceof BindingFailure) {
            return error;
        }
        if (aborted) {
            return new BindingFailure("cancelled", "Cancelled");
        }
        const other = DesignSystemRun.failureOf(error);
        if (!other) {
            return null;
        }
        const known: Partial<Record<string, BindingFailureCode>> = {
            "penpot-refused": "penpot-refused",
            "penpot-answer": "penpot-answer",
            cancelled: "cancelled",
        };
        return new BindingFailure(known[other.code] ?? "internal", other.message, other.params);
    }
}
