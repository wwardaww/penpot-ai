import type { AuditCheck } from "./AuditCheck";
import type { AuditConfig } from "./AuditConfig";
import { SEVERITIES } from "./AuditFinding";
import type { AuditFinding, AuditFindingDraft } from "./AuditFinding";
import {
    ColorDuplicateCheck,
    ContrastCheck,
    DefaultNameCheck,
    DetachedInstanceCheck,
    SpacingCheck,
    TextOverflowCheck,
    TouchTargetCheck,
    TypeScaleCheck,
} from "./checks";
import type { DesignTree } from "./DesignTree";

/**
 * Runs the deterministic audit checks over a design tree and orders their findings.
 */
export class DesignAuditor {
    private readonly checks: AuditCheck[];

    /**
     * @param checks - the checks to run (default: all shipped checks)
     */
    constructor(checks?: AuditCheck[]) {
        this.checks = checks ?? [
            new ContrastCheck(),
            new TouchTargetCheck(),
            new TextOverflowCheck(),
            new DetachedInstanceCheck(),
            new SpacingCheck(),
            new TypeScaleCheck(),
            new ColorDuplicateCheck(),
            new DefaultNameCheck(),
        ];
    }

    /**
     * Audits a tree.
     *
     * @param tree - the audited nodes
     * @param config - thresholds and scales; disabled checks are skipped
     * @returns the findings, most severe first, then in board and paint order
     */
    public audit(tree: DesignTree, config: AuditConfig): AuditFinding[] {
        const drafts: AuditFindingDraft[] = [];
        for (const check of this.checks) {
            if (!config.disabledChecks.has(check.id)) {
                drafts.push(...check.run(tree, config));
            }
        }
        return DesignAuditor.finish(tree, drafts);
    }

    /**
     * Assigns ids to drafts and sorts them.
     *
     * @param tree - the tree the drafts refer to (for board and paint order)
     * @param drafts - the findings
     */
    public static finish(tree: DesignTree, drafts: AuditFindingDraft[]): AuditFinding[] {
        const rootIndex = new Map(tree.roots.map((root, index) => [root.id, index]));
        const order = (draft: AuditFindingDraft) => [
            SEVERITIES.indexOf(draft.severity),
            rootIndex.get(draft.boardId) ?? Number.MAX_SAFE_INTEGER,
            tree.get(draft.nodeId)?.paintIndex ?? Number.MAX_SAFE_INTEGER,
        ];
        const sorted = [...drafts].sort((a, b) => {
            const oa = order(a);
            const ob = order(b);
            return oa[0] - ob[0] || oa[1] - ob[1] || oa[2] - ob[2];
        });
        const taken = new Set<string>();
        return sorted.map((draft) => {
            const base = `${draft.check}:${draft.nodeId}`;
            let id = base;
            for (let n = 2; taken.has(id); n++) {
                id = `${base}:${n}`;
            }
            taken.add(id);
            return { id, ...draft };
        });
    }
}
