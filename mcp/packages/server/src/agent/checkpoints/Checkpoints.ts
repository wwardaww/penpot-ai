import type { ProjectRepo, WorkflowContext } from "@penpot/mcp-common";
import { CheckpointStore } from "./CheckpointStore";
import { GitRepo, type RepoDiff } from "./GitRepo";
import { PenpotVersions } from "./PenpotVersions";
import type {
    Checkpoint,
    CheckpointCreateParams,
    CheckpointFileVersion,
    CheckpointRestoreParams,
    CheckpointRestoreResult,
    DesignRestoreStatus,
} from "./types";

/** Listing of a project's checkpoints. */
export interface CheckpointListing {
    /** newest first */
    checkpoints: Checkpoint[];
    /** checkpoint "Undo last AI change" restores, or null */
    undoTargetId: string | null;
}

/** Diff of both repositories against a checkpoint. */
export interface CheckpointDiff {
    checkpoint: Checkpoint;
    design: RepoDiff;
    appSrc: RepoDiff;
}

/**
 * Checkpoints of the project a workflow runs for: save, list, diff and restore the design (Penpot
 * file version) and the code (`design/` and `app-src/` git repos) together.
 */
export class Checkpoints {
    /** Longest checkpoint label. */
    public static readonly MAX_LABEL_LENGTH = 200;

    /** Workflow name recorded for checkpoints the user saves by hand. */
    public static readonly MANUAL_WORKFLOW = "manual";

    /** Option ids of the restore question. */
    public static readonly CONFIRM_OPTION = "restore";
    public static readonly CANCEL_OPTION = "cancel";

    private static readonly WORKFLOW_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

    /** Signs in git's output that a file was in use (Windows file locks, busy files). */
    private static readonly FILE_IN_USE_PATTERN =
        /unable to unlink|unable to create file|permission denied|resource busy|being used by another process|invalid argument/i;

    private readonly store: CheckpointStore;
    private readonly versions: PenpotVersions;
    private readonly gitRepo: (dir: string) => GitRepo;

    /**
     * @param ctx - the workflow context
     * @param options - `gitRepo` builds the git helper of a repository folder (tests)
     */
    constructor(
        private readonly ctx: WorkflowContext,
        options: { gitRepo?: (dir: string) => GitRepo } = {}
    ) {
        this.store = new CheckpointStore(ctx.workspace);
        this.versions = new PenpotVersions(ctx.tools);
        this.gitRepo = options.gitRepo ?? ((dir) => new GitRepo(dir));
    }

    /**
     * Saves a checkpoint. The Penpot version is optional: when it cannot be saved (no plugin
     * connected, Penpot refused it) the checkpoint keeps the code only and says so in `warnings`.
     *
     * @param params - label and workflow name
     */
    public create(params: CheckpointCreateParams = {}): Promise<Checkpoint> {
        const workflow = Checkpoints.workflowName(params.workflow);
        const label = Checkpoints.cleanLabel(params.label) ?? Checkpoints.defaultLabel(workflow);
        return this.store.exclusive(() => this.createLocked(label, workflow));
    }

    /** Lists the checkpoints, newest first. */
    public async list(): Promise<CheckpointListing> {
        const checkpoints = await this.store.list();
        return {
            checkpoints: [...checkpoints].sort((a, b) => b.n - a.n),
            undoTargetId: CheckpointStore.undoTarget(checkpoints)?.id ?? null,
        };
    }

    /**
     * Diffs both repositories (working trees) against a checkpoint.
     *
     * @param id - the checkpoint id
     */
    public async diff(id: unknown): Promise<CheckpointDiff> {
        const checkpoint = await this.find({ id });
        return {
            checkpoint,
            design: await this.repo("design").diff(checkpoint.designSha),
            appSrc: await this.repo("app-src").diff(checkpoint.appSha),
        };
    }

