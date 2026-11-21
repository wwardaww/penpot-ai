import type { WorkflowToolsApi } from "@penpot/mcp-common";
import { DesignTokens, type TokenValue } from "../tokens/DesignTokens";
import { PenpotTokenReader } from "../tokens/PenpotTokenReader";
import { type BoardState, type DesignState, DesignStateSchema, type EdgeState } from "./DesignState";
import { ExecuteCodeReply } from "./ExecuteCodeReply";

/**
 * Reader of the {@link DesignState} of the open file: one `execute_code` script for the boards'
 * layers, the file revision and the connected libraries, `get_prototype_graph` for navigation and
 * flows, and W21's token reader for the resolved tokens of the active sets.
 *
 * The script is plain JavaScript text, so it runs as written inside the plugin sandbox; tests run
 * the same text against a fake `penpot` object.
 */
export class DesignStateReader {
    /** Largest number of layers kept per board (very large boards are cut, `truncated`). */
    public static readonly MAX_LAYERS_PER_BOARD = 1500;

    /** Plugin API code returning the boards, `revn` and libraries of the open file. */
    public static readonly SCRIPT = `const MAX = ${DesignStateReader.MAX_LAYERS_PER_BOARD};
const file = penpot.currentFile;
if (!file) { throw new Error("No Penpot file is open"); }
const str = (v) => (v === undefined || v === null ? "" : String(v));
const num = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v) : 0);
const call = (s, name) => { try { return typeof s[name] === "function" ? s[name]() : null; } catch (e) { return null; } };
const tokensOf = (s) => { try { return s.tokens || {}; } catch (e) { return {}; } };
const bound = (tokens, keys) => { for (const k of keys) { if (tokens[k]) { return "token:" + tokens[k]; } } return null; };
const fillText = (fills) => !Array.isArray(fills) ? str(fills) : fills.map((f) =>
  f.fillImage ? "image" : f.fillColorGradient ? "gradient:" + (f.fillColorGradient.stops || []).map((st) => str(st.color)).join(">")
  : str(f.fillColor) + (f.fillOpacity !== undefined && f.fillOpacity !== 1 ? "@" + f.fillOpacity : "")).join(",");
const strokeText = (strokes) => !Array.isArray(strokes) ? "" : strokes.map((st) =>
  str(st.strokeColor) + "/" + str(st.strokeWidth) + "/" + str(st.strokeStyle)).join(",");
const images = (fills) => !Array.isArray(fills) ? "" : fills.filter((f) => f.fillImage).map((f) => str(f.fillImage.id)).join(",");
const layoutText = (s) => {
  const l = s.flex || s.grid;
  if (!l) { return ""; }
  return [s.flex ? "flex" : "grid", str(l.dir), str(l.rowGap), str(l.columnGap),
    [l.topPadding, l.rightPadding, l.bottomPadding, l.leftPadding].map(str).join(" "),
    str(l.alignItems), str(l.justifyContent), str(l.wrap)].join("|");
};
const animation = (s) => {
  let raw = "";
  try { raw = str(s.getSharedPluginData("penforge", "animations")); } catch (e) { raw = ""; }
  if (!raw) { return ""; }
  let h = 0;
  for (let i = 0; i < raw.length; i++) { h = (h * 31 + raw.charCodeAt(i)) | 0; }
  return raw.length + ":" + (h >>> 0).toString(16);
};
const component = (s) => {
  if (!call(s, "isComponentInstance")) { return ""; }
  const c = call(s, "component");
  return c ? str(c.path ? c.path + "/" + c.name : c.name) : "instance";
};
const layer = (s, parentId) => {
  const t = tokensOf(s);
  const text = s.type === "text";
  return {
    name: str(s.name), type: str(s.type), parentId, visible: !s.hidden,
    text: text ? str(s.characters) : null,
    typography: text ? (bound(t, ["typography", "fontFamily", "fontSize", "fontWeight"]) ||
      [str(s.fontFamily), str(s.fontSize), str(s.fontWeight), str(s.fontStyle)].join(" ")) : "",
    fills: bound(t, ["fill"]) || fillText(s.fills),
    strokes: bound(t, ["strokeColor", "stroke-color"]) || strokeText(s.strokes),
    images: images(s.fills),
    layout: s.type === "board" ? layoutText(s) : "",
    size: num(s.width) + "x" + num(s.height),
    component: component(s),
    animation: animation(s),
  };
};
const boards = {};
for (const page of file.pages) {
  const root = page.root;
  const top = root && Array.isArray(root.children) ? root.children : [];
  for (const board of top) {
    if (board.type !== "board") { continue; }
    const layers = {};
    let count = 0;
    let truncated = false;
    const walk = (s, parentId) => {
      if (count >= MAX) { truncated = true; return; }
      count++;
      layers[s.id] = layer(s, parentId);
      const children = Array.isArray(s.children) ? s.children : [];
      for (const child of children) { walk(child, s.id); }
    };
    walk(board, null);
    boards[board.id] = { name: str(board.name), pageName: str(page.name), size: num(board.width) + "x" + num(board.height), layers, truncated };
  }
}
let libraries = [];
try {
  libraries = (penpot.library.connected || []).map((l) => ({ id: str(l.id), name: str(l.name) }));
} catch (e) { libraries = []; }
libraries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
return { fileId: str(file.id), revn: typeof file.revn === "number" ? file.revn : 0, boards, libraries };`;

