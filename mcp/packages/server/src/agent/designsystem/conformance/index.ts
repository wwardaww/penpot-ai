/**
 * Design system binding (W30): a project uses one design system (W29 library); the AI follows it
 * strictly, a check fixes drift after AI writes, and what the system lacks is listed once.
 * See `wiki/architecture.md` §7 ("Design system binding").
 */
export { AddTaskSignals, AddTaskStore, type AddTask, type AddTaskItem, type AddTaskResult } from "./AddTasks";
export {
    BindingFailure,
    BindingRun,
    type BindingFailureCode,
    type BindingLogCode,
    type BindingStep,
} from "./BindingRun";
export { BindingStore, siblingWorkspace, type DesignSystemBinding } from "./Binding";
export { DesignSystemConformance, type ConformanceOptions, type ConformanceOutcome } from "./Conformance";
export { ConformanceChecker, type CheckOptions } from "./ConformanceChecker";
export {
    ConformanceScripts,
    MISSING_ITEM_KEY,
    type ComponentBrief,
    type FixReport,
    type LinkReport,
    type ScanScope,
} from "./ConformanceScripts";
export { DesignMdPointer, POINTER_HEADING, type PointerReport } from "./DesignMdPointer";
export { sourceMapFixes } from "./SourceMapFixes";
export { MissingItems, type ReportedItem } from "./MissingItems";
export { DesignSystemTurnCheck, FIXED_CODE, MISSING_CODE, type FixedPayload } from "./TurnCheck";
export type * from "./types";
