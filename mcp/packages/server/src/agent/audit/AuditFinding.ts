/** Severity of an audit finding, most severe first. */
export type AuditSeverity = "error" | "warning" | "info";

/** Severities in display order. */
export const SEVERITIES: readonly AuditSeverity[] = ["error", "warning", "info"];

/** Id of the check that produced a finding. */
export type AuditCheckId =
    | "contrast"
    | "touch-target"
    | "spacing"
    | "color-duplicate"
    | "type-scale"
    | "default-name"
    | "detached-instance"
    | "text-overflow"
    | "ai-review";

/** Point in page coordinates. */
export interface AuditPoint {
    x: number;
    y: number;
}

/**
 * Problem found in a design by one audit check.
 *
 * `title`, `message` and `suggestion` are plain-language texts shown to designers (canvas
 * comments, results panel, report); `data` holds the measured values for developers and tests.
 */
export interface AuditFinding {
    /**
     * stable id: the same problem gets the same id in every audit run (`<check>:<nodeId>` or a
     * check-specific key such as `type-scale:<boardId>:<size>`; suffixed when taken in one run)
     */
    id: string;
    /** short hash of `id`, written into the canvas comment to recognize it in later audits */
    ref: string;
    check: AuditCheckId;
    /**
     * kind of message, for clients that translate the texts from `params` (`contrast`,
     * `touch-target`, `text-cut-off`, ...); `ai-review` findings have only free texts
     */
    code: string;
    /** values of the message, already formatted (labels, sizes, colors) */
    params: Record<string, string | number>;
    severity: AuditSeverity;
    nodeId: string;
    nodeName: string;
    /** top-level board holding the node */
    boardId: string;
    boardName: string;
    /** short label */
    title: string;
    message: string;
    suggestion: string;
    /** where the canvas comment goes */
    position: AuditPoint;
    /** other nodes with the same problem (aggregated findings) */
    relatedNodeIds?: string[];
    data?: Record<string, unknown>;
}

/** Finding before the auditor assigns its id and ref; `key` is the stable id to start from. */
export type AuditFindingDraft = Omit<AuditFinding, "id" | "ref"> & { key: string };
