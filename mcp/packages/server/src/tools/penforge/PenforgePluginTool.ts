import { Tool } from "../../Tool";
import { TextResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { ExecuteCodePluginTask } from "../../tasks/ExecuteCodePluginTask";
import type { z } from "zod";

/**
 * Base class of the Penforge typed tools that run in the plugin.
 *
 * Each tool calls exactly one method of the plugin-side `penpotUtils.penforge` helper
 * (`mcp/packages/plugin/src/penforge/PenforgeApi.ts`) with one JSON parameter object. The call
 * travels as an `executeCode` task, so no new plugin task type is needed and undo, rollback
 * notices and session routing work as for `execute_code`.
 */
export abstract class PenforgePluginTool<TArgs extends object> extends Tool<TArgs> {
    private static readonly METHOD_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

    protected constructor(mcpServer: PenpotMcpServer, inputSchema: z.ZodRawShape) {
        super(mcpServer, inputSchema);
    }

    /**
     * Builds the plugin code that calls a `penpotUtils.penforge` method.
     *
     * Parameters are embedded as a JSON literal, which is valid JavaScript, so no user input is
     * ever interpolated as code.
     *
     * @param method - name of the `PenforgeApi` method
     * @param params - the parameter object (must be JSON-serializable)
     */
    public static buildCode(method: string, params: object): string {
        if (!PenforgePluginTool.METHOD_NAME.test(method)) {
            throw new Error(`Invalid Penforge plugin method name: ${method}`);
        }
        return (
            "if (!penpotUtils.penforge) { throw new Error(" +
            JSON.stringify(
                "The connected Penpot MCP plugin has no Penforge helpers. Rebuild the plugin " +
                    "(mcp/packages/plugin) and reconnect it."
            ) +
            "); }\n" +
            `return await penpotUtils.penforge.${method}(${JSON.stringify(params)});`
        );
    }

    /**
     * Calls a `penpotUtils.penforge` method in the plugin and returns its result.
     *
     * @param method - name of the `PenforgeApi` method
     * @param params - the parameter object
     * @param sessionId - optional Penpot session to route the call to
     */
    protected async callPlugin<T>(method: string, params: object, sessionId?: string): Promise<T> {
        const task = new ExecuteCodePluginTask({ code: PenforgePluginTool.buildCode(method, params) });
        const result = await this.mcpServer.pluginBridge.executePluginTask(task, sessionId);
        return result.data?.result as T;
    }

    /**
     * Wraps a JSON-serializable value in a compact text response.
     *
     * @param value - the value to return
     */
    protected static json(value: unknown): TextResponse {
        return new TextResponse(JSON.stringify(value ?? null));
    }
}
