import type { WorkflowContext } from "@penpot/mcp-common";
import { DesignMdFailure } from "../designmd";
import { IconImportError } from "../icons";

/** Steps the design system workflows report (`progress` `{step, params?, text}`). */
export type DesignSystemStep =
    | "checkpoint"
    | "design-md"
    | "draft"
    | "library"
    | "colors"
    | "typography"
    | "tokens"
    | "components"
    | "publish"
    | "download"
    | "license"
    | "icon-token"
    | "icons";

/** Codes of `log` events (`{code, params?, text}`). */
export type DesignSystemLogCode =
    | "checkpoint-failed"
    | "import-warnings"
    | "components-missing"
    | "stage-failed"
    | "icons-skipped"
    | "icons-truncated"
    | "tokens-from-library";

/** Codes of the `failed` event sent before a run ends with an error. */
export type DesignSystemFailureCode =
    | "missing-text"
    | "too-large"
    | "bad-source"
    | "has-errors"
    | "no-draft"
    | "penpot-refused"
    | "penpot-answer"
    | "stopped"
    | "bad-url"
    | "host-not-allowed"
    | "download-failed"
    | "bad-archive"
    | "no-icons"
    | "cancelled"
    | "internal";

/** Failure a client can explain: code + params, English message. */
export class DesignSystemFailure extends Error {
    constructor(
        public readonly code: DesignSystemFailureCode,
        message: string,
        public readonly params: Record<string, string | number> = {}
    ) {
        super(message);
    }
}

/**
 * Events of one design system workflow run, following the W13 contract: progress and logs carry
 * a stable code and params next to an English `text`; failures emit `failed {code, params,
 * message}` before the run ends.
 */
export class DesignSystemRun {
    constructor(private readonly ctx: WorkflowContext) {}

    /** Reports a step. */
    public progress(step: DesignSystemStep, text: string, params?: Record<string, string | number>): void {
        this.ctx.emit("progress", params ? { step, params, text } : { step, text });
    }

    /** Reports something the user should know that does not stop the run. */
    public log(code: DesignSystemLogCode, text: string, params?: Record<string, unknown>): void {
        this.ctx.emit("log", params ? { code, params, text } : { code, text });
    }

    /**
     * Runs a workflow body; known failures (own, DESIGN.md, icon import) become a `failed` event
     * before the run ends.
     */
    public async guard<T>(body: () => Promise<T>): Promise<T> {
        try {
            return await body();
        } catch (error) {
            const failure = DesignSystemRun.failureOf(error);
            if (failure) {
                this.ctx.emit("failed", { code: failure.code, params: failure.params, message: failure.message });
                throw failure;
            }
            throw error;
        }
    }

    /** Maps the errors of the reused modules to a {@link DesignSystemFailure}. */
    public static failureOf(error: unknown): DesignSystemFailure | null {
        if (error instanceof DesignSystemFailure) {
            return error;
        }
        if (error instanceof IconImportError) {
            const code: DesignSystemFailureCode = error.code === "too-large" ? "too-large" : error.code;
            return new DesignSystemFailure(code, error.message, error.params);
        }
        if (error instanceof DesignMdFailure) {
            const known: Partial<Record<string, DesignSystemFailureCode>> = {
                "has-errors": "has-errors",
                "no-draft": "no-draft",
                "too-large": "too-large",
                stopped: "stopped",
                "penpot-refused": "penpot-refused",
                "penpot-answer": "penpot-answer",
                "missing-prompt": "missing-text",
                "missing-content": "missing-text",
            };
            return new DesignSystemFailure(known[error.code] ?? "internal", error.message, error.params);
        }
        return null;
    }
}
