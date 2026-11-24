import type { WorkflowContext, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { DesignGaps, type DesignGap, type RedesignDecision } from "./DesignGaps";
import { RedesignBranch, type RedesignRecord } from "./RedesignBranch";
import { RedesignScreens } from "./RedesignScreens";

/** What happened to an item in a run. */
export interface RedesignItemResult {
    key: string;
    name: string;
    kind: DesignGap["kind"];
    /** built, left out by the user's choice, or wanted and not done */
    outcome: "added" | "left-out" | "not-done";
    /** why it was not done, or what is missing */
    note?: string;
}

/** What Claude reports about an item. */
interface ItemReport {
    status: string;
    files: string[];
    note: string;
}

/**
 * The user's decisions about what the design has and the app does not (W35): reads and stores them
 * in `redesign.json`, words them for the run and says what came of each.
 */
export class RedesignDecisions {
    private static readonly MAX = 200;

    /**
     * @param decisions - decisions of one Penpot file
     */
    private constructor(public readonly decisions: RedesignDecision[]) {}

    /**
     * Reads the decisions of a Penpot file; none for records written before W35.
     *
     * @param workspace - the project workspace
     * @param root - the linked folder
     * @param fileId - the Penpot file
     */
    public static async read(
        workspace: WorkflowWorkspaceApi,
        root: string,
        fileId: string
    ): Promise<RedesignDecisions> {
        const record = await workspace
            .readJson<Partial<RedesignRecord> | null>(RedesignBranch.RECORD_FILE, null)
            .catch(() => null);
        const stored = record?.root === root && Array.isArray(record.decisions) ? record.decisions : [];
        return new RedesignDecisions(
            stored
                .filter((decision) => DesignGaps.isGap(decision) && typeof decision.build === "boolean")
                .filter((decision) => decision.fileId === fileId)
                .map((decision) => ({
                    ...decision,
                    files: Array.isArray(decision.files)
                        ? decision.files.filter((file) => typeof file === "string")
                        : [],
                }))
        );
    }

    /**
     * Applies the choices of the confirm card to the earlier decisions. Items of the plan without a
     * choice stay undecided (they are asked again) and are not built.
     *
     * @param ctx - the workflow context
     * @param planned - items of the plan
     * @param choices - `[{key, build}]` of the client
     */
    public decide(ctx: WorkflowContext, planned: DesignGap[], choices: unknown): RedesignDecisions {
        const wanted = new Map<string, boolean>();
        for (const choice of Array.isArray(choices) ? choices : []) {
            if (typeof choice?.key === "string" && typeof choice.build === "boolean") {
                wanted.set(choice.key, choice.build);
            }
        }
        const known = new Map(this.decisions.map((decision) => [decision.key, decision]));
        const next = new Map<string, RedesignDecision>();
        for (const decision of this.decisions) {
            next.set(decision.key, { ...decision, build: wanted.get(decision.key) ?? decision.build });
        }
        for (const item of planned) {
            const build = wanted.get(item.key) ?? known.get(item.key)?.build;
            if (build !== undefined) {
                next.set(item.key, {
                    ...item,
                    fileId: ctx.context.fileId,
                    build,
                    files: known.get(item.key)?.files ?? [],
                    decidedAt: wanted.has(item.key) ? new Date().toISOString() : known.get(item.key)!.decidedAt,
                });
            }
        }
        return new RedesignDecisions([...next.values()]);
    }

    /**
     * Stores the decisions in `redesign.json`; those of other Penpot files stay.
     *
     * @param workspace - the project workspace
     * @param fileId - the Penpot file
     */
    public async store(workspace: WorkflowWorkspaceApi, fileId: string): Promise<void> {
        const record = await workspace.readJson<RedesignRecord | null>(RedesignBranch.RECORD_FILE, null);
        if (record === null) {
            return;
        }
        const others = (Array.isArray(record.decisions) ? record.decisions : []).filter(
            (decision) => decision.fileId !== fileId
        );
        await workspace.writeJson(RedesignBranch.RECORD_FILE, {
            ...record,
            decisions: [...this.decisions, ...others].slice(0, RedesignDecisions.MAX),
        } satisfies RedesignRecord);
    }

    /** Files the checked items own: features freely, components without logic. */
    public allowedFiles(): { feature: string[]; component: string[] } {
        const files = (kind: DesignGap["kind"]) =>
            this.decisions
                .filter((decision) => decision.build && decision.kind === kind)
                .flatMap((decision) => decision.files);
        return { feature: files("feature"), component: files("component") };
    }

    /** Prompt lines of the run. */
    public promptLines(): string[] {
        const line = (decision: RedesignDecision) =>
            `- \`${decision.key}\` (${decision.kind}) ${decision.name}${decision.screens.length > 0 ? ` on ${decision.screens.join(", ")}` : ""}: ${decision.what}`;
        const build = this.decisions.filter((decision) => decision.build);
        const leave = this.decisions.filter((decision) => !decision.build);
        const lines = ["The user decided what the design may add to the app."];
        lines.push(
            "",
            "Build these (they count as asked for; a `component` gets UI state only):",
            ...(build.length > 0 ? build.map(line) : ["- nothing"])
        );
        if (leave.length > 0) {
            lines.push(
                "",
                "Leave these out; they must not appear in the app (take out what an earlier Re-Design added):",
                ...leave.map(line)
            );
        }
        lines.push("", "Anything else the app does not have stays out; list it under `unmatched`.");
        return lines;
    }

    /**
     * Reads what Claude reports about the items and keeps the files of each built one.
     *
     * @param text - Claude's answer
     * @param changed - files the branch changed since its base
     * @returns the outcome per item
     */
    public report(text: string, changed: ReadonlySet<string>): RedesignItemResult[] {
        const reports = RedesignDecisions.reports(text);
        return this.decisions.map((decision) => {
            const { key, name, kind } = decision;
            if (!decision.build) {
                decision.files = [];
                return { key, name, kind, outcome: "left-out" };
            }
            const report = reports.get(key);
            decision.files = [...new Set([...(report?.files ?? []), ...decision.files])].filter((file) =>
                changed.has(file)
            );
            if (decision.files.length === 0) {
                const note = report?.note || "No change was made for it.";
                return { key, name, kind, outcome: "not-done", note };
            }
            // an item built by an earlier run needs no new report
            return report === undefined || report.status === "done"
                ? { key, name, kind, outcome: "added" }
                : { key, name, kind, outcome: "not-done", note: report.note || "Only a part of it was built." };
        });
    }

    private static reports(text: string): Map<string, ItemReport> {
        const json = RedesignScreens.lastJson(text) as { items?: unknown } | null;
        const reports = new Map<string, ItemReport>();
        for (const entry of Array.isArray(json?.items) ? json!.items : []) {
            const item = entry as { key?: unknown; status?: unknown; files?: unknown; note?: unknown } | null;
            if (typeof item?.key !== "string") {
                continue;
            }
            reports.set(item.key, {
                status: typeof item.status === "string" ? item.status : "",
                files: (Array.isArray(item.files) ? item.files : [])
                    .filter((file): file is string => typeof file === "string")
                    .map((file) => file.split("\\").join("/").replace(/^\.\//, ""))
                    .slice(0, 100),
                note: typeof item.note === "string" ? item.note.trim().slice(0, 300) : "",
            });
        }
        return reports;
    }
}