    /**
     * Restores a checkpoint: saves a checkpoint of the current state first (so the restore can be
     * undone; its commits are the heads to roll back to), restores the Penpot version and waits
     * for it, then resets both repositories (`git reset --hard`). Nothing in git changes when the
     * design restore fails. When a git reset fails (a file in use on Windows), both repositories
     * and the design go back to the safety checkpoint. Asks the user first unless
     * `params.confirmed`.
     *
     * @param params - which checkpoint
     * @returns the result, or null when the user said no
     */
    public async restore(params: CheckpointRestoreParams): Promise<CheckpointRestoreResult | null> {
        const target = await this.find(params);
        await this.checkRestorable(target);

        if (params.confirmed !== true) {
            const answer = await this.ctx.ask({
                text:
                    `Go back to checkpoint #${target.n}, “${target.label}”? ` +
                    "The design and the code return to how they were then. Every change made after it, " +
                    "by the AI or by hand, is undone. A new checkpoint saves the current state first, " +
                    "so you can come back to it.",
                options: [
                    { id: Checkpoints.CONFIRM_OPTION, label: "Go back" },
                    { id: Checkpoints.CANCEL_OPTION, label: "Keep current" },
                ],
            });
            if (answer !== Checkpoints.CONFIRM_OPTION) {
                return null;
            }
        }

        return this.store.exclusive(async () => {
            // the target may have changed while the user was answering
            const checkpoint = await this.find({ id: target.id });
            await this.checkRestorable(checkpoint);
            this.checkNotAborted();

            const safety = await this.createLocked(
                `Before going back to #${checkpoint.n}`,
                CheckpointStore.RESTORE_WORKFLOW
            );

            this.progress("Restoring the design");
            const design: DesignRestoreStatus = checkpoint.fileVersion
                ? await this.versions.restore(checkpoint.fileVersion)
                : "skipped";

            this.progress("Restoring the code");
            try {
                await this.repo("design").resetHard(checkpoint.designSha);
                await this.repo("app-src").resetHard(checkpoint.appSha);
            } catch (error) {
                const complete = await this.rollBack(safety, design === "restored");
                throw new Error(Checkpoints.codeRestoreFailure(error, safety, complete));
            }

            const restored = await this.store.update(checkpoint.id, { restoredAt: new Date().toISOString() });
            const result: CheckpointRestoreResult = { checkpoint: restored, safety, design };
            this.ctx.emit("checkpoint", { action: "restored", ...result });
            return result;
        });
    }

    /**
     * Describes a restore result in plain words.
     *
     * @param result - the result
     */
    public static restoreSummary(result: CheckpointRestoreResult): string {
        const label = `“${result.checkpoint.label}”`;
        switch (result.design) {
            case "restored":
                return `Went back to ${label}: design and code restored.`;
            case "missing":
                return (
                    `Went back to ${label} for the code. The design version was not found in Penpot's ` +
                    "version history (deleted or renamed), so the design was not changed."
                );
            default:
                return `Went back to ${label}: code restored. No design version was saved with it.`;
        }
    }

    /**
     * Puts both repositories and, when it was restored, the design back to the safety checkpoint.
     *
     * @returns true when everything went back
     */
    private async rollBack(safety: Checkpoint, designRestored: boolean): Promise<boolean> {
        let complete = true;
        for (const [repo, sha] of [
            ["design", safety.designSha],
            ["app-src", safety.appSha],
        ] as [ProjectRepo, string][]) {
            try {
                await this.repo(repo).resetHard(sha);
            } catch {
                complete = false;
            }
        }
        if (designRestored) {
            try {
                if (!safety.fileVersion || (await this.versions.restore(safety.fileVersion)) !== "restored") {
                    complete = false;
                }
            } catch {
                complete = false;
            }
        }
        return complete;
    }

    /**
     * Describes a failed code restore in plain words.
     */
    private static codeRestoreFailure(error: unknown, safety: Checkpoint, complete: boolean): string {
        const detail = Checkpoints.describe(error);
        const cause = Checkpoints.FILE_IN_USE_PATTERN.test(detail)
            ? "A file of the project is in use (for example by the running app preview, a terminal " +
              "or an editor), so the code could not be restored."
            : `The code could not be restored (${detail.split("\n")[0].trim()}).`;
        const state = complete
            ? "Nothing was changed. Close the app preview or the program using the files and try again."
            : `Some files could not be put back; checkpoint #${safety.n} holds the state from before.`;
        return `${cause} ${state}`;
    }

