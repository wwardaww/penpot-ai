/**
 * Change requests (W34): the build checkpoint and design state saved after every build, the
 * detection of what changed since then, the change request files (`.penforge/changes/CR-<n>`) the
 * Update button builds from, and the instructions for the AI. See `wiki/architecture.md` §7.
 */
export {
    BuildInstructions,
    InstructionsInputSchema,
    type BuildInstructionSet,
    type InstructionsInput,
} from "./BuildInstructions";
export { BuildRecords, type BuildRecord, type BuildsFile } from "./BuildRecords";
export { ChangeDetector } from "./ChangeDetector";
export { ChangeRequests, type ChangeRequest } from "./ChangeRequests";
export {
    ChangeSets,
    CHANGE_CODES,
    type ChangeCode,
    type ChangeItem,
    type ChangeSet,
    type ScreenChange,
} from "./ChangeSet";
export { ChangeTracker, type Detection, type FinishedBuild } from "./ChangeTracker";
export { DesignStates, type BoardState, type DesignState, type LayerState } from "./DesignState";
export { DesignStateReader } from "./DesignStateReader";
