import { z } from "zod";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";

/** Stable codes of findings (clients translate them). */
export const FINDING_CODES = [
    "route-missing",
    "route-extra",
    "start-screen",
    "link-missing",
    "back-missing",
    "overlay-missing",
    "url-missing",
    "hardcoded-color",
    "off-system-color",
    "hardcoded-size",
    "hardcoded-font",
    "component-missing",
    "component-unused",
    "animation-missing",
    "motion-not-loaded",
    "motion-library-missing",
] as const;

/** Checks of a report. */
export const CHECKS = ["flows", "values", "components", "animations"] as const;

export type CheckName = (typeof CHECKS)[number];

/** Something in the app that does not follow the design. */
export const FindingSchema = z.object({
    /** stable between builds while the same thing is wrong */
    id: z.string(),
    code: z.enum(FINDING_CODES),
    check: z.enum(CHECKS),
    /** screen it belongs to, null for the whole app */
    boardId: z.string().nullable(),
    screen: z.string().nullable(),
    /** file in the app folder, with the line */
    file: z.string().nullable(),
    line: z.number().nullable(),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    /** English text for developers and the fix turn */
    text: z.string(),
});

export type Finding = z.infer<typeof FindingSchema>;

/** State of one check. */
export const CheckStateSchema = z.object({
    state: z.enum(["ok", "findings", "skipped"]),
    /** why it was skipped */
    reason: z.string().nullable(),
    /** how many things were checked */
    checked: z.number(),
});

export type CheckState = z.infer<typeof CheckStateSchema>;

/** Conformance report of the last build (`.penforge/conformance.json`). */
export const ConformanceReportSchema = z.object({
    schemaVersion: z.literal(1),
    at: z.string(),
    fileId: z.string(),
    /** number of the build (W34), null when it was not recorded */
    build: z.number().nullable(),
    mode: z.enum(["full", "incremental", "tokens"]),
    status: z.enum(["clean", "findings", "unchecked"]),
    checks: z.record(z.enum(CHECKS), CheckStateSchema),
    /** everything that does not follow the design, the touched screens first */
    findings: z.array(FindingSchema),
    /** findings cut from the list */
    more: z.number(),
    /** findings the AI fixed in this build */
    fixed: z.number(),
    attempts: z.number(),
    /** boards this build touched (empty: all) */
    touched: z.array(z.string()),
    /** finding ids that are new since, or gone with, this build */
    diff: z.object({ added: z.array(z.string()), resolved: z.array(z.string()) }),
});

export type ConformanceReport = z.infer<typeof ConformanceReportSchema>;

/** Part of the report in the `result` event of a build. */
export interface ConformanceSummary {
    status: ConformanceReport["status"];
    fixed: number;
    /** findings left in what this build touched */
    left: number;
    /** findings left in the rest of the app */
    elsewhere: number;
    items: { code: Finding["code"]; screen: string | null; params: Finding["params"]; text: string }[];
    skipped: { check: CheckName; reason: string }[];
}

/**
 * Store of the conformance report of a project.
 */
export class ConformanceReports {
    public static readonly FILE = "conformance.json";
    /** findings kept in the file at most */
    public static readonly MAX_FINDINGS = 300;
    /** items sent to the client */
    private static readonly MAX_ITEMS = 20;

    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /** Reads the last report; null when there is none (or it is not valid). */
    public async read(): Promise<ConformanceReport | null> {
        try {
            const parsed = ConformanceReportSchema.safeParse(
                await this.workspace.readJson<unknown>(ConformanceReports.FILE, null)
            );
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    }

    public write(report: ConformanceReport): Promise<void> {
        return this.workspace.writeJson(ConformanceReports.FILE, report);
    }

    /**
     * Makes the client's summary of a report.
     *
     * @param report - the report
     * @param inScope - tells whether a finding belongs to what the build touched
     */
    public static summary(report: ConformanceReport, inScope: (finding: Finding) => boolean): ConformanceSummary {
        const scoped = report.findings.filter(inScope);
        return {
            status: report.status,
            fixed: report.fixed,
            left: scoped.length,
            elsewhere: report.findings.length - scoped.length + report.more,
            items: scoped
                .slice(0, ConformanceReports.MAX_ITEMS)
                .map(({ code, screen, params, text }) => ({ code, screen, params, text })),
            skipped: CHECKS.filter((check) => report.checks[check].state === "skipped").map((check) => ({
                check,
                reason: report.checks[check].reason ?? "",
            })),
        };
    }
}
