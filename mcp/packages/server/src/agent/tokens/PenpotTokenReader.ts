import type { WorkflowToolsApi } from "@penpot/mcp-common";
import type { PenpotTokenSnapshot } from "./DesignTokens";
import { TokenSyncError } from "./TokenSyncError";

/**
 * Reader of the open file's design tokens (`penpot.library.local.tokens`, the `TokenCatalog`)
 * through the `execute_code` MCP tool.
 *
 * The script is plain JavaScript text, so it runs as written inside the plugin sandbox; tests run
 * the same text against a fake catalog.
 */
export class PenpotTokenReader {
    /** Plugin API code returning a {@link PenpotTokenSnapshot}. */
    public static readonly SCRIPT = `const catalog = penpot.library.local.tokens;
const str = (v) => (v === undefined || v === null ? "" : String(v));
const plain = (v) => {
  if (v === undefined || v === null) {
    return null;
  }
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
};
const read = (t) => {
  let resolved = null;
  try { resolved = plain(t.resolvedValue); } catch (e) { resolved = null; }
  return { name: str(t.name), type: str(t.type), value: plain(t.value), resolved, description: str(t.description) };
};
return {
  fileName: penpot.currentFile ? str(penpot.currentFile.name) : "",
  activeThemes: catalog.themes
    .filter((th) => th.active)
    .map((th) => (th.group ? str(th.group) + "/" : "") + str(th.name)),
  sets: catalog.sets.map((s) => ({ name: str(s.name), active: !!s.active, tokens: s.tokens.map(read) })),
};`;

    /**
     * @param tools - the workflow's MCP tools
     */
    constructor(private readonly tools: WorkflowToolsApi) {}

    /**
     * Reads the tokens of the open file.
     *
     * @throws TokenSyncError `penpot-unreachable` when the plugin cannot run the code
     */
    public async read(): Promise<PenpotTokenSnapshot> {
        const result = await this.tools.call("execute_code", { code: PenpotTokenReader.SCRIPT });
        if (result.isError) {
            throw new TokenSyncError(
                "penpot-unreachable",
                `Could not read the design tokens from Penpot: ${result.text.slice(0, 300)}`
            );
        }
        let parsed: unknown;
        try {
            parsed = (JSON.parse(result.text) as { result?: unknown }).result;
        } catch {
            throw new TokenSyncError(
                "penpot-unreachable",
                `Unexpected answer from Penpot: ${result.text.slice(0, 200)}`
            );
        }
        return PenpotTokenReader.check(parsed);
    }

    private static check(value: unknown): PenpotTokenSnapshot {
        const snapshot = (typeof value === "object" && value !== null ? value : {}) as Partial<PenpotTokenSnapshot>;
        if (!Array.isArray(snapshot.sets)) {
            throw new TokenSyncError("penpot-unreachable", "Penpot returned no token sets");
        }
        return {
            fileName: typeof snapshot.fileName === "string" ? snapshot.fileName : "",
            activeThemes: Array.isArray(snapshot.activeThemes) ? snapshot.activeThemes.map(String) : [],
            sets: snapshot.sets.map((set) => ({
                name: String(set?.name ?? ""),
                active: set?.active === true,
                tokens: Array.isArray(set?.tokens)
                    ? set.tokens.map((token) => ({
                          name: String(token?.name ?? ""),
                          type: String(token?.type ?? ""),
                          value: token?.value ?? null,
                          resolved: token?.resolved ?? null,
                          description: String(token?.description ?? ""),
                      }))
                    : [],
            })),
        };
    }
}
