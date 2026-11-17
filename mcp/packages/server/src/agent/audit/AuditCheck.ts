import type { AuditConfig } from "./AuditConfig";
import type { AuditCheckId, AuditFindingDraft, AuditSeverity } from "./AuditFinding";
import type { DesignTree, PaintSnapshot, TreeNode } from "./DesignTree";
import { Rgb } from "./Rgb";

/** Solid paint: a flat color with its opacity. */
export interface SolidPaint {
    rgb: Rgb;
    opacity: number;
}

/** Texts and severity of a finding about one node. */
export interface FindingFields {
    severity: AuditSeverity;
    title: string;
    message: string;
    suggestion: string;
    relatedNodeIds?: string[];
    data?: Record<string, unknown>;
}

/**
 * Deterministic audit check: inspects a {@link DesignTree} and reports findings, without Claude.
 */
export abstract class AuditCheck {
    /** id of the check, also the `check` of its findings */
    public abstract readonly id: AuditCheckId;

    /**
     * Runs the check.
     *
     * @param tree - the audited nodes
     * @param config - thresholds and scales
     */
    public abstract run(tree: DesignTree, config: AuditConfig): AuditFindingDraft[];

    /**
     * Creates a finding about a node, anchored at the node.
     *
     * @param node - the node
     * @param fields - severity and texts
     */
    protected finding(node: TreeNode, fields: FindingFields): AuditFindingDraft {
        return {
            check: this.id,
            nodeId: node.id,
            nodeName: node.name,
            boardId: node.root.id,
            boardName: node.root.name,
            position: node.anchor(),
            ...fields,
        };
    }

    /**
     * Top paint of a fill/stroke list when it is a flat color.
     *
     * @param paints - the paints of a snapshot
     * @returns the paint, or null when there is none, or it is a gradient or image ("unknown")
     */
    public static solid(paints: PaintSnapshot[] | "mixed" | undefined | null): SolidPaint | null {
        if (!Array.isArray(paints) || paints.length === 0) {
            return null;
        }
        const top = paints[0];
        if (top.gradient || top.image) {
            return null;
        }
        const rgb = Rgb.parse(top.color);
        if (!rgb) {
            return null;
        }
        return { rgb, opacity: typeof top.opacity === "number" ? top.opacity : 1 };
    }

    /**
     * Number from a snapshot value that may be a numeric string.
     *
     * @param value - the value
     */
    public static number(value: unknown): number | null {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
            return Number(value);
        }
        return null;
    }

    /**
     * Short quoted label of a node for messages: the text of a text layer, else its name.
     *
     * @param node - the node
     */
    public static label(node: TreeNode): string {
        const raw = (node.snapshot.text?.content ?? "").replace(/\s+/g, " ").trim() || node.name;
        return `"${raw.length > 30 ? raw.slice(0, 29) + "…" : raw}"`;
    }
}
