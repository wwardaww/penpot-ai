import type { WorkflowContext } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { AppFolders } from "../apps/AppFolders";
import { ReadOnlyGit } from "../apps/ReadOnlyGit";
import { ensureCheckpoint } from "../checkpoints/Checkpoints";
import { LinkedProjectPrompt } from "./LinkedProjectPrompt";
import { LinkedToolFilter } from "./LinkedToolFilter";
import { LinkedWorkspace } from "./LinkedWorkspace";
import { LookGuard, type OutsideLookChange } from "./LookGuard";
import { type RedesignGitPlan, RedesignBranch, type RedesignRecord } from "./RedesignBranch";
import { LinkedGit } from "./LinkedGit";
import { RedesignScreens, type ScreenBoard } from "./RedesignScreens";

/** Params of the `code-redesign` workflow. */
export interface CodeRedesignParams {
    /** `plan` (default) tells what a run would do; `run` applies the look; `revert` takes files back */
    action?: "plan" | "run" | "revert";
    /** what the user asked for in the chat (may name a feature, which the guard then accepts) */
    instructions?: string;
    /** files to revert (`revert`), from the last run's `outsideLook` list */
    files?: string[];
}

/** Status of one screen after a run. */
export interface RedesignScreenStatus {
    name: string;
    status: "done" | "partial" | "skipped";
    note?: string;
}

/** `result` of a `run`. */
export interface CodeRedesignRunResult {
    action: "run";
    branch: string | null;
    baseBranch: string | null;
    baseCommit: string | null;
    commit: string | null;
    filesChanged: string[];
    screens: RedesignScreenStatus[];
    unmatched: string[];
    outsideLook: OutsideLookChange[];
    cancelled?: true;
}

/** Errors of the Re-Design workflows (`code` for the client, English message). */
export class RedesignError extends Error {
    constructor(
        public readonly code: "not-linked" | "wrong-type" | "no-screens" | "no-branch" | "bad-files",
        message: string
    ) {
        super(message);
        this.name = "RedesignError";
    }
}

/**
 * Re-Design of an Existing project (W38 workflow `code-redesign`): on the Penforge branch, Claude
 * changes the app so each screen matches its Penpot board, look only; then the diff is checked
 * ({@link LookGuard}) and the summary lists files changed outside the look, which the user can
 * revert.
 */
export class CodeRedesign {
    private readonly logger = createLogger("CodeRedesign");

    constructor(private readonly ctx: WorkflowContext) {}

    /** Tells what a run would do: git state, branch, screens. */
    public async plan(): Promise<RedesignGitPlan & { action: "plan"; screens: ScreenBoard[] }> {
        const { root } = this.folder();
        const git = await new RedesignBranch(this.ctx, root, "existing").plan();
        return { action: "plan", ...git, screens: await new RedesignScreens(this.ctx).list() };
    }

    /** Applies the new look to the app's code. */
    public async run(params: CodeRedesignParams): Promise<CodeRedesignRunResult> {
        const { root } = this.folder();
        const screens = await new RedesignScreens(this.ctx).list();
        if (screens.length === 0) {
            throw new RedesignError("no-screens", "The file has no screen boards to apply");
        }
        this.progress("git", "Preparing the git branch");
        const prepared = await new RedesignBranch(this.ctx, root, "existing").prepare();
        if (prepared.state !== "ready") {
            return CodeRedesign.cancelled();
        }
        this.progress("checkpoint", "Saving a checkpoint");
        await ensureCheckpoint(this.ctx, "Before Re-Design", "code-redesign");
        const headBefore = (await prepared.git.state()).head ?? prepared.baseCommit;
        this.progress("edit", "Applying the new look to the code");
        const instructions = (params.instructions ?? "").trim().slice(0, 8000);
        const answer = await this.ctx.runner.run({
            prompt: CodeRedesign.prompt(root, prepared.branch, screens, instructions),
            promptName: "code-redesign",
            toolFilter: new LinkedToolFilter(this.ctx.workspace.root, [root, this.ctx.workspace.root], root, true),
        });
        this.checkCancelled();
        const report = CodeRedesign.parseReport(answer.text, screens);
        this.progress("commit", "Committing on the Penforge branch");
        const commit = await prepared.git.commit("penforge(redesign): apply the new look from Penpot");
        this.progress("guard", "Checking that only the look changed");
        const changed = await prepared.git.changedFiles(prepared.baseCommit);
        const files = await Promise.all(
            changed.map(async (file) => ({
                path: file.path,
                added: file.status === "D" ? [] : await prepared.git.addedLines(prepared.baseCommit, file.path),
            }))
        );
        const outsideLook = LookGuard.check(files, instructions.length > 0 ? report.featureFiles : []);
        if (commit !== null) {
            await this.recordApps(root, prepared.branch, headBefore);
        }
        return {
            action: "run",
            branch: prepared.branch,
            baseBranch: prepared.baseBranch,
            baseCommit: prepared.baseCommit,
            commit,
            filesChanged: changed.map((file) => file.path),
            screens: report.screens,
            unmatched: report.unmatched,
            outsideLook,
        };
    }

