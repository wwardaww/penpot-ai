import type { LinkedProjectKind, WorkflowContext, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { LinkedGit } from "./LinkedGit";

/** App of a Re-Design (W39): a Penpot file and the app folder its run changed. */
export interface RedesignedAppEntry {
    /** the Penpot file, null when unknown (older records) */
    fileId: string | null;
    /** its name when the run happened */
    fileName: string | null;
    /** app folder relative to the linked folder, `/`-separated; `""` is the folder itself */
    appDir: string;
}

/** Content of `.penforge/redesign.json`: the branch of the last Re-Design. */
export interface RedesignRecord {
    kind: LinkedProjectKind;
    /** the linked folder the branch belongs to */
    root: string;
    branch: string;
    /** the user's branch the Re-Design branch started from (null when detached or new repository) */
    baseBranch: string | null;
    /** commit the look guard compares with */
    baseCommit: string;
    createdAt: string;
    updatedAt: string;
    /**
     * apps the runs on this branch changed, one per Penpot file and app folder (W39; absent in
     * records written before)
     */
    apps?: RedesignedAppEntry[];
}

/** A valid {@link RedesignRecord}, its `apps` checked (empty when absent). */
export type ReadRedesignRecord = Omit<RedesignRecord, "apps"> & { apps: RedesignedAppEntry[] };

/** Git plan of a Re-Design, for the confirm card. */
export interface RedesignGitPlan {
    git: boolean;
    dirty: boolean;
    currentBranch: string | null;
    /** branch the run will use (continued or new); null without git */
    branch: string | null;
    continuing: boolean;
}

/** Outcome of the git preparation. */
export type RedesignBranchOutcome =
    | { state: "ready"; git: LinkedGit; branch: string; baseBranch: string | null; baseCommit: string }
    | { state: "no-git" }
    | { state: "cancelled" };

/**
 * Git side of a W38 Re-Design (decisions of 2026-11-21): work in place on a Penforge branch
 * `penforge/redesign-<yyyymmdd-hhmm>`, never on the user's branch; ask before stashing or keeping
 * uncommitted changes and before `git init`. An Existing project needs git; a Game UI project may
 * go on without it (it only adds files). A later Re-Design continues on the recorded branch while
 * it exists.
 */
export class RedesignBranch {
    public static readonly RECORD_FILE = "redesign.json";
    private static readonly MAX_APPS = 50;

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly root: string,
        private readonly kind: LinkedProjectKind,
        private readonly now: () => Date = () => new Date()
    ) {}

    /** Gets what a run would do, without changing anything. */
    public async plan(): Promise<RedesignGitPlan> {
        const git = new LinkedGit(this.root);
        const state = await git.state();
        if (!state.git) {
            return { git: false, dirty: false, currentBranch: null, branch: null, continuing: false };
        }
        const record = await this.record();
        const continuing = record !== null && (await git.branchExists(record.branch));
        return {
            git: true,
            dirty: state.dirty,
            currentBranch: state.branch,
            branch: continuing ? record!.branch : LinkedGit.branchName(this.now()),
            continuing,
        };
    }

    /**
     * Prepares the branch: asks the user where needed, then creates or switches to it.
     */
    public async prepare(): Promise<RedesignBranchOutcome> {
        const git = new LinkedGit(this.root);
        let state = await git.state();
        if (!state.git) {
            const answer = await this.ctx.ask({
                text:
                    this.kind === "game"
                        ? "This game folder is not a git repository. Create one so Penforge can put its files on " +
                          "their own branch? Without git, Penforge only adds the PenforgeUI folder."
                        : "This app folder is not a git repository. Re-Design works on its own git branch, so it " +
                          "needs one. Create a repository now (your files are recorded in a first commit)?",
                options:
                    this.kind === "game"
                        ? [
                              { id: "init", label: "Create a git repository" },
                              { id: "skip", label: "Go on without git" },
                          ]
                        : [
                              { id: "init", label: "Create a git repository" },
                              { id: "cancel", label: "Cancel" },
                          ],
            });
            if (answer === "skip" && this.kind === "game") {
                return { state: "no-git" };
            }
            if (answer !== "init") {
                return { state: "cancelled" };
            }
            await git.init(this.kind === "game");
            state = await git.state();
        }
        let keepChanges = false;
        if (state.dirty) {
            const answer = await this.ctx.ask({
                text:
                    "The folder has uncommitted changes. Stash them (git stash, get them back later), keep them " +
                    "on the new Penforge branch as its first commit, or cancel?",
                options: [
                    { id: "stash", label: "Stash them" },
                    { id: "commit", label: "Keep them on the new branch" },
                    { id: "cancel", label: "Cancel" },
                ],
            });
            if (answer === "stash") {
                await git.stash();
            } else if (answer === "commit") {
                keepChanges = true;
            } else {
                return { state: "cancelled" };
            }
        }
        const now = this.now().toISOString();
        const record = await this.record();
        let branch: string;
        let baseBranch: string | null;
        let baseCommit: string;
        if (record !== null && (await git.branchExists(record.branch))) {
            branch = record.branch;
            baseBranch = record.baseBranch;
            baseCommit = record.baseCommit;
            if (state.branch !== branch) {
                await git.switchTo(branch);
            }
        } else {
            branch = await this.freeBranchName(git);
            baseBranch = state.branch;
            baseCommit = state.head ?? "";
            await git.createBranch(branch);
        }
        if (keepChanges) {
            const commit = await git.commit("penforge(redesign): keep uncommitted changes from before Re-Design");
            if (commit !== null && record === null) {
                baseCommit = commit;
            }
        }
        if (baseCommit === "") {
            baseCommit = (await git.state()).head ?? "";
        }
        await this.ctx.workspace.writeJson(RedesignBranch.RECORD_FILE, {
            kind: this.kind,
            root: this.root,
            branch,
            baseBranch,
            baseCommit,
            createdAt: record?.branch === branch ? record.createdAt : now,
            updatedAt: now,
            ...(record?.branch === branch && Array.isArray(record.apps) ? { apps: record.apps } : {}),
        } satisfies RedesignRecord);
        return { state: "ready", git, branch, baseBranch, baseCommit };
    }

    /**
     * Checks the content of a `redesign.json`.
     *
     * @param value - the parsed file
     * @returns the record, or null when it is not a valid one
     */
    public static readRecord(value: unknown): ReadRedesignRecord | null {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        const record = value as Partial<Record<keyof RedesignRecord, unknown>>;
        const text = (field: unknown) => (typeof field === "string" && field.length > 0 ? field : null);
        if (
            (record.kind !== "existing" && record.kind !== "game") ||
            text(record.root) === null ||
            typeof record.branch !== "string" ||
            !record.branch.startsWith(LinkedGit.BRANCH_PREFIX) ||
            text(record.baseCommit) === null
        ) {
            return null;
        }
        const apps: RedesignedAppEntry[] = [];
        for (const entry of Array.isArray(record.apps) ? record.apps.slice(0, RedesignBranch.MAX_APPS) : []) {
            const app = typeof entry === "object" && entry !== null ? (entry as Partial<RedesignedAppEntry>) : null;
            const appDir = RedesignBranch.relativeDir(app?.appDir);
            if (app === null || appDir === null) {
                continue;
            }
            apps.push({ fileId: text(app.fileId), fileName: text(app.fileName), appDir });
        }
        return {
            kind: record.kind,
            root: record.root as string,
            branch: record.branch,
            baseBranch: text(record.baseBranch),
            baseCommit: record.baseCommit as string,
            createdAt: text(record.createdAt) ?? "",
            updatedAt: text(record.updatedAt) ?? text(record.createdAt) ?? "",
            apps,
        };
    }

    /**
     * Records the apps a run changed (W39): they replace the earlier entries of the same Penpot file;
     * other files' entries stay.
     *
     * @param workspace - the project workspace holding `redesign.json`
     * @param file - the Penpot file of the run
     * @param appDirs - app folders the run changed, relative to the linked folder
     */
    public static async recordApps(
        workspace: WorkflowWorkspaceApi,
        file: { fileId: string; fileName: string },
        appDirs: readonly string[]
    ): Promise<void> {
        const current = await workspace.readJson<RedesignRecord | null>(RedesignBranch.RECORD_FILE, null);
        const read = RedesignBranch.readRecord(current);
        if (current === null || read === null) {
            return;
        }
        const kept = read.apps.filter((app) => app.fileId !== file.fileId);
        const fileName = file.fileName.trim().length > 0 ? file.fileName.trim() : null;
        const added = appDirs.map((appDir) => ({ fileId: file.fileId, fileName, appDir }));
        await workspace.writeJson(RedesignBranch.RECORD_FILE, {
            ...current,
            apps: [...added, ...kept].slice(0, RedesignBranch.MAX_APPS),
        } satisfies RedesignRecord);
    }

    /** Normalises an app folder: relative, `/`-separated, no `.`/`..` segments; null when invalid. */
    private static relativeDir(dir: unknown): string | null {
        if (typeof dir !== "string" || /^([A-Za-z]:|[\\/])/.test(dir)) {
            return null;
        }
        const segments = dir.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
        return segments.includes("..") ? null : segments.join("/");
    }

    private async record(): Promise<RedesignRecord | null> {
        const record = await this.ctx.workspace.readJson<RedesignRecord | null>(RedesignBranch.RECORD_FILE, null);
        if (!record || typeof record.branch !== "string" || !record.branch.startsWith(LinkedGit.BRANCH_PREFIX)) {
            return null;
        }
        return record.kind === this.kind && record.root === this.root ? record : null;
    }

    private async freeBranchName(git: LinkedGit): Promise<string> {
        const base = LinkedGit.branchName(this.now());
        let name = base;
        for (let n = 2; await git.branchExists(name); n++) {
            name = `${base}-${n}`;
        }
        return name;
    }
}
