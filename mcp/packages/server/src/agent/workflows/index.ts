/**
 * Daemon workflows shipped with Penforge.
 *
 * APPEND-ONLY: each workflow adds exactly one line, `export { workflow as <camelCaseName> } from
 * "./<name>";`. The registry picks up every export of this module (see `wiki/architecture.md` §7).
 */
export { workflow as chat } from "./chat";
export { workflow as checkpointCreate } from "./checkpoint-create";
export { workflow as checkpointRestore } from "./checkpoint-restore";
export { workflow as checkpointList } from "./checkpoint-list";
export { workflow as checkpointDiff } from "./checkpoint-diff";
export { workflow as autoName } from "./auto-name";
export { workflow as fixComment } from "./fix-comment";
export { workflow as fixComments } from "./fix-comments";
export { workflow as generateScreen } from "./generate-screen";
export { workflow as adaptResponsive } from "./adapt-responsive";
export { workflow as audit } from "./audit";
export { workflow as designMdRead } from "./design-md-read";
export { workflow as designMdSave } from "./design-md-save";
export { workflow as designMdDraft } from "./design-md-draft";
export { workflow as designMdImport } from "./design-md-import";
export { workflow as designMdExport } from "./design-md-export";
export { workflow as buildPlan } from "./build-plan";
export { workflow as buildRun } from "./build-run";
export { workflow as visualQa } from "./visual-qa";
