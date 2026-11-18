import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { WorkflowContext } from "@penpot/mcp-common";
import { ensureCheckpoint } from "../checkpoints";
import { QaConfig, type QaSettings, type QaSettingsPatch } from "./QaConfig";
import { QaFixer, type ScreenFix } from "./QaFixer";
import { QaRun, type QaScreenReport, VisualQaHost } from "./QaRun";
import { QaBudget, type QaLimit } from "./QaBudget";
import { QaGit } from "./QaGit";
import { QaError, type QaEnv, type QaShot, VisualQa } from "./VisualQa";

/** Params of the `visual-qa` workflow (see `wiki/architecture.md` §7). */
export interface VisualQaParams {
    /** `check` compares only; `fix` also lets Claude fix screens below the threshold */
    mode?: "check" | "fix" | "settings" | "accept";
    /** only these boards (default: every screen of the last build) */
    boardIds?: string[];
    /** fix rounds per screen for this run (default: settings) */
    maxIterations?: number;
    /** `build` = automatic run after a build; skipped unless `autoRunAfterBuild` is on */
    trigger?: "user" | "build";
    /** `settings` mode: the settings to change */
    settings?: QaSettingsPatch;
    /** `accept` mode: the run whose result the user accepts */
    runName?: string;
}

/** Result payload of a check or fix run (`result` event). */
export interface VisualQaResult {
    mode: "check" | "fix";
    runName: string;
    trigger: "user" | "build";
    threshold: number;
    settings: Pick<
        QaSettings,
        "threshold" | "maxIterations" | "autoRunAfterBuild" | "maxScreens" | "maxClaudeTurns" | "maxMinutes"
    >;
    score: number;
    passed: boolean;
    screens: QaScreenReport[];
    skippedScreens: { boardId: string; name: string; route: string | null; reason: string }[];
    commit: string | null;
    checkpoint: string | null;
    /** limit the run stopped at, if any */
    limit: QaLimit | null;
    /** Claude turns the run used */
    claudeTurns: number;
}

/**
 * The `visual-qa` workflow: compares the running app with the design boards and, in `fix` mode,
 * lets Claude change the app's code until each screen matches (or the rounds run out).
 */
export class VisualQaFlow {
    private static readonly RUN_NAME = /^\d{8}T\d{6}-[0-9a-f]{4}$/;

    constructor(
        private readonly ctx: WorkflowContext,
        /** pause between a fix and the next screenshot; replaceable in tests */
        private readonly wait?: (ms: number) => Promise<void>,
        /** clock of the run's time limit; replaceable in tests */
        private readonly now: () => number = Date.now
    ) {}

    public async run(params: VisualQaParams): Promise<{ summary: string }> {
        const mode = params.mode ?? "check";
        const config = new QaConfig(this.ctx.workspace);
        switch (mode) {
            case "settings": {
                const settings = await config.update(params.settings ?? {});
                this.ctx.emit("result", { mode, settings: VisualQaFlow.publicSettings(settings) });
                return { summary: "Settings saved" };
            }
            case "accept":
                return this.accept(params.runName);
            case "check":
            case "fix":
                break;
            default:
                throw new Error(`Unknown mode ${JSON.stringify(mode)}`);
        }
        const settings = await config.read();
        const trigger = params.trigger === "build" ? "build" : "user";
        if (trigger === "build" && !settings.autoRunAfterBuild) {
            this.ctx.emit("result", { mode, trigger, skipped: true, settings: VisualQaFlow.publicSettings(settings) });
            return { summary: "Skipped" };
        }
        try {
            return await this.check(mode, trigger, params, settings);
        } catch (error) {
            if (error instanceof QaError) {
                this.ctx.emit("failed", { code: error.code, message: error.message });
            }
            throw error;
        }
    }