    private async createLocked(label: string, workflow: string): Promise<Checkpoint> {
        this.checkNotAborted();
        const n = await this.store.nextNumber();
        const id = CheckpointStore.idOf(n);
        const tag = `penforge-${id}`;
        const warnings: string[] = [];
        this.progress("Saving a checkpoint");

        let fileVersion: CheckpointFileVersion | null = null;
        try {
            fileVersion = await this.versions.save(PenpotVersions.versionLabel(n, label), this.ctx.context.fileId);
        } catch (error) {
            warnings.push(`The design version could not be saved: ${Checkpoints.describe(error)}`);
        }

        const message = `penforge(checkpoint): #${n} ${label}`;
        const designSha = await this.commit("design", message);
        const appSha = await this.commit("app-src", message);
        await this.repo("design").tag(tag, designSha);
        await this.repo("app-src").tag(tag, appSha);

        const checkpoint: Checkpoint = {
            id,
            n,
            label,
            workflow,
            at: new Date().toISOString(),
            fileVersion,
            designSha,
            appSha,
            tag,
            ...(warnings.length > 0 ? { warnings } : {}),
        };
        await this.store.add(checkpoint);
        this.ctx.emit("checkpoint", { action: "created", checkpoint });
        return checkpoint;
    }

    private async commit(repo: ProjectRepo, message: string): Promise<string> {
        const sha = await this.ctx.workspace.commitAll(repo, message);
        return sha ?? (await this.repo(repo).head());
    }

    private async find(params: { id?: unknown; last?: boolean }): Promise<Checkpoint> {
        const checkpoints = await this.store.list();
        if (params.last === true) {
            const target = CheckpointStore.undoTarget(checkpoints);
            if (!target) {
                throw new Error("There is no AI change to undo");
            }
            return target;
        }
        if (!CheckpointStore.isId(params.id)) {
            throw new Error("A checkpoint id (cp-<n>) is needed");
        }
        const checkpoint = checkpoints.find((candidate) => candidate.id === params.id);
        if (!checkpoint) {
            throw new Error(`No checkpoint ${params.id}`);
        }
        return checkpoint;
    }

    private async checkRestorable(checkpoint: Checkpoint): Promise<void> {
        const version = checkpoint.fileVersion;
        if (version && version.fileId !== this.ctx.context.fileId) {
            throw new Error(
                `This checkpoint belongs to the file “${version.fileName ?? version.fileId}”; open that file to restore it`
            );
        }
        for (const [repo, sha] of [
            ["design", checkpoint.designSha],
            ["app-src", checkpoint.appSha],
        ] as [ProjectRepo, string][]) {
            if (!(await this.repo(repo).hasCommit(sha))) {
                throw new Error(`The ${repo} repository no longer holds the commit of this checkpoint`);
            }
        }
    }

    private repo(repo: ProjectRepo): GitRepo {
        const workspace = this.ctx.workspace;
        return this.gitRepo(workspace.resolve(repo === "design" ? workspace.designDir : workspace.appSrcDir));
    }

    private progress(text: string): void {
        this.ctx.emit("progress", { text });
    }

    private checkNotAborted(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }

    private static cleanLabel(label: unknown): string | undefined {
        if (typeof label !== "string") {
            return undefined;
        }
        const clean = label.replace(/\s+/g, " ").trim();
        if (clean.length === 0) {
            return undefined;
        }
        return clean.length > Checkpoints.MAX_LABEL_LENGTH
            ? clean.slice(0, Checkpoints.MAX_LABEL_LENGTH - 1) + "…"
            : clean;
    }

    private static workflowName(workflow: unknown): string {
        return typeof workflow === "string" && Checkpoints.WORKFLOW_PATTERN.test(workflow)
            ? workflow
            : Checkpoints.MANUAL_WORKFLOW;
    }

    private static defaultLabel(workflow: string): string {
        return workflow === Checkpoints.MANUAL_WORKFLOW ? "Saved by hand" : `Before ${workflow}`;
    }

    private static describe(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

/**
 * Saves a checkpoint before an AI change, for workflows that change the design or the code.
 * Never throws (except when the run is cancelled): without a checkpoint the change still runs,
 * and the failure is reported as a `log` event.
 *
 * @param ctx - the calling workflow's context
 * @param label - what the checkpoint is for, in plain words ("Before fixing 3 comments")
 * @param workflow - the calling workflow's name
 * @returns the checkpoint, or null when it could not be saved
 */
export async function ensureCheckpoint(
    ctx: WorkflowContext,
    label: string,
    workflow?: string
): Promise<Checkpoint | null> {
    try {
        return await new Checkpoints(ctx).create({ label, workflow });
    } catch (error) {
        if (ctx.signal.aborted) {
            throw error;
        }
        ctx.emit("log", {
            text: `No checkpoint saved: ${error instanceof Error ? error.message : String(error)}`,
        });
        return null;
    }
}
