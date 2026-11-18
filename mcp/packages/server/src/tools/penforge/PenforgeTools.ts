import type { Tool } from "../../Tool";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { CaptureNodeScreenshotTool } from "./CaptureNodeScreenshotTool";
import { GenerateCodeHintsTool } from "./GenerateCodeHintsTool";
import { GetNodePropertiesTool } from "./GetNodePropertiesTool";
import { GetPrototypeGraphTool } from "./GetPrototypeGraphTool";
import { ListBoardsTool } from "./ListBoardsTool";
import { ListCanvasCommentsTool } from "./ListCanvasCommentsTool";
import { PenforgeOverviewTool } from "./PenforgeOverviewTool";
import { ResolveCanvasCommentTool } from "./ResolveCanvasCommentTool";
import { UpdateDesignNodeTool } from "./UpdateDesignNodeTool";
import { VisualQaTool } from "../../agent/qa/VisualQaTool";

/**
 * Factory of the Penforge typed MCP tools (architecture §6).
 */
export class PenforgeTools {
    /**
     * Names of the tools fixed by the architecture contract.
     */
    public static readonly CONTRACT_TOOL_NAMES = [
        "get_node_properties",
        "capture_node_screenshot",
        "update_design_node",
        "list_canvas_comments",
        "resolve_canvas_comment",
        "list_boards",
        "get_prototype_graph",
        "generate_code_hints",
    ] as const;

    /**
     * Creates all Penforge tools for the given server.
     *
     * @param mcpServer - the MCP server
     */
    public static create(mcpServer: PenpotMcpServer): Tool<any>[] {
        return [
            new PenforgeOverviewTool(mcpServer),
            new GetNodePropertiesTool(mcpServer),
            new CaptureNodeScreenshotTool(mcpServer),
            new UpdateDesignNodeTool(mcpServer),
            new ListCanvasCommentsTool(mcpServer),
            new ResolveCanvasCommentTool(mcpServer),
            new ListBoardsTool(mcpServer),
            new GetPrototypeGraphTool(mcpServer),
            new GenerateCodeHintsTool(mcpServer),
            // W18: visual QA for the AI chat; answers only while the Penforge daemon runs
            new VisualQaTool(mcpServer),
        ];
    }
}