    /**
     * Takes files back to their state before the Re-Design (only files the branch changed).
     *
     * @param files - paths from the run's `outsideLook` list
     */
    public async revert(files: unknown): Promise<{ action: "revert"; reverted: string[]; commit: string | null }> {
        const { root } = this.folder();
        if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) {
            throw new RedesignError("bad-files", "Name the files to revert");
        }
        const record = await this.ctx.workspace.readJson<RedesignRecord | null>(RedesignBranch.RECORD_FILE, null);
        const git = new LinkedGit(root);
        const state = await git.state();
        if (!record || record.root !== root || state.branch !== record.branch) {
            throw new RedesignError("no-branch", "The folder is not on the Re-Design branch");
        }
        const changed = new Set((await git.changedFiles(record.baseCommit)).map((file) => file.path));
        const wanted = [...new Set(files as string[])];
        if (wanted.some((file) => !changed.has(file))) {
            throw new RedesignError("bad-files", "Only files the Re-Design changed can be reverted");
        }
        const commit = await git.revert(record.baseCommit, wanted);
        return { action: "revert", reverted: wanted, commit };
    }

    /**
     * Records the app folders this run changed in `redesign.json` (W39), so the dashboard lists the
     * app under the Penpot file's name without guessing. A failure only loses that hint.
     */
    private async recordApps(root: string, branch: string, headBefore: string): Promise<void> {
        try {
            const git = new ReadOnlyGit(root);
            const head = await git.branchHead(branch);
            if (head === null) {
                return;
            }
            const appDirs = await new AppFolders(root).fromChanges(await git.changedPaths(headBefore, head));
            await RedesignBranch.recordApps(
                this.ctx.workspace,
                { fileId: this.ctx.context.fileId, fileName: this.ctx.context.fileName },
                appDirs
            );
        } catch (error) {
            this.logger.warn(
                "Could not record the Re-Designed apps: %s",
                error instanceof Error ? error.message : error
            );
        }
    }

    private folder(): { root: string } {
        if (this.ctx.context.projectType !== "existing") {
            throw new RedesignError("wrong-type", "Re-Design of code is for Existing projects");
        }
        const folder = LinkedWorkspace.of(this.ctx);
        if (folder.state !== "linked") {
            throw new RedesignError("not-linked", "The project's folder is not linked on this computer");
        }
        return { root: folder.root };
    }

    private static prompt(root: string, branch: string, screens: ScreenBoard[], instructions: string): string {
        return [
            `Apply the new look from the Penpot design to the app in \`${root}\` (git branch \`${branch}\`).`,
            "",
            "Screens (Penpot boards; look at each with the Penpot tools before changing its code):",
            ...screens.map(
                (screen) => `- "${screen.name}" (boardId ${screen.boardId}, ${screen.width}×${screen.height})`
            ),
            "",
            LinkedProjectPrompt.LOOK_ONLY_RULE,
            "",
            instructions.length > 0
                ? `The user's instructions from the chat (they may ask for more than the look; do only what they ask):\n${instructions}`
                : "The user gave no further instructions: change the look only.",
        ].join("\n");
    }

    /** Reads the JSON report at the end of Claude's answer; missing screens count as skipped. */
    private static parseReport(
        text: string,
        screens: ScreenBoard[]
    ): { screens: RedesignScreenStatus[]; unmatched: string[]; featureFiles: string[] } {
        const json = RedesignScreens.lastJson(text) as {
            screens?: Array<{ name?: unknown; status?: unknown; note?: unknown }>;
            unmatched?: unknown;
            featureFiles?: unknown;
        } | null;
        const reported = new Map<string, RedesignScreenStatus>();
        for (const entry of Array.isArray(json?.screens) ? json!.screens : []) {
            if (typeof entry?.name !== "string") {
                continue;
            }
            const status = entry.status === "done" || entry.status === "partial" ? entry.status : "skipped";
            reported.set(entry.name, {
                name: entry.name,
                status,
                ...(typeof entry.note === "string" && entry.note.length > 0 ? { note: entry.note.slice(0, 300) } : {}),
            });
        }
        const strings = (value: unknown) =>
            Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
        return {
            screens: screens.map((screen) => reported.get(screen.name) ?? { name: screen.name, status: "skipped" }),
            unmatched: strings(json?.unmatched).map((item) => item.slice(0, 300)),
            featureFiles: strings(json?.featureFiles),
        };
    }

    private static cancelled(): CodeRedesignRunResult {
        return {
            action: "run",
            branch: null,
            baseBranch: null,
            baseCommit: null,
            commit: null,
            filesChanged: [],
            screens: [],
            unmatched: [],
            outsideLook: [],
            cancelled: true,
        };
    }

    private progress(step: "git" | "checkpoint" | "screens" | "edit" | "guard" | "commit", text: string): void {
        this.ctx.emit("progress", { step, text });
    }

    private checkCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }
}
