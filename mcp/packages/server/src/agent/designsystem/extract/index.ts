/**
 * Design system from an existing project (W36): inventory of a copied project file, ONE
 * proposal list, apply in stages and the `source-map.json` W30 links the project with. See
 * `wiki/architecture.md` §7.
 */
export { ColorMath } from "./ColorMath";
export * from "./ExtractModel";
export { colorProposalId, ExtractPlanner, PLAN_LIMITS, shadowKey } from "./ExtractPlanner";
export {
    ExtractFailure,
    ExtractRun,
    type ExtractFailureCode,
    type ExtractLogCode,
    type ExtractStep,
} from "./ExtractRun";
export {
    DEFAULT_INVENTORY_LIMITS,
    ExtractScripts,
    SYSTEM_PAGES,
    type ColorsReport,
    type ComponentOps,
    type ComponentReport,
    type IconMarkup,
    type InventoryLimits,
    type PagesReport,
} from "./ExtractScripts";
export { SourceMapFile, type SourceMap, type SourceMapInput, type SourceRef } from "./SourceMap";
