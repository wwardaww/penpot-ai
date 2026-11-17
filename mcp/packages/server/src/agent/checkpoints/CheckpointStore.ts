import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import type { Checkpoint, CheckpointFile } from "./types";

/**
 * Checkpoints of one project, kept in `.penforge/checkpoints.json`.
 *
 * Writers of the same project are serialized with {@link CheckpointStore.exclusive}, so that ids
 * stay unique and no update is lost when two workflows save checkpoints at once.
 */
export class CheckpointStore {
    /** Name of the metadata file below `.penforge/`. */
    public static readonly FILE_NAME = "checkpoints.json";

    /** Workflow name of the checkpoints a restore saves before it changes anything. */
    public static readonly RESTORE_WORKFLOW = "checkpoint-restore";

    private static readonly ID_PATTERN = /^cp-([1-9][0-9]*)$/;

    /** Tail of the pending operations, per project folder. */
    private static readonly locks = new Map<string, Promise<unknown>>();

    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /**
     * Runs an operation while no other exclusive operation of the same project runs.
     *
     * @param operation - the operation
     */
    public exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const key = this.workspace.root;
        const previous = CheckpointStore.locks.get(key) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(operation);
        const tail = result.catch(() => undefined);
        CheckpointStore.locks.set(key, tail);
        void tail.then(() => {
            if (CheckpointStore.locks.get(key) === tail) {
                CheckpointStore.locks.delete(key);
            }
        });
        return result;
    }

    /** Gets every checkpoint, oldest first. */
    public async list(): Promise<Checkpoint[]> {
        const content = await this.workspace.readJson<Partial<CheckpointFile> | null>(CheckpointStore.FILE_NAME, null);
        return Array.isArray(content?.checkpoints) ? content.checkpoints : [];
    }

    /**
     * Gets a checkpoint.
     *
     * @param id - the checkpoint id
     */
    public async get(id: string): Promise<Checkpoint | undefined> {
        return (await this.list()).find((checkpoint) => checkpoint.id === id);
    }

    /**
     * Gets the next free sequence number.
     */
    public async nextNumber(): Promise<number> {
        return (await this.list()).reduce((max, checkpoint) => Math.max(max, checkpoint.n), 0) + 1;
    }

    /**
     * Adds a checkpoint.
     *
     * @param checkpoint - the checkpoint; its id must be new
     */
    public async add(checkpoint: Checkpoint): Promise<void> {
        const checkpoints = await this.list();
        if (checkpoints.some((other) => other.id === checkpoint.id)) {
            throw new Error(`Checkpoint ${checkpoint.id} already exists`);
        }
        await this.save([...checkpoints, checkpoint]);
    }

    /**
     * Changes a checkpoint.
     *
     * @param id - the checkpoint id
     * @param changes - the fields to change
     * @returns the changed checkpoint
     */
    public async update(id: string, changes: Partial<Omit<Checkpoint, "id" | "n">>): Promise<Checkpoint> {
        const checkpoints = await this.list();
        const index = checkpoints.findIndex((checkpoint) => checkpoint.id === id);
        if (index < 0) {
            throw new Error(`No checkpoint ${id}`);
        }
        const updated = { ...checkpoints[index], ...changes };
        checkpoints[index] = updated;
        await this.save(checkpoints);
        return updated;
    }

    /**
     * Gets the checkpoint "Undo last AI change" restores: the newest one taken before an AI change
     * (not by a restore) that has not been restored yet. Undoing again walks further back.
     *
     * @param checkpoints - the checkpoints, as returned by {@link list}
     */
    public static undoTarget(checkpoints: Checkpoint[]): Checkpoint | undefined {
        return [...checkpoints]
            .sort((a, b) => b.n - a.n)
            .find((checkpoint) => checkpoint.workflow !== CheckpointStore.RESTORE_WORKFLOW && !checkpoint.restoredAt);
    }

    /**
     * Builds the id of a sequence number.
     *
     * @param n - the sequence number
     */
    public static idOf(n: number): string {
        return `cp-${n}`;
    }

    /**
     * Tells whether a string looks like a checkpoint id.
     *
     * @param id - the candidate
     */
    public static isId(id: unknown): id is string {
        return typeof id === "string" && CheckpointStore.ID_PATTERN.test(id);
    }

    private save(checkpoints: Checkpoint[]): Promise<void> {
        const content: CheckpointFile = { version: 1, checkpoints };
        return this.workspace.writeJson(CheckpointStore.FILE_NAME, content);
    }
}
