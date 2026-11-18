/**
 * Tidy-up of messy designs (W17): heuristics, plugin scripts and the pixel comparison used by the
 * `cleanup-import` workflow.
 */
export { CleanupHeuristics, type Box, type GridMatch, type HeuristicOptions, type StackMatch } from "./heuristics";
export { CleanupScripts, type LayoutUndo } from "./scripts";
export { PixelDiff, type RgbaImage } from "./pixelDiff";
export type * from "./types";
