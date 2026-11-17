/**
 * Daemon workflows shipped with Penforge.
 *
 * APPEND-ONLY: each workflow adds exactly one line, `export { workflow as <camelCaseName> } from
 * "./<name>";`. The registry picks up every export of this module (see `wiki/architecture.md` §7).
 */
export { workflow as chat } from "./chat";
export { workflow as designMdRead } from "./design-md-read";
export { workflow as designMdSave } from "./design-md-save";
export { workflow as designMdDraft } from "./design-md-draft";
export { workflow as designMdImport } from "./design-md-import";
export { workflow as designMdExport } from "./design-md-export";
