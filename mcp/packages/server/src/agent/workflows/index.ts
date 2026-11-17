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
