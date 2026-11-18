import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import { DesignToolFilter } from "../tools/DesignToolFilter";

/**
 * "Wire prototype" (W27): proposes prototype links between the screens of a page from layer names
 * and texts ("Add", "+", "Back", "Save", tab bar items), and applies the links the user confirms.
 *
 * Without `apply` the workflow reads the page's screens and their layers, asks Claude for links
 * and reports them as a `result` event (`{mode: "proposal", ...}`); nothing changes. With `apply`
 * it applies the given `links` and `flow` through the `update_prototype` tool, in one undo step,
 * and reports `{mode: "applied", ...}`. It never removes or replaces an existing interaction:
 * proposals on layers that already have a click interaction are dropped, and the tool reports a
 * clash as `conflict` without applying it.
 */

/** Action of a proposed link. */
export type LinkAction = "navigate-to" | "previous-screen" | "open-overlay" | "close-overlay";

/** One proposed or confirmed link. */
export interface WireLink {
    sourceId: string;
    action: LinkAction;
    /** target board, for navigate-to and open-overlay */
    destinationId?: string | null;
    sourceName?: string;
    boardId?: string;
    boardName?: string;
    destinationName?: string | null;
    /** why Claude proposes it, in a few words */
    reason?: string;
}

/** Flow the page should have. */
export interface WireFlow {
    name: string;
    startingBoardId: string;
    startingBoardName?: string;
}

/** Params of the `wire-prototype` workflow. */
export interface WirePrototypeParams {
    /** page to wire; default: the tab's page */
    pageId?: string;
    /** only these screens (top-level boards); default: all screens of the page */
    boardIds?: string[];
    /** apply `links` and `flow` instead of proposing */
    apply?: boolean;
    links?: WireLink[];
    flow?: WireFlow | null;
}

/** Layer of a screen that may start a link. */
export interface LayerInfo {
    id: string;
    name: string;
    type: string;
    text: string | null;
    boardId: string;
    /** the layer already has a click interaction */
    linked: boolean;
}

/** Screen (top-level board) of the page. */
export interface ScreenInfo {
    id: string;
    name: string;
    width: number;
    height: number;
    layers: LayerInfo[];
}

/** What the workflow read from the page. */
export interface PageInfo {
    pageId: string;
    pageName: string;
    screens: ScreenInfo[];
    flows: { name: string; startingBoardId: string | null }[];
}

const ACTIONS: LinkAction[] = ["navigate-to", "previous-screen", "open-overlay", "close-overlay"];

/**
 * Plugin code that reads the screens of a page and their candidate layers. Parameters are embedded
 * as a JSON literal, never as code.
 *
 * @param pageId - page to read, or null for the current page
 * @param boardIds - screens to read, or null for all
 */
export function readPageCode(pageId: string | null, boardIds: string[] | null): string {
    const params = JSON.stringify({ pageId, boardIds, maxLayers: 120, maxDepth: 8 });
    return `const params = ${params};
const pages = penpot.currentFile ? penpot.currentFile.pages : [];
const page = params.pageId ? pages.find((p) => p.id === params.pageId) : penpot.currentPage;
if (!page) { throw new Error("Page not found: " + params.pageId); }
const roots = (page.root && page.root.children) || [];
const boards = roots.filter((s) => s.type === "board" && (!params.boardIds || params.boardIds.includes(s.id)));
const screens = boards.map((board) => {
  const layers = [];
  const walk = (shape, depth) => {
    if (layers.length >= params.maxLayers || depth > params.maxDepth || shape.hidden) { return; }
    if (shape !== board) {
      const text = shape.type === "text" ? String(shape.characters || "").slice(0, 60) : null;
      const linked = (shape.interactions || []).some((i) => i.trigger === "click");
      layers.push({ id: shape.id, name: shape.name, type: shape.type, text, boardId: board.id, linked });
    }
    for (const child of shape.children || []) { walk(child, depth + 1); }
  };
  walk(board, 0);
  return { id: board.id, name: board.name, width: Math.round(board.width), height: Math.round(board.height), layers };
});
const flows = (page.flows || []).map((f) => ({ name: f.name, startingBoardId: f.startingBoard ? f.startingBoard.id : null }));
return JSON.stringify({ pageId: page.id, pageName: page.name, screens, flows });`;
}

