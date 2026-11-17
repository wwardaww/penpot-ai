/**
 * Daemon workflows shipped with Penforge.
 *
 * APPEND-ONLY: each workflow adds exactly one line, `export { workflow as <camelCaseName> } from
 * "./<name>";`. The registry picks up every export of this module (see `wiki/architecture.md` §7).
 */
export { workflow as chat } from "./chat";
