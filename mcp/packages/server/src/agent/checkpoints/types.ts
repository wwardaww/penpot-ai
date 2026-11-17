/** Penpot file version saved with a checkpoint. */
export interface CheckpointFileVersion {
    /** Penpot file the version belongs to */
    fileId: string;
    fileName?: string;
    /**
     * Label of the version in Penpot's version history. The Plugin API does not expose version ids,
     * so the label (unique per checkpoint) and the creation date identify the version.
     */
    label: string;
    /** creation date reported by Penpot (ISO string), or null when unknown */
    createdAt: string | null;
}

/** Checkpoint: the state of a project's design and code before an AI change. */
export interface Checkpoint {
    /** `cp-<n>` */
    id: string;
    /** sequence number, unique per project */
    n: number;
    /** what the checkpoint is for, in plain words ("Before fixing 3 comments") */
    label: string;
    /** workflow that asked for the checkpoint (`fix-comments`, `manual`, `checkpoint-restore`, …) */
    workflow: string;
    /** creation date (ISO string) */
    at: string;
    /** Penpot file version, or null when it could not be saved */
    fileVersion: CheckpointFileVersion | null;
    /** commit of the `design/` repo */
    designSha: string;
    /** commit of the `app-src/` repo */
    appSha: string;
    /** git tag set on both commits: `penforge-cp-<n>` */
    tag: string;
    /** date of the last restore of this checkpoint (ISO string) */
    restoredAt?: string;
    /** parts that could not be saved, in plain words */
    warnings?: string[];
}

/** Content of `.penforge/checkpoints.json`. */
export interface CheckpointFile {
    version: 1;
    checkpoints: Checkpoint[];
}

/** Params of the `checkpoint-create` workflow. */
export interface CheckpointCreateParams {
    label?: string;
    workflow?: string;
}

/** Params of the `checkpoint-restore` workflow. */
export interface CheckpointRestoreParams {
    /** checkpoint to restore */
    id?: string;
    /** restore the checkpoint "Undo last AI change" points at (see `CheckpointStore.undoTarget`) */
    last?: boolean;
    /** true when the client already asked the user; otherwise the workflow asks */
    confirmed?: boolean;
}

/** What happened to the design during a restore. */
export type DesignRestoreStatus = "restoring" | "skipped" | "missing";

/** Result of a restore. */
export interface CheckpointRestoreResult {
    checkpoint: Checkpoint;
    /** checkpoint saved right before the restore, so the restore can be undone */
    safety: Checkpoint;
    design: DesignRestoreStatus;
}
