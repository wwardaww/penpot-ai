import { Task, TaskHandler } from "../TaskHandler";
import { ExecuteCodeTaskParams, ExecuteCodeTaskResultData } from "../../../common/src";
import { PenpotUtils } from "../PenpotUtils.ts";
import { ExecuteCodeTaskConsole } from "../ExecuteCodeTaskConsole.ts";
import { formatTaskError } from "../ErrorUtils.ts";
import { CanvasSnapshot } from "../penforge/canvasSnapshot.ts";
import { LayoutCheck } from "../penforge/layoutCheck.ts";

/**
 * Task handler for executing JavaScript code in the plugin context.
 *
 * Maintains a persistent context object that preserves state between code executions
 * and captures all console output during execution.
 */
export class ExecuteCodeTaskHandler extends TaskHandler<ExecuteCodeTaskParams> {
    readonly taskType = "executeCode";

    /**
     * Persistent context object that maintains state between code executions.
     * Contains the penpot API, storage object, and custom console implementation.
     */
    private readonly context: any;

    /** Ids of the top-level boards that checked code drew on, the most recent last. */
    private checkedBoards: string[] = [];

    constructor() {
        super();

        // initialize context, making penpot, penpotUtils, storage and the custom console available
        this.context = {
            penpot: penpot,
            penpotMgmt: typeof penpotMgmt === "undefined" ? null : penpotMgmt,
            storage: {},
            console: new ExecuteCodeTaskConsole(),
            penpotUtils: PenpotUtils,
        };
    }

    async handle(task: Task<ExecuteCodeTaskParams>): Promise<void> {
        if (!task.params.code) {
            task.sendError("executeCode task requires 'code' parameter");
            return;
        }

        this.context.console.resetLog();

        const context = this.context;
        const code = task.params.code;

        // set the flags naturalChildOrdering and throwValidationErrors to true during code execution.
        let originalNaturalChildOrdering: any, originalThrowValidationErrors: any;
        if (!penpot.flags || typeof penpot.waitForSave !== "function") {
            throw new Error(
                "The connected Penpot build is missing Plugin API support that this MCP " +
                    "plugin needs (for example `penpot.waitForSave`), or the MCP plugin is " +
                    "too new for that Penpot. Upgrade Penpot (and its plugins-runtime) so " +
                    "they match this MCP version. " +
                    "Read the documentation for instructions on which version to use: " +
                    "https://github.com/penpot/penpot/tree/develop/mcp\n" +
                    "If you are an LLM, tell the user about this!"
            );
        }

        originalNaturalChildOrdering = penpot.flags.naturalChildOrdering;
        penpot.flags.naturalChildOrdering = true;
        originalThrowValidationErrors = penpot.flags.throwValidationErrors;
        penpot.flags.throwValidationErrors = true;

        // Layout and save waits only apply with a ready workspace: on the dashboard (or while a file
        // loads) no edit of this call can be pending. Checked at each wait, since the code may navigate.
        const management = this.context.penpotMgmt;
        const workspaceReady = () => !management || management.workspace.status === "ready";

        let result: any;
        let before: CanvasSnapshot | null = null;
        PenpotUtils.takeWarnings();
        try {
            // wait for layout updates prior to executing the supplied code (if method is available)
            try {
                // @ts-ignore - TODO Penpot.waitForLayoutUpdate is not yet in the released types
                if (workspaceReady() && penpot.waitForLayoutUpdate) {
                    // @ts-ignore
                    await penpot.waitForLayoutUpdate();
                }
            } catch (e) {
                console.error("Error waiting for layout update:", e);
            }

            before = task.params.trackShapes && workspaceReady() ? ExecuteCodeTaskHandler.snapshot() : null;

            // execute the code in an async function with the context variables as parameters
            result = await (async (ctx) => {
                const fn = new Function(...Object.keys(ctx), `return (async () => { ${code} })();`);
                return fn(...Object.values(ctx));
            })(context);
        } catch (error) {
            const left = ExecuteCodeTaskHandler.leftBehind(before);
            if (left === null) {
                throw error;
            }
            throw new Error(`${formatTaskError(error)}\n${left}`);
        } finally {
            // restore the original value of the flags
            penpot.flags.naturalChildOrdering = originalNaturalChildOrdering;
            penpot.flags.throwValidationErrors = originalThrowValidationErrors;
        }

        console.log("Code execution result:", result);

        // transform a top-level Uint8Array result into a compact base64 envelope to avoid the
        // ~10x JSON expansion that occurs when JSON.stringify serializes typed arrays as objects
        // with numeric string keys (see penpot/penpot#9420)
        if (result instanceof Uint8Array) {
            result = ExecuteCodeTaskHandler.encodeBytesAsBase64Envelope(result);
        }

        // Wait for the save outside any swallow catch: a failed or rolled-back save must fail the task.
        if (workspaceReady()) {
            await penpot.waitForSave();
        }

        // return result and captured log
        let resultData: ExecuteCodeTaskResultData<any> = {
            result: result,
            log: this.context.console.getLog(),
        };
        const warnings = PenpotUtils.takeWarnings();
        if (warnings.length > 0) {
            resultData.warnings = warnings;
        }
        if (task.params.checkLayout && before) {
            resultData.layoutProblems = await this.checkLayout(before);
        }
        task.sendSuccess(resultData);
    }

