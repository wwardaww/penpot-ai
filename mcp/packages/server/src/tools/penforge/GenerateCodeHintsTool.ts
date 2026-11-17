import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";
import { PenforgeSchemas } from "./PenforgeSchemas";

/**
 * Arguments of {@link GenerateCodeHintsTool}.
 */
export class GenerateCodeHintsArgs {
    static schema = {
        nodeId: PenforgeSchemas.NODE_ID.describe("Id of the node to generate code for."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    nodeId!: string;

    sessionId?: string;
}

/**
 * Generates Penpot's HTML and CSS for a node as a starting point for app code.
 */
export class GenerateCodeHintsTool extends PenforgePluginTool<GenerateCodeHintsArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, GenerateCodeHintsArgs.schema);
    }

    public getToolName(): string {
        return "generate_code_hints";
    }

    public getToolDescription(): string {
        return (
            "Generates Penpot's code export for a node and its children: `{nodeId, name, type, pageId, html, " +
            "css, fontFaces}`. Use it as a hint for structure and exact styles when writing app code, not as " +
            "final code."
        );
    }

    protected async executeCore(args: GenerateCodeHintsArgs): Promise<ToolResponse> {
        const data = await this.callPlugin("generateCodeHints", { nodeId: args.nodeId }, args.sessionId);
        return PenforgePluginTool.json(data);
    }
}
