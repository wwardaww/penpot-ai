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
import { ImportCleaner, describeCleanup } from "../workflows/cleanup-import";
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
                "false (default) = only list the proposed changes (ids J…, L…, C…). true = apply them, " +
                    "after saving a checkpoint, each step checked with screenshots and taken back if the look changes."
            ),
        skip: z
            .array(z.string().min(1).max(16))
            .max(500)
            .optional()
            .describe("With apply: ids of listed proposals to leave out."),
        componentNames: z
            .record(z.string().min(1).max(16), z.string().min(1).max(64))
            .optional()
            .describe('With apply: names of the components to make, e.g. {"C1": "Task Card"}.'),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    fileId!: string;

    pageId?: string;

    nodeIds?: string[];

    apply?: boolean;

    skip?: string[];

    componentNames?: Record<string, string>;

    sessionId?: string;
}

/**
 * MCP tool that lets the AI chat run the tidy-up (W17) of a page or of some layers: first it lists
 * the proposals (unused layers, rows/columns/grids to turn into layouts, look-alike items to turn
 * into components); Claude checks them with its own screenshots, then calls it again with
 * `apply: true` and the ids to skip. Applying saves a checkpoint (W19) when the file belongs to a
 * Penforge project, keeps each step one undo block and takes back steps that change the look.
 * Layers that still have default names are listed for Claude to name.
 */
export class TidyUpTool extends Tool<TidyUpToolArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, TidyUpToolArgs.schema);
    }

    public getToolName(): string {
        return "penforge_tidy_up";
    }

    public getToolDescription(): string {
        return (
            "Penforge only. Tidies up a messy page or selection (often a Figma import): removes unused " +
            "layers (hidden, empty, zero size), turns absolutely placed layers that line up into flex or grid " +
            "layouts with the same gaps and paddings, and makes components from look-alike items (texts and " +
            "images kept). Call it first without apply to list the proposed changes, check them, then call it " +
            "with apply: true (and skip / componentNames). Applying saves a checkpoint, makes each step one undo " +
            "block and takes back any step that changes how the design looks."
        );
    }

    protected async executeCore(args: TidyUpToolArgs): Promise<ToolResponse> {
        const mcpUrl = `http://${this.mcpServer.host}:${this.mcpServer.port}/mcp`;
        const client = new McpToolsClient(mcpUrl);
        try {
            const tools = client.forSession(() => args.sessionId);
            const ctx = await TidyUpTool.context(args, tools, AgentConfig.load(process.env, mcpUrl).projectsDir);
            const params = {
                nodeIds: args.nodeIds,
                pageId: args.pageId,
                review: false,
                steps: { names: false },
            };
            if (args.apply !== true) {
                const result = await new ImportCleaner(ctx, { ...params, dryRun: true }).run();
                return new TextResponse(TidyUpTool.describeProposals(result));
            }
            const cleaner = new ImportCleaner(ctx, {
                ...params,
                skip: args.skip ?? [],
                componentNames: args.componentNames ?? {},
            });
            const result = await cleaner.run();
            const unnamed = await cleaner.defaultNamedLayers().catch(() => []);
            return new TextResponse(TidyUpTool.describeApplied(result, unnamed, ctx.workspace !== undefined));
        } finally {
            await client.close();
        }
    }

    /** Context of a run outside a client session: no Claude turns, no questions. */
    public static async context(
        args: TidyUpToolArgs,
        tools: WorkflowToolsApi,
        projectsDir: string
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
            signal: new AbortController().signal,
            emit: () => {},
            ask: () => Promise.reject(new Error("No questions while tidying up from the chat")),
            runner: { run: () => Promise.reject(new Error("No Claude turns while tidying up from the chat")) },
        } as WorkflowContext;
    }

    /**
     * The workspace of the Penforge project whose `.penforge/project.json` lists the file, or
     * undefined (then no checkpoint is saved).
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
                truncated: result.truncated,
                proposals: proposals.map(TidyUpTool.line),
            }) +
            "\nCheck the proposals (take a screenshot of the boards if unsure). Skip hidden layers that look like " +
            "deliberate states, rows/columns that only line up by chance, and look-alike items that are not the same " +
            "thing. Then call penforge_tidy_up again with the same fileId/pageId/nodeIds, apply: true, the ids to " +
            "skip and a short Title Case name for every component you keep."
        );
    }

    /** Text answer of an applying call. */
    public static describeApplied(
        result: CleanupResult,
        unnamed: { id: string; name: string; type: string; parent: string | null; text?: string }[],
        hasProject: boolean
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
            unnamedLayers: unnamed,
        };
        const advice = [
            hasProject
                ? ""
                : "No checkpoint was saved (the file is not in a Penforge project); Ctrl+Z undoes each step.",
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
