/**
 * AI checkpoints (W19): the design (Penpot file version) and the code (`design/`, `app-src/` git
 * repos) saved before an AI change, so the user can go back. See `wiki/architecture.md` §7.
 */
export { Checkpoints, ensureCheckpoint, type CheckpointDiff, type CheckpointListing } from "./Checkpoints";
export { CheckpointStore } from "./CheckpointStore";
export type {
    Checkpoint,
    CheckpointCreateParams,
    CheckpointFileVersion,
    CheckpointRestoreParams,
    CheckpointRestoreResult,
    DesignRestoreStatus,
} from "./types";