/**
 * Builds the user prompt of the proposal turn.
 *
 * @param info - the page read from the design
 */
export function buildPrompt(info: PageInfo): string {
    const lines: string[] = [`Page "${info.pageName}". Screens and their layers (id | type | name | text):`];
    for (const screen of info.screens) {
        lines.push("", `## Screen "${screen.name}" id=${screen.id} (${screen.width}x${screen.height})`);
        for (const layer of screen.layers) {
            const text = layer.text ? ` | "${layer.text}"` : "";
            const linked = layer.linked ? " | already linked" : "";
            lines.push(`- ${layer.id} | ${layer.type} | ${layer.name}${text}${linked}`);
        }
    }
    lines.push(
        "",
        info.flows.length > 0
            ? `Existing flows: ${info.flows.map((f) => `"${f.name}" starts at ${f.startingBoardId}`).join("; ")}`
            : "The page has no flow yet."
    );
    return lines.join("\n");
}

/**
 * Parses and checks Claude's answer: keeps links whose source is a known, unlinked layer and whose
 * destination is a screen of the page, drops duplicates and fills in names.
 *
 * @param text - Claude's answer (the last JSON object in it is read)
 * @param info - the page read from the design
 */
export function parseProposal(text: string, info: PageInfo): { links: WireLink[]; flow: WireFlow | null } {
    const json = lastJsonObject(text);
    const screens = new Map(info.screens.map((s) => [s.id, s]));
    const layers = new Map(info.screens.flatMap((s) => s.layers).map((l) => [l.id, l]));
    const links: WireLink[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(json?.links) ? json.links : []) {
        const layer = layers.get(String(raw?.sourceId ?? ""));
        const action = raw?.action as LinkAction;
        if (!layer || layer.linked || !ACTIONS.includes(action) || seen.has(layer.id)) {
            continue;
        }
        const needsDestination = action === "navigate-to" || action === "open-overlay";
        const destination = needsDestination ? screens.get(String(raw?.destinationId ?? "")) : undefined;
        if (needsDestination && (!destination || destination.id === layer.boardId)) {
            continue;
        }
        seen.add(layer.id);
        links.push({
            sourceId: layer.id,
            sourceName: layer.name,
            boardId: layer.boardId,
            boardName: screens.get(layer.boardId)?.name ?? "",
            action,
            destinationId: destination?.id ?? null,
            destinationName: destination?.name ?? null,
            reason: typeof raw?.reason === "string" ? raw.reason.slice(0, 160) : "",
        });
    }
    let flow: WireFlow | null = null;
    const rawFlow = json?.flow;
    const start = rawFlow ? screens.get(String(rawFlow.startingBoardId ?? "")) : undefined;
    if (start && info.flows.length === 0) {
        const name =
            typeof rawFlow.name === "string" && rawFlow.name.trim() ? rawFlow.name.trim().slice(0, 80) : "Main";
        flow = { name, startingBoardId: start.id, startingBoardName: start.name };
    }
    return { links, flow };
}

/**
 * Turns confirmed links and flow into `update_prototype` operations.
 *
 * @param links - confirmed links
 * @param flow - flow to create or move, or null
 */
export function buildOperations(links: WireLink[], flow: WireFlow | null | undefined): Record<string, unknown>[] {
    const operations: Record<string, unknown>[] = [];
    for (const link of links) {
        if (!ACTIONS.includes(link.action)) {
            throw new Error(`Unknown link action: ${String(link.action)}`);
        }
        const action: Record<string, unknown> = { type: link.action };
        if (link.action === "navigate-to" || link.action === "open-overlay") {
            if (!link.destinationId) {
                throw new Error(`Link from ${link.sourceId} needs a destination`);
            }
            action.destinationId = link.destinationId;
        }
        if (link.action === "navigate-to") {
            action.animation = { type: "dissolve", duration: 200, easing: "ease-out" };
        }
        operations.push({ op: "add-interaction", sourceId: link.sourceId, trigger: "click", action });
    }
    if (flow) {
        operations.push({ op: "set-flow", name: flow.name, startingBoardId: flow.startingBoardId });
    }
    return operations;
}

