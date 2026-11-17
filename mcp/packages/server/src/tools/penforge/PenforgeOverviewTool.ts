import { EmptyToolArgs, Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import { TextResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";

/**
 * Returns the short guide to the Penforge typed tools.
 */
export class PenforgeOverviewTool extends Tool<EmptyToolArgs> {
    /**
     * The guide text (Markdown). Kept in code so the bundled server needs no extra resource file.
     */
    public static readonly GUIDE = `# Penforge typed tools

Prefer these tools over \`execute_code\`. They are deterministic, validate their input and keep
undo and sync working. Use \`execute_code\` only for what they cannot do (creating shapes,
components, flows, bulk edits), after reading the 'Penpot High-Level Overview'.

## Read
- \`get_node_properties {nodeId, depth?=1}\`: full snapshot of one node: geometry, constraints,
  layout, layoutChild, fills, strokes, shadows, radius, text (content, typography, spans), tokens,
  component/variant info, interactions, children. \`depth: 2\` returns children in full too.
- \`list_boards {pageId?}\`: top-level boards (screens) with size, flows they start, interactions.
- \`get_prototype_graph {}\`: pages, flows, boards and board-to-board navigation edges.
- \`list_canvas_comments {pageId?, status?="unresolved"}\`: comment threads with their comments.
- \`generate_code_hints {nodeId}\`: Penpot's HTML + CSS export of a node (a hint, not final code).

## See
- \`capture_node_screenshot {nodeId | "selection" | "page", scale?=2, format?="png", padding?}\`:
  look at the result after each visual change.

## Change
- \`update_design_node {nodeId, mutations}\`: only these keys: name, text, fills, strokes, x, y,
  width, height, visible, opacity, radius, layout, layoutChild, tokens. Values use the format of
  \`get_node_properties\` (e.g. \`fills: [{color: "#1A2B3C", opacity: 1}]\`). All changes form one
  undo step. The result holds the new snapshot: check it instead of reading the node again.
- \`resolve_canvas_comment {threadId, resolutionNote?}\`: reply with what you changed, then resolve.

## Workflow
1. Find the node: \`list_boards\`, then \`get_node_properties\` on a board (children summary).
2. Change it with \`update_design_node\`.
3. Check it with \`capture_node_screenshot\`.
4. For comment work: \`list_canvas_comments\` -> fix -> \`resolve_canvas_comment\` with a short note.
`;

    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, EmptyToolArgs.schema);
    }

    public getToolName(): string {
        return "penforge_overview";
    }

    public getToolDescription(): string {
        return (
            "Returns a short guide to the Penforge typed tools (read, see and change design nodes, " +
            "comments, prototype graph). Read it once before working on a design."
        );
    }

    protected async executeCore(_args: EmptyToolArgs): Promise<ToolResponse> {
        return new TextResponse(PenforgeOverviewTool.GUIDE);
    }
}