    /**
     * @param tools - the workflow's MCP tools
     */
    constructor(private readonly tools: WorkflowToolsApi) {}

    /**
     * Reads the revision of the open file (`File.revn`, changes with every saved change), or null
     * when another file is open or Penpot does not report it.
     *
     * @param fileId - the tab's file
     */
    public async readRevn(fileId: string): Promise<number | null> {
        const reply = await this.tools.call("execute_code", {
            code: `const file = penpot.currentFile;
return file && file.id === ${JSON.stringify(fileId)} && typeof file.revn === "number" ? file.revn : null;`,
        });
        if (reply.isError) {
            throw new Error(`execute_code failed: ${reply.text.slice(0, 300)}`);
        }
        const revn = ExecuteCodeReply.parse(reply.text);
        return typeof revn === "number" ? revn : null;
    }

    /**
     * Reads the state of the open file.
     *
     * @param fileId - the tab's file; the state records it
     * @throws Error when Penpot cannot be reached or answers in an unexpected shape
     */
    public async read(fileId: string): Promise<DesignState> {
        const reply = await this.tools.call("execute_code", { code: DesignStateReader.SCRIPT });
        if (reply.isError) {
            throw new Error(`execute_code failed: ${reply.text.slice(0, 300)}`);
        }
        const design = DesignStateReader.object(ExecuteCodeReply.parse(reply.text));
        const graph = DesignStateReader.object(await this.callJson("get_prototype_graph", {}));
        const tokens = await this.tokens();
        const edges: EdgeState[] = DesignStateReader.array(graph.edges).map((edge) => ({
            from: String(edge.from ?? ""),
            to: String(edge.to ?? ""),
            trigger: String(edge.trigger ?? ""),
            sourceName: String(edge.sourceName ?? ""),
        }));
        const flows: Record<string, string> = {};
        for (const flow of DesignStateReader.array(graph.flows)) {
            flows[String(flow.name ?? "")] = String(flow.startingBoardId ?? "");
        }
        const state = DesignStateSchema.safeParse({
            schemaVersion: 1,
            fileId,
            revn: typeof design.revn === "number" ? design.revn : 0,
            readAt: new Date().toISOString(),
            boards: DesignStateReader.object(design.boards) as Record<string, BoardState>,
            tokens,
            edges,
            flows,
            libraries: DesignStateReader.array(design.libraries).map((library) => ({
                id: String(library.id ?? ""),
                name: String(library.name ?? ""),
            })),
        });
        if (!state.success) {
            throw new Error(`Penpot answered with an unexpected design state: ${state.error.message.slice(0, 300)}`);
        }
        return state.data;
    }

    /**
     * Resolved tokens of the active sets as display strings. Throws when they cannot be read: an
     * empty answer would list every token as removed.
     */
    private async tokens(): Promise<Record<string, string>> {
        const snapshot = await new PenpotTokenReader(this.tools).read();
        const result: Record<string, string> = {};
        for (const token of DesignTokens.fromSnapshot(snapshot).tokens) {
            result[token.name] = DesignStateReader.display(token.value);
        }
        return result;
    }

    /** Short display text of a token value (`#6c5ce7`, `16`, `Inter, sans-serif`). */
    private static display(value: TokenValue): string {
        switch (value.kind) {
            case "color":
            case "string":
                return value.value;
            case "dimension":
            case "number":
                return String(value.value);
            case "fontWeight":
                return value.italic ? `${value.value} italic` : String(value.value);
            case "fontFamily":
                return value.value.join(", ");
            default:
                return JSON.stringify(value.value);
        }
    }

    private async callJson(tool: string, args: Record<string, unknown>): Promise<unknown> {
        const result = await this.tools.call(tool, args);
        if (result.isError) {
            throw new Error(`${tool} failed: ${result.text.slice(0, 300)}`);
        }
        try {
            return JSON.parse(result.text);
        } catch {
            throw new Error(`${tool} returned no JSON`);
        }
    }

    private static array(value: unknown): Record<string, unknown>[] {
        return Array.isArray(value) ? value.filter((item) => item !== null && typeof item === "object") : [];
    }

    private static object(value: unknown): Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    }
}