    /** Lists the shapes of the page, or null when there is none to list. */
    private static snapshot(): CanvasSnapshot | null {
        try {
            return penpot.root ? CanvasSnapshot.take(penpot) : null;
        } catch (e) {
            console.error("Error listing the shapes of the page:", e);
            return null;
        }
    }

    /**
     * Names the shapes a failed script added, which Penpot keeps.
     *
     * @param before - the page before the script
     * @returns the note, or null when the script added none
     */
    private static leftBehind(before: CanvasSnapshot | null): string | null {
        try {
            const added = before?.added(penpot) ?? [];
            if (added.length === 0) {
                return null;
            }
            const names = added.slice(0, 10).map((shape) => `${shape.type} "${shape.name}" ${shape.id}`);
            const more = added.length > names.length ? ` and ${added.length - names.length} more` : "";
            return (
                "The script was not rolled back. Shapes it added before the error, still there: " +
                `${names.join(", ")}${more}. Remove them by id (penpotUtils.findShapeById(id).remove()) or go on ` +
                "with them; do not make them a second time."
            );
        } catch (e) {
            console.error("Error listing the shapes a script left:", e);
            return null;
        }
    }

    /**
     * Checks the boards this and earlier checked code drew on.
     *
     * @param before - the page before the code
     */
    private async checkLayout(before: CanvasSnapshot): Promise<string[]> {
        try {
            await penpot.waitForLayoutUpdate();
            const added = before.added(penpot);
            const tops = new Map<string, any>((penpot.root as any).children.map((shape: any) => [shape.id, shape]));
            for (const shape of added) {
                let top: any = shape;
                while (top && !tops.has(top.id)) {
                    top = top.parent;
                }
                if (top?.type === "board") {
                    this.checkedBoards = [...this.checkedBoards.filter((id) => id !== top.id), top.id];
                }
            }
            this.checkedBoards = this.checkedBoards.filter((id) => tops.has(id));
            return new LayoutCheck(penpot).run(
                this.checkedBoards.map((id) => tops.get(id)),
                added
            );
        } catch (e) {
            console.error("Error checking the layout:", e);
            return [];
        }
    }

    /**
     * Base64-encodes the given bytes and wraps the result in a tagged envelope that the
     * server side recognizes (see `ImageContent.byteData`).
     *
     * @param bytes - the raw binary data to encode
     * @returns an envelope of the form `{ __type: "base64", data: <base64 string> }`
     */
    private static encodeBytesAsBase64Envelope(bytes: Uint8Array): { __type: "base64"; data: string } {
        // build the binary string in chunks; calling `String.fromCharCode(...bytes)` directly
        // would overflow the call stack for large arrays
        const chunkSize = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
        }
        return { __type: "base64", data: btoa(binary) };
    }
}