function lastJsonObject(text: string): any {
    const end = text.lastIndexOf("}");
    for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
        try {
            return JSON.parse(text.slice(start, end + 1));
        } catch {
            // keep looking for an earlier opening brace
        }
    }
    return null;
}

function parseToolJson(text: string, what: string): any {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${what}: ${text.slice(0, 300)}`);
    }
}

async function propose(ctx: WorkflowContext, params: WirePrototypeParams): Promise<Record<string, unknown>> {
    const read = await ctx.tools.call("execute_code", {
        code: readPageCode(params.pageId ?? null, params.boardIds?.length ? params.boardIds : null),
    });
    if (read.isError) {
        throw new Error(`Could not read the page: ${read.text.slice(0, 300)}`);
    }
    const envelope = parseToolJson(read.text, "Could not read the page");
    const value = envelope && typeof envelope === "object" && "result" in envelope ? envelope.result : envelope;
    const info: PageInfo = typeof value === "string" ? parseToolJson(value, "Could not read the page") : value;
    if (!info || !Array.isArray(info.screens) || info.screens.length < 2) {
        return {
            mode: "proposal",
            pageId: info?.pageId ?? params.pageId ?? null,
            links: [],
            flow: null,
            reason: "needs-two-screens",
        };
    }
    ctx.emit("progress", { text: "Finding the links between screens" });
    const answer = await ctx.runner.run({
        prompt: buildPrompt(info),
        promptName: "wire-prototype",
        // the proposal only reads; links change only after the user confirms them
        toolFilter: new DesignToolFilter(ctx.workspace.root, null, "Only propose links; do not change the design."),
    });
    const { links, flow } = parseProposal(answer.text, info);
    return { mode: "proposal", pageId: info.pageId, pageName: info.pageName, links, flow, existingFlows: info.flows };
}

async function apply(ctx: WorkflowContext, params: WirePrototypeParams): Promise<Record<string, unknown>> {
    const operations = buildOperations(params.links ?? [], params.flow);
    if (operations.length === 0) {
        return { mode: "applied", pageId: params.pageId ?? null, results: [] };
    }
    const args: Record<string, unknown> = { operations };
    const result = await ctx.tools.call("update_prototype", args);
    if (result.isError) {
        throw new Error(`Could not wire the prototype: ${result.text.slice(0, 300)}`);
    }
    const data = parseToolJson(result.text, "Could not wire the prototype");
    return { mode: "applied", pageId: data.pageId, undoGrouped: data.undoGrouped, results: data.results ?? [] };
}

/**
 * Summary line of a run, for `workflow.done`.
 *
 * @param result - the reported result
 */
export function describeResult(result: Record<string, any>): string {
    if (result.mode === "applied") {
        const results: any[] = result.results ?? [];
        const links = results.filter((r) => r.op !== "set-flow");
        const count = (status: string) => links.filter((r) => r.status === status).length;
        const conflicts = count("conflict");
        const flow = results.some((r) => r.op === "set-flow" && r.status !== "skipped") ? "; flow set" : "";
        return `Wired ${count("added") + count("updated")} prototype link(s)${conflicts ? `; ${conflicts} left as they were` : ""}${flow}`;
    }
    if (result.reason === "needs-two-screens") {
        return "The page needs at least two screens to wire";
    }
    return `Proposed ${(result.links ?? []).length} prototype link(s)`;
}

/** The `wire-prototype` workflow. */
export const workflow: Workflow<WirePrototypeParams> = {
    name: "wire-prototype",
    description: "Propose prototype links between the screens of a page and apply the confirmed ones.",
    run: async (ctx, params) => {
        const p = params ?? {};
        const result = p.apply ? await apply(ctx, p) : await propose(ctx, p);
        ctx.emit("result", result);
        return { summary: describeResult(result) };
    },
};
