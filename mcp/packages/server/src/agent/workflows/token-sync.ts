import type { Workflow } from "@penpot/mcp-common";
import { TokenSync, type TokenSyncParams } from "../tokens";

/**
 * Syncs the open file's design tokens to the generated app's theme (W21): exports them to
 * `design/penpot-tokens.json`, rewrites the generated block of the theme file in the stack's
 * format and, with `link` `auto`/`always`, lets Claude replace hard-coded values with token
 * references. `build-run` runs it before every build (`stack.json` `preBuild`). Emits `progress`
 * `{step, status, text}`, `result` ({@link TokenSync} `TokenSyncResult`), `failed {code, message}`.
 */
export const workflow: Workflow<TokenSyncParams> = {
    name: "token-sync",
    description: "Writes the file's design tokens into the app theme so the code follows token changes.",
    run: (ctx, params) => new TokenSync(ctx, params ?? {}).run(),
};
