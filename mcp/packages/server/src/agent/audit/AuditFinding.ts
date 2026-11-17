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
    /** stable id inside one audit run (`<check>:<nodeId>`, suffixed when taken) */
    id: string;
    check: AuditCheckId;
    severity: AuditSeverity;
    nodeId: string;
    nodeName: string;
    /** top-level board holding the node */
    boardId: string;
    boardName: string;
    /** short label, also the comment prefix used for de-duplication */
    title: string;
    message: string;
    suggestion: string;
    /** where the canvas comment goes */
    position: AuditPoint;
    /** other nodes with the same problem (aggregated findings) */
    relatedNodeIds?: string[];
    data?: Record<string, unknown>;
}

/** Finding before the auditor assigns its id. */
export type AuditFindingDraft = Omit<AuditFinding, "id">;
