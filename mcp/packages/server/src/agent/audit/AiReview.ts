import type { AuditFinding, AuditFindingDraft, AuditSeverity } from "./AuditFinding";
import type { DesignTree } from "./DesignTree";

/**
 * Optional Claude pass of the audit: visual hierarchy, alignment and consistency, judged from
 * screenshots.
 *
 * Builds the turn's prompt (boards to look at, findings already known) and turns Claude's JSON
 * answer into findings on nodes of the audited tree.
 */
export class AiReview {
    /** maximum number of findings taken from Claude */
    public static readonly MAX_FINDINGS = 12;

    private static readonly SEVERITIES = new Set<AuditSeverity>(["error", "warning", "info"]);

    constructor(private readonly tree: DesignTree) {}

    /**
     * User prompt of the review turn.
     *
     * @param known - findings of the deterministic checks, so Claude does not repeat them
     */
    public prompt(known: AuditFinding[]): string {
        const boards = this.tree.roots.map((root) => {
            const b = root.bounds();
            return `- "${root.name}" id ${root.id} (${Math.round(b.width)}×${Math.round(b.height)})`;
        });
        const already = known.slice(0, 40).map((f) => `- ${f.title}: ${f.nodeName} (${f.nodeId})`);
        return [
            "Review these boards for visual hierarchy, alignment and consistency problems:",
            ...boards,
            "",
            "Automatic checks already reported these; do not report them again:",
            ...(already.length > 0 ? already : ["- (none)"]),
            "",
            `Answer with a JSON array of at most ${AiReview.MAX_FINDINGS} findings in a \`\`\`json block, ` +
                'each {"nodeId", "severity": "error"|"warning"|"info", "title", "message", "suggestion"}. ' +
                "Answer [] if the design has no such problems.",
        ].join("\n");
    }

    /**
     * Parses Claude's answer into findings.
     *
     * Items need a title and message; unknown node ids fall back to the first board; severities
     * other than error/warning/info become info.
     *
     * @param answer - the text of Claude's answer
     */
    public parse(answer: string): AuditFindingDraft[] {
        const items = AiReview.jsonArray(answer);
        const fallback = this.tree.roots[0];
        const drafts: AuditFindingDraft[] = [];
        for (const item of items.slice(0, AiReview.MAX_FINDINGS)) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const raw = item as Record<string, unknown>;
            const title = AiReview.text(raw.title, 60);
            const message = AiReview.text(raw.message, 400);
            if (!title || !message) {
                continue;
            }
            const node = (typeof raw.nodeId === "string" && this.tree.get(raw.nodeId)) || fallback;
            if (!node) {
                continue;
            }
            const severity = AiReview.SEVERITIES.has(raw.severity as AuditSeverity)
                ? (raw.severity as AuditSeverity)
                : "info";
            drafts.push({
                check: "ai-review",
                severity,
                nodeId: node.id,
                nodeName: node.name,
                boardId: node.root.id,
                boardName: node.root.name,
                title,
                message,
                suggestion: AiReview.text(raw.suggestion, 300) || "Review this part of the design.",
                position: node.anchor(),
            });
        }
        return drafts;
    }

    private static jsonArray(answer: string): unknown[] {
        const fenced = [...answer.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
        const candidates = [...fenced.reverse(), answer.slice(answer.indexOf("["), answer.lastIndexOf("]") + 1)];
        for (const candidate of candidates) {
            try {
                const parsed = JSON.parse(candidate.trim());
                if (Array.isArray(parsed)) {
                    return parsed;
                }
            } catch {
                // try the next candidate
            }
        }
        return [];
    }

    private static text(value: unknown, max: number): string {
        if (typeof value !== "string") {
            return "";
        }
        const text = value.replace(/\s+/g, " ").trim();
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
    }
}
