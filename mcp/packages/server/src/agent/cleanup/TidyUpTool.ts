import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import type { AgentContext, WorkflowContext, WorkflowToolsApi, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { Tool } from "../../Tool";
import { TextResponse, type ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { AgentConfig } from "../AgentConfig";
import { McpToolsClient } from "../tools/McpToolsClient";
import { WorkspaceManager } from "../workspace/WorkspaceManager";
import { CleanupError, ImportCleaner, describeCleanup, type CleanupTuning } from "../workflows/cleanup-import";
import type { CleanupProposal, CleanupResult } from "./types";

/** Arguments of `penforge_tidy_up`. */
export class TidyUpToolArgs {
    static schema = {
        fileId: z.string().min(1).max(128).describe("Id of the Penpot file open in the user's tab."),
        pageId: z.string().min(1).max(128).optional().describe("Page to tidy up; the current page by default."),
        nodeIds: z
            .array(z.string().min(1).max(128))
            .max(200)
            .optional()
            .describe("Tidy up only these layers and what is inside them. Omit for the whole page."),
        apply: z
            .boolean()
            .optional()
            .describe(
                "false (default) = only list the proposed changes and a planId. true = apply them (needs " +
                    "planId), after saving a checkpoint, each step checked with screenshots and taken back if the look changes."
            ),
        planId: z
            .string()
            .min(1)
            .max(64)
            .optional()
            .describe("With apply: the planId of the listing you checked; refused if the layers changed since."),
        skip: z
            .array(z.string().min(1).max(64))
            .max(500)
            .optional()
            .describe("With apply: ids of listed proposals to leave out."),
        componentNames: z
            .record(z.string().min(1).max(64), z.string().min(1).max(64))
            .optional()
            .describe('With apply: names of the components to make, e.g. {"C:<layer id>": "Task Card"}.'),
        removeHidden: z
            .boolean()
            .optional()
            .describe(
                "With apply: also delete the listed hidden / fully transparent layers. Only when the user " +
                    "asked for it; they are often states such as hover or error."
            ),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    fileId!: string;

    pageId?: string;

    nodeIds?: string[];

    apply?: boolean;

    skip?: string[];

    componentNames?: Record<string, string>;

    planId?: string;

    removeHidden?: boolean;

    sessionId?: string;
}

/**
 * MCP tool that lets the AI chat run the tidy-up (W17) of a page or of some layers: first it lists
 * the proposals (unused layers, rows/columns/grids to turn into layouts, look-alike items to turn
 * into components) and a plan id; Claude checks them with its own screenshots, then calls it again
 * with `apply: true`, the plan id and the ids to skip. Applying needs a checkpoint (W19) of the
 * file's Penforge project, keeps each step one undo block, takes back steps that change the look,
 * stops when the call is cancelled and after {@link TidyUpTool.BUDGET_MS}. Layers that still have
 * default names are listed for Claude to name.
 */
export class TidyUpTool extends Tool<TidyUpToolArgs> {
    /** time an applying call spends before it stops starting new steps */
    public static readonly BUDGET_MS = 4 * 60_000;

    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, TidyUpToolArgs.schema);
    }

    public getToolName(): string {
        return "penforge_tidy_up";
    }

    public getToolDescription(): string {
        return (
            "Penforge only. Tidies up a messy page or selection (often a Figma import): removes unused " +
            "layers (empty, zero size; hidden ones only on request), turns absolutely placed layers that line up into flex or grid " +
            "layouts with the same gaps and paddings, and makes components from look-alike items (texts and " +
            "images kept). Call it first without apply to list the proposed changes, check them, then call it " +
            "with apply: true (and skip / componentNames). Applying saves a checkpoint, makes each step one undo " +
            "block and takes back any step that changes how the design looks."
        );
    }

    protected async executeCore(args: TidyUpToolArgs, signal?: AbortSignal): Promise<ToolResponse> {
        const mcpUrl = `http://${this.mcpServer.host}:${this.mcpServer.port}/mcp`;
        const client = new McpToolsClient(mcpUrl);
        try {
            const tools = client.forSession(() => args.sessionId);
            const ctx = await TidyUpTool.context(
                args,
                tools,
                AgentConfig.load(process.env, mcpUrl).projectsDir,
                signal
            );
            return new TextResponse(await TidyUpTool.handle(ctx, args, { budgetMs: TidyUpTool.BUDGET_MS }));
        } finally {
            await client.close();
        }
    }

    /**
     * Lists or applies, and answers with the text for Claude.
     *
     * @param tuning - waits and budget (tests shorten them)
     */
    public static async handle(
        ctx: WorkflowContext,
        args: TidyUpToolArgs,
        tuning: CleanupTuning = {}
    ): Promise<string> {
        const params = {
            nodeIds: args.nodeIds,
            pageId: args.pageId,
            review: false,
            steps: { names: false },
        };
        if (args.apply !== true) {
            const result = await new ImportCleaner(ctx, { ...params, dryRun: true }, tuning).run();
            return TidyUpTool.describeProposals(result);
        }
        if (!args.planId) {
            return JSON.stringify({
                error: "plan-missing",
                message: "List the proposals first (call without apply) and pass their planId.",
            });
        }
        if (!ctx.workspace) {
            return JSON.stringify({
                error: "checkpoint-failed",
                message:
                    "Nothing was changed: the file is not in a Penforge project yet, so no checkpoint can be saved. " +
                    "Ask the user to reopen the file with the AI tab connected.",
            });
        }
        const cleaner = new ImportCleaner(
            ctx,
            {
                ...params,
                skip: args.skip ?? [],
                componentNames: args.componentNames ?? {},
                expectedPlan: args.planId,
                removeHidden: args.removeHidden === true,
            },
            tuning
        );
        let result: CleanupResult;
        try {
            result = await cleaner.run();
        } catch (error) {
            if (error instanceof CleanupError) {
                return JSON.stringify({ error: error.code, message: TidyUpTool.errorText(error) });
            }
            throw error;
        }
        const unnamed = await cleaner.defaultNamedLayers().catch(() => []);
        return TidyUpTool.describeApplied(result, unnamed);
    }

    private static errorText(error: CleanupError): string {
        switch (error.code) {
            case "plan-changed":
                return "The layers changed since the listing: nothing was changed. List the proposals again and check them.";
            case "busy":
                return "A tidy-up of this file is already running: nothing was changed. Wait for it to finish.";
            case "checkpoint-failed":
                return `Nothing was changed: the checkpoint could not be saved (${error.message}).`;
            default:
                return error.message;
        }
    }

    /** Context of a run outside a client session: no Claude turns, no questions. */
    public static async context(
        args: TidyUpToolArgs,
        tools: WorkflowToolsApi,
        projectsDir: string,
        signal?: AbortSignal
    ): Promise<WorkflowContext> {
        const workspace = await TidyUpTool.findWorkspace(projectsDir, args.fileId);
        const context = {
            fileId: args.fileId,
            fileName: "",
            projectId: "",
            teamId: "",
            pageId: args.pageId ?? "",
            persona: "designer",
            platform: "web",
            mcpSessionId: args.sessionId,
        } as unknown as AgentContext;
        return {
            runId: `chat-tidy-up-${Date.now()}`,
            context,
            workspace: workspace as WorkflowWorkspaceApi,
            tools,
            signal: signal ?? new AbortController().signal,
            emit: () => {},
            ask: () => Promise.reject(new Error("No questions while tidying up from the chat")),
            runner: { run: () => Promise.reject(new Error("No Claude turns while tidying up from the chat")) },
        } as WorkflowContext;
    }

    /**
     * The workspace of the Penforge project whose `.penforge/project.json` lists the file, or
     * undefined (then nothing is applied: no checkpoint can be saved).
     */
    public static async findWorkspace(projectsDir: string, fileId: string): Promise<WorkflowWorkspaceApi | undefined> {
        let names: string[];
        try {
            names = (await readdir(projectsDir, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
        } catch {
            return undefined;
        }
        let found: { projectId: string; updatedAt: string } | null = null;
        for (const name of names) {
            try {
                const info = JSON.parse(await readFile(join(projectsDir, name, ".penforge", "project.json"), "utf8"));
                if (Array.isArray(info?.fileIds) && info.fileIds.includes(fileId)) {
                    const updatedAt = String(info.updatedAt ?? "");
                    if (!found || updatedAt > found.updatedAt) {
                        found = { projectId: name, updatedAt };
                    }
                }
            } catch {
                // not a project folder
            }
        }
        return found ? new WorkspaceManager(projectsDir).get(found.projectId) : undefined;
    }

    /** Text answer of a listing call. */
    public static describeProposals(result: CleanupResult): string {
        const proposals = result.proposals ?? [];
        if (proposals.length === 0) {
            return JSON.stringify({ page: result.pageName, proposals: [], message: "Nothing to tidy up." });
        }
        return (
            JSON.stringify({
                page: result.pageName,
                planId: result.planId,
                truncated: result.truncated,
                proposals: proposals.map(TidyUpTool.line),
                hiddenLayers: { count: result.hidden.count, names: result.hidden.names },
            }) +
            "\nCheck the proposals (take a screenshot of the boards if unsure). Skip rows/columns that only line up " +
            "by chance and look-alike items that are not the same thing. Proposals marked onlyOnRequest delete " +
            "hidden layers: they are kept unless you pass removeHidden: true, which you do only when the user asked " +
            "to delete hidden layers. Then call penforge_tidy_up again with the same fileId/pageId/nodeIds, " +
            "apply: true, this planId, the ids to skip and a short Title Case name for every component you keep."
        );
    }

    /** Text answer of an applying call. */
    public static describeApplied(
        result: CleanupResult,
        unnamed: { id: string; name: string; type: string; parent: string | null; text?: string }[]
    ): string {
        const report = {
            summary: describeCleanup(result),
            checkpoint: result.checkpoint ? `#${result.checkpoint.n}` : null,
            totals: result.totals,
            boards: result.units
                .filter((unit) => unit.junkRemoved + unit.layoutsApplied + unit.layoutsReverted + unit.junkReverted > 0)
                .map((unit) => ({
                    name: unit.name,
                    removed: unit.junkRemoved,
                    layouts: unit.layouts.map(
                        (layout) => `${layout.name} (${layout.type}${layout.dir ? ` ${layout.dir}` : ""})`
                    ),
                    takenBack: unit.layoutsReverted + unit.junkReverted,
                })),
            components: result.components,
            hiddenLayers: result.hidden,
            stopped: result.stopped,
            unnamedLayers: unnamed,
        };
        const advice = [
            result.stopped
                ? "The tidy-up stopped early (time limit); say so, and that running it again does the rest."
                : "",
            unnamed.length > 0
                ? "Give the listed unnamed layers short role names (Title Case, English unless the design's text is " +
                  "in another language) with one execute_code call wrapped in one undo block, then tell the user " +
                  "what changed per board in plain words."
                : "Tell the user what changed per board in plain words.",
        ]
            .filter((line) => line.length > 0)
            .join(" ");
        return `${JSON.stringify(report)}\n${advice}`;
    }

    private static line(proposal: CleanupProposal): Record<string, unknown> {
        switch (proposal.kind) {
            case "junk":
                return {
                    id: proposal.id,
                    kind: "junk",
                    layer: proposal.name,
                    layerId: proposal.nodeId,
                    reason: proposal.reason,
                    ...(proposal.reason === "hidden" || proposal.reason === "transparent"
                        ? { onlyOnRequest: true }
                        : {}),
                };
            case "layout": {
                const layout = proposal.layout;
                return {
                    id: proposal.id,
                    kind: "layout",
                    layer: proposal.name,
                    layerId: proposal.nodeId,
                    group: proposal.convert,
                    change:
                        layout.type === "flex"
                            ? `flex ${layout.dir}, gap ${layout.gap}, align ${layout.align}, ${layout.order.length} items`
                            : `grid ${layout.columns.length}x${layout.rows.length}, gaps ${layout.columnGap}/${layout.rowGap}`,
                };
            }
            case "component":
                return {
                    id: proposal.id,
                    kind: "component",
                    name: proposal.name,
                    count: proposal.memberIds.length,
                    layerIds: proposal.memberIds.slice(0, 10),
                    size: `${Math.round(proposal.width)}x${Math.round(proposal.height)}`,
                };
        }
    }
}