    private async check(
        mode: "check" | "fix",
        trigger: "user" | "build",
        params: VisualQaParams,
        settings: QaSettings
    ): Promise<{ summary: string }> {
        const services = VisualQaHost.get();
        if (!services) {
            throw new QaError("The app preview is not available in this daemon.", "no-preview");
        }
        const { ctx } = this;
        const budget = new QaBudget(settings, this.now);
        const env: QaEnv = {
            workspace: ctx.workspace,
            // routed to the tab that started the run (its MCP session is in the context)
            tools: ctx.tools,
            fileId: ctx.context.fileId,
            signal: ctx.signal,
            progress: (step, stepParams, text) => ctx.emit("progress", { step, params: stepParams, text }),
        };
        const boardIds = Array.isArray(params.boardIds) ? params.boardIds.map(String) : [];
        const listed = await VisualQa.screens(env, boardIds);
        const skipped = [...listed.skipped];
        const screens = listed.screens.slice(0, settings.maxScreens);
        for (const screen of listed.screens.slice(settings.maxScreens)) {
            skipped.push({ boardId: screen.boardId, name: screen.name, route: screen.route, reason: "limit" });
            budget.screensCut();
        }
        if (screens.length === 0) {
            throw new QaError("None of the screens can be opened in the app.", "no-screens");
        }
        const git = new QaGit(ctx.workspace.appSrcDir);
        if (mode === "fix" && !(await this.confirmDirty(git))) {
            mode = "check";
        }
        const developer = ctx.context.persona === "developer";
        const run = await QaRun.start(env, services, settings);
        try {
            const first: QaShot[] = [];
            for (const screen of screens) {
                if (!budget.hasTime()) {
                    skipped.push({ boardId: screen.boardId, name: screen.name, route: screen.route, reason: "limit" });
                    continue;
                }
                first.push(await run.qa.check(screen, mode === "fix" ? "-before" : ""));
            }
            const fixes = new Map<string, ScreenFix>();
            let checkpoint: string | null = null;
            let commit: string | null = null;
            const failing = first.filter((shot) => !shot.passed).sort((a, b) => a.score - b.score);
            if (mode === "fix" && failing.length > 0) {
                env.progress("checkpoint", {}, "Saving a checkpoint");
                checkpoint =
                    (await ensureCheckpoint(ctx, "Before matching the app to the design", "visual-qa"))?.id ?? null;
                // changes the checkpoint could not save stay out of the QA commit
                const foreign = new Set(await git.dirtyFiles());
                const fixer = new QaFixer(ctx, run.qa, settings, budget, this.wait);
                const rounds = VisualQaFlow.rounds(params.maxIterations, settings);
                for (const shot of failing) {
                    if (!budget.hasTime()) {
                        break;
                    }
                    fixes.set(shot.screen.boardId, await fixer.fix(shot, rounds));
                }
                const improved = [...fixes.values()].filter((fix) => fix.changedFiles.length > 0);
                const files = [...new Set(improved.flatMap((fix) => fix.changedFiles))].filter((f) => !foreign.has(f));
                if (files.length > 0) {
                    env.progress("save", {}, "Saving the code");
                    const names = improved.map((fix) => fix.after.screen.name).join(", ");
                    commit = await git.commitFiles(files, `penforge(qa): match ${names} to the design`);
                }
            }
            const finals = first.map((shot) => fixes.get(shot.screen.boardId)?.after ?? shot);
            const reports: QaScreenReport[] = [];
            for (const shot of finals) {
                const fix = fixes.get(shot.screen.boardId);
                reports.push(
                    await run.screenReport(shot, {
                        images: true,
                        developer,
                        before: fix?.before,
                        attempts: fix?.attempts,
                        changedFiles: fix?.changedFiles,
                    })
                );
            }
            const result: VisualQaResult = {
                mode,
                runName: run.qa.runName,
                trigger,
                threshold: settings.threshold,
                settings: VisualQaFlow.publicSettings(settings),
                score: QaRun.averageScore(finals),
                passed: finals.every((shot) => shot.passed),
                screens: reports,
                skippedScreens: QaRun.skippedReport(skipped),
                commit,
                checkpoint,
                limit: budget.hit,
                claudeTurns: budget.turns,
            };
            await run.qa.writeReport({ ...QaRun.fileReport(result), createdAt: new Date().toISOString() });
            await VisualQa.prune(ctx.workspace);
            ctx.emit("result", result);
            const matching = finals.filter((shot) => shot.passed).length;
            const limit = budget.hit ? `; stopped at the limit of ${VisualQaFlow.LIMIT_TEXT[budget.hit]}` : "";
            return {
                summary: `${matching} of ${finals.length} screens match the design (score ${result.score})${limit}`,
            };
        } finally {
            await run.close();
        }
    }

    /**
     * Asks before fixing when `app-src/` has uncommitted changes (they stay out of the QA commit).
     *
     * @returns whether to fix
     */
    private async confirmDirty(git: QaGit): Promise<boolean> {
        const dirty = await git.dirtyFiles();
        if (dirty.length === 0) {
            return true;
        }
        const answer = await this.ctx.ask({
            text:
                `The app's code has ${dirty.length} changed file(s) that are not saved in git. ` +
                "Penforge saves them in a checkpoint first and leaves them out of its own commit. Fix anyway?",
            options: [
                { id: "fix", label: "Fix anyway" },
                { id: "check", label: "Only check" },
            ],
        });
        return answer === "fix";
    }

    private static readonly LIMIT_TEXT: Record<QaLimit, string> = {
        screens: "screens per check",
        turns: "AI fix turns per check",
        time: "time per check",
    };

    /** Marks a run's report as accepted by the user. */
    private async accept(runName: string | undefined): Promise<{ summary: string }> {
        if (typeof runName !== "string" || !VisualQaFlow.RUN_NAME.test(runName)) {
            throw new Error("accept needs the runName of a check");
        }
        const file = join(VisualQa.runDir(this.ctx.workspace, runName), "report.json");
        let report: Record<string, unknown>;
        try {
            report = JSON.parse(await readFile(file, "utf8"));
        } catch {
            throw new Error("No such check");
        }
        report.acceptedAt = new Date().toISOString();
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        this.ctx.emit("result", { mode: "accept", runName, acceptedAt: report.acceptedAt });
        return { summary: "Accepted" };
    }

    private static rounds(requested: unknown, settings: QaSettings): number {
        const value = typeof requested === "number" && Number.isFinite(requested) ? Math.round(requested) : NaN;
        return Number.isNaN(value) ? settings.maxIterations : Math.min(10, Math.max(1, value));
    }

    private static publicSettings(settings: QaSettings): VisualQaResult["settings"] {
        return {
            threshold: settings.threshold,
            maxIterations: settings.maxIterations,
            autoRunAfterBuild: settings.autoRunAfterBuild,
            maxScreens: settings.maxScreens,
            maxClaudeTurns: settings.maxClaudeTurns,
            maxMinutes: settings.maxMinutes,
        };
    }
}
