import { z } from "zod";
import { Tool } from "../Tool";
import type { ToolResponse } from "../ToolResponse";
import { TextResponse } from "../ToolResponse";
import "reflect-metadata";
import { PenpotMcpServer } from "../PenpotMcpServer";
import { ExecuteCodePluginTask } from "../tasks/ExecuteCodePluginTask";
import { ExecuteCodeTaskParams } from "@penpot/mcp-common";

/**
 * Arguments class for ExecuteCodeTool
 */
export class ExecuteCodeArgs {
    static schema = {
        code: z
            .string()
            .min(1, "Code cannot be empty")
            .describe("The JavaScript code to execute in the plugin context."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    /**
     * The JavaScript code to execute in the plugin context.
     */
    code!: string;

    sessionId?: string;
}

/**
 * Tool for executing JavaScript code in the Penpot plugin context
 */
export class ExecuteCodeTool extends Tool<ExecuteCodeArgs> {
    /**
     * Run time from which a call gets a note to split the work: the Penpot tab cannot redraw or
     * answer the user while the code runs.
     */
    public static readonly SLOW_CALL_MS = 8000;

    /**
     * Creates a new ExecuteCode tool instance.
     *
     * @param mcpServer - The MCP server instance
     */
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, ExecuteCodeArgs.schema);
    }

    public getToolName(): string {
        return "execute_code";
    }

    public getToolDescription(): string {
        return (
            "Executes JavaScript code in the Penpot plugin context.\n" +
            "IMPORTANT: Before using this tool, make sure you have read the 'Penpot High-Level Overview' and know " +
            "which Penpot API functionality is necessary and how to use it.\n" +
            "You have access to `penpot` (of type `Penpot`), `penpotMgmt` (of type `PenpotMgmt`), `penpotUtils`, and `storage`.\n" +
            "If `penpotMgmt` is null, file management is unavailable and only the open file can be used.\n" +
            "`storage` is an object in which arbitrary data can be stored, simply by adding a new attribute; " +
            "stored attributes can be referenced in future calls to this tool, so any intermediate results that " +
            "could come in handy later should be stored in `storage` instead of just a fleeting variable; " +
            "you can also store functions and thus build up a library).\n" +
            "Think of the code being executed as the body of a function: " +
            "The tool call returns whatever you return in the applicable `return` statement, if any. " +
            "You can return arbitrary JS objects; no need to apply JSON.stringify.\n" +
            "If an exception occurs, the exception's message will be returned to you.\n" +
            "Any output that you generate via the `console` object will be returned to you separately; so you may use it " +
            "to track what your code is doing, but you should *only* do so only if there is an ACTUAL NEED for this! " +
            "VERY IMPORTANT: Don't use logging prematurely! NEVER log the data you are returning, as you will otherwise receive it twice!\n" +
            "VERY IMPORTANT: In general, try a simple approach first, and only if it fails, try more complex code that involves " +
            "handling different cases (in particular error cases) and that applies logging.\n" +
            "VERY IMPORTANT: The Penpot tab is frozen for the user while your code runs, and every shape you create or " +
            "change costs about 20 ms. Keep each call short (at most one screen, or one section of a long screen, per " +
            "call) and split bigger work across several calls."
        );
    }

    protected async executeCore(args: ExecuteCodeArgs): Promise<ToolResponse> {
        const taskParams: ExecuteCodeTaskParams = { code: args.code };
        const task = new ExecuteCodePluginTask(taskParams);
        const started = Date.now();
        const result = await this.mcpServer.pluginBridge.executePluginTask(task, args.sessionId);
        const note = ExecuteCodeTool.slowCallNote(Date.now() - started);

        const text =
            result.data !== undefined
                ? JSON.stringify(result.data, null, 2)
                : "Code executed successfully with no return value.";
        return new TextResponse(note ? `${text}\n\n${note}` : text);
    }

    /**
     * Note for a call that ran {@link SLOW_CALL_MS} or longer, or null.
     *
     * @param elapsedMs - how long the call took, in ms
     */
    public static slowCallNote(elapsedMs: number): string | null {
        if (elapsedMs < ExecuteCodeTool.SLOW_CALL_MS) {
            return null;
        }
        const seconds = Math.round(elapsedMs / 1000);
        return (
            `NOTE: this call kept the Penpot tab frozen for ${seconds} s; the user could not scroll or click ` +
            "meanwhile. Split the remaining work into smaller calls (at most one screen per call)."
        );
    }
}
