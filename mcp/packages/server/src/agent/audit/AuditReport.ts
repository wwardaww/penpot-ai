import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { SEVERITIES } from "./AuditFinding";
import type { AuditFinding, AuditSeverity } from "./AuditFinding";

/** What an audit looked at. */
export interface AuditScope {
    fileName: string;
    pageId: string;
    pageName: string;
    platform: string;
    boards: string[];
    nodeCount: number;
    aiReview: boolean;
}

/** Where a report was written. */
export interface WrittenReport {
    /** path relative to the project folder */
    path: string;
    commit: string | null;
}

/**
 * Markdown audit report in the project's design repository (`design/audits/<date>.md`).
 *
 * Audits of the same day go into the same file, one section each.
 */
export class AuditReport {
    private static readonly HEADINGS: Record<AuditSeverity, string> = {
        error: "Errors",
        warning: "Warnings",
        info: "Notes",
    };

    /**
     * @param scope - what was audited
     * @param findings - the findings, most severe first
     * @param date - when the audit ran
     */
    constructor(
        private readonly scope: AuditScope,
        private readonly findings: AuditFinding[],
        private readonly date: Date
    ) {}

    /** Report path relative to the project folder. */
    public path(): string {
        return `design/audits/${AuditReport.day(this.date)}.md`;
    }

    /** One-line count of findings by severity ("1 error, 2 warnings, 3 notes"). */
    public static counts(findings: AuditFinding[]): string {
        if (findings.length === 0) {
            return "no findings";
        }
        const names: Record<AuditSeverity, [string, string]> = {
            error: ["error", "errors"],
            warning: ["warning", "warnings"],
            info: ["note", "notes"],
        };
        return SEVERITIES.map((severity) => {
            const n = findings.filter((f) => f.severity === severity).length;
            return n === 0 ? null : `${n} ${names[severity][n === 1 ? 0 : 1]}`;
        })
            .filter((part) => part !== null)
            .join(", ");
    }

    /**
     * Renders this audit's section.
     *
     * @param withTitle - start with the file title (first audit of the day)
     */
    public render(withTitle: boolean): string {
        const s = this.scope;
        const lines: string[] = [];
        if (withTitle) {
            lines.push(`# Design audits — ${AuditReport.day(this.date)}`, "");
        }
        lines.push(
            `## ${AuditReport.time(this.date)} — ${s.pageName}`,
            "",
            `- File: ${s.fileName}`,
            `- Page: ${s.pageName} (\`${s.pageId}\`)`,
            `- Platform: ${s.platform}`,
            `- Boards: ${s.boards.length > 0 ? s.boards.join(", ") : "none"}`,
            `- Layers checked: ${s.nodeCount}`,
            `- AI review: ${s.aiReview ? "yes" : "no"}`,
            `- Result: ${AuditReport.counts(this.findings)}`,
            ""
        );
        for (const severity of SEVERITIES) {
            const group = this.findings.filter((f) => f.severity === severity);
            if (group.length === 0) {
                continue;
            }
            lines.push(`### ${AuditReport.HEADINGS[severity]}`, "");
            for (const f of group) {
                lines.push(
                    `- **${f.title}** — ${f.boardName} › ${f.nodeName} (\`${f.nodeId}\`, ${f.check})`,
                    `  ${f.message}`,
                    `  Suggested fix: ${f.suggestion}`
                );
            }
            lines.push("");
        }
        return lines.join("\n");
    }

    /**
     * Writes (or appends) the report and commits the design repository.
     *
     * @param workspace - the project folder
     * @param message - the commit message
     */
    public async write(workspace: WorkflowWorkspaceApi, message: string): Promise<WrittenReport> {
        const path = this.path();
        const file = workspace.resolve(path);
        await mkdir(dirname(file), { recursive: true });
        const existing = await readFile(file, "utf8").catch(() => null);
        if (existing === null) {
            await writeFile(file, this.render(true), "utf8");
        } else {
            await appendFile(file, (existing.endsWith("\n") ? "\n" : "\n\n") + this.render(false), "utf8");
        }
        const commit = await workspace.commitAll("design", message);
        return { path, commit };
    }

    private static day(date: Date): string {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    private static time(date: Date): string {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
}
