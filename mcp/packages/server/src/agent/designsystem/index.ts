/**
 * Design system files (W29): a Penpot file that is (or becomes) a shared library holding a full
 * design system. See `wiki/research/design-system-library.md` and `wiki/architecture.md` §7.
 */
export { DESIGN_SYSTEMS_DIR, designSystemDesignMd, designSystemWorkspace } from "./DesignSystemWorkspace";
export {
    DesignSystemFailure,
    DesignSystemRun,
    type DesignSystemFailureCode,
    type DesignSystemLogCode,
    type DesignSystemStep,
} from "./DesignSystemRun";
export {
    DESIGN_SYSTEM_KEY,
    DesignSystemScripts,
    OVERVIEW_KEY,
    PAGE_NAMES,
    PLUGIN_NAMESPACE,
    type DesignSystemMarker,
    type DesignSystemSummary,
    type ExtraToken,
    type OverviewKind,
    type OverviewReport,
} from "./DesignSystemScripts";
export { BASE_COMPONENTS, componentBrief } from "./ComponentBrief";
