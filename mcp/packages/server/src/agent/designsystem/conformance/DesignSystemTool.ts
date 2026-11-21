import { z } from "zod";
import type { WorkflowToolsApi, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { Tool } from "../../../Tool";
import { TextResponse, type ToolResponse } from "../../../ToolResponse";
import type { PenpotMcpServer } from "../../../PenpotMcpServer";
import { AgentConfig } from "../../AgentConfig";
import { TidyUpTool } from "../../cleanup/TidyUpTool";
import { McpToolsClient } from "../../tools/McpToolsClient";
import { designSystemDesignMd } from "../DesignSystemWorkspace";
import { siblingWorkspace, type DesignSystemBinding } from "./Binding";
import { DesignSystemConformance } from "./Conformance";
import { MissingItems, type ReportedItem } from "./MissingItems";
import type { SystemCatalog } from "./types";

/** Arguments of `penforge_design_system`. */
export class DesignSystemToolArgs {
    static schema = {
        fileId: z.string().min(1).max(128).describe("Id of the Penpot file open in the user's tab."),
        action: z
            .enum(["inventory", "missing"])
            .describe(
                "inventory = what the project's design system offers (call it before designing); " +
                    "missing = report what the design needs and the system lacks (one call with every item)."
            ),
        items: z
            .array(
                z.object({
                    name: z.string().min(1).max(80).describe('What is missing, e.g. "Delete button".'),
                    kind: z.enum(["component", "color", "typography", "token", "icon"]).optional(),
                    reason: z
                        .string()
                        .min(1)
                        .max(300)
                        .describe("One short sentence in the user's words: why the design needs it."),
                    componentId: z
                        .string()
                        .max(128)
                        .optional()
                        .describe("The project's own component you made in its place, if any."),
                    layerIds: z.array(z.string().max(128)).max(50).optional(),
                })
            )
            .max(30)
            .optional()
            .describe("With action missing: the items."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    fileId!: string;

    action!: "inventory" | "missing";

    items?: ReportedItem[];

    sessionId?: string;
}

/**
 * MCP tool of the AI chat and workflows for the project's design system (W30): `inventory` tells
 * Claude what the linked design system offers (colors, text styles, tokens, components and the
 * rules), `missing` records what the design needs and the system lacks, for the user's single
 * "Add to design system" / "Don't add" decision.
 */
export class DesignSystemTool extends Tool<DesignSystemToolArgs> {
    /** Characters of the design system's DESIGN.md included in the inventory. */
    public static readonly DESIGN_MD_CHARS = 6000;
    /** Entries listed per kind. */
    public static readonly MAX_LISTED = 120;

    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, DesignSystemToolArgs.schema);
    }

    public getToolName(): string {
        return "penforge_design_system";
    }

    public getToolDescription(): string {
        return (
            "Penforge only. The project's linked design system. action inventory: lists its colors, text " +
            "styles, tokens and components and the rules (use only these; never invent values or redraw " +
            "its components). action missing: report, in ONE call, everything the design needs that the " +
            "system lacks, each with a short reason; the user then decides for all of them at once. Do not " +
            "ask the user about missing items one by one."
        );
    }

    protected async executeCore(args: DesignSystemToolArgs): Promise<ToolResponse> {
        const mcpUrl = `http://${this.mcpServer.host}:${this.mcpServer.port}/mcp`;
        const client = new McpToolsClient(mcpUrl);
        try {
            const tools = client.forSession(() => args.sessionId);
            const workspace = await TidyUpTool.findWorkspace(
                AgentConfig.load(process.env, mcpUrl).projectsDir,
                args.fileId
            );
            return new TextResponse(await DesignSystemTool.handle(args, tools, workspace));
        } finally {
            await client.close();
        }
    }

    /** Answers a call (text for Claude). */
    public static async handle(
        args: DesignSystemToolArgs,
        tools: WorkflowToolsApi,
        workspace: WorkflowWorkspaceApi | undefined
    ): Promise<string> {
        const binding = workspace ? await DesignSystemConformance.binding(workspace) : null;
        if (!workspace || !binding) {
            return JSON.stringify({
                linked: false,
                note: "This project uses no design system. Design freely, following DESIGN.md if there is one.",
            });
        }
        if (binding.fileId === args.fileId) {
            return JSON.stringify({ linked: false, note: "This file is the design system itself." });
        }
        if (args.action === "missing") {
            const items = MissingItems.fromReport(args.items ?? [], new Date().toISOString());
            if (items.length === 0) {
                return JSON.stringify({ error: "no-items", note: "Pass the missing items in `items`." });
            }
            const open = await new MissingItems(workspace, binding.fileId).merge(items);
            return JSON.stringify({
                recorded: open.map((item) => item.name),
                note:
                    'Recorded. The user sees one list with all missing items and chooses "Add to design system" ' +
                    'or "Don\'t add". Do not ask about them yourself; mention them once in your answer.',
            });
        }
        const { catalog } = await new DesignSystemConformance(tools, workspace, args.fileId).catalog(binding);
        const designMd = await designSystemDesignMd(siblingWorkspace(workspace, binding.projectId), binding.fileId)
            .read()
            .catch(() => null);
        return DesignSystemTool.inventoryText(binding, catalog, designMd);
    }

    /** The inventory answer. */
    public static inventoryText(binding: DesignSystemBinding, catalog: SystemCatalog, designMd: string | null): string {
        const max = DesignSystemTool.MAX_LISTED;
        const tokensByType: Record<string, string[]> = {};
        for (const token of catalog.tokens) {
            (tokensByType[token.type] ??= []).push(`${token.name}=${token.value ?? "?"}`);
        }
        const lines = [
            `Design system "${binding.name || catalog.name}" (library ${binding.fileId}), linked: ${catalog.linked}, ` +
                `tokens source: ${catalog.tokensSource}.`,
            "Rules: use only these colors, text styles, tokens and components. Build with instances of the " +
                "system's components (penpot.library.connected → the library with this id → components → instance()). " +
                "Fill with the library colors (color.asFill()) or apply the color tokens; texts get a system text style " +
                "(typography.applyToText(text)); radius, gaps and paddings use the radius/spacing tokens. If the design " +
                "needs something the system does not have, build it from system parts in the project and report it " +
                "with action missing (one call for all items). A check runs after you and fixes leftovers.",
            "",
            `Colors (${catalog.colors.length}): ` +
                catalog.colors
                    .slice(0, max)
                    .map((c) => `${c.path ? `${c.path}/` : ""}${c.name} ${c.hex} [${c.id}]`)
                    .join("; "),
            `Text styles (${catalog.typographies.length}): ` +
                catalog.typographies
                    .slice(0, max)
                    .map((t) => `${t.name} ${t.fontFamily} ${t.fontSize}/${t.fontWeight} [${t.id}]`)
                    .join("; "),
            `Components (${catalog.components.length}): ` +
                catalog.components
                    .slice(0, max)
                    .map((c) => `${c.path ? `${c.path} / ` : ""}${c.name} [${c.id}]`)
                    .join("; "),
            ...Object.entries(tokensByType).map(
                ([type, entries]) => `Tokens ${type} (${entries.length}): ${entries.slice(0, max).join(", ")}`
            ),
        ];
        if (designMd) {
            const text =
                designMd.length > DesignSystemTool.DESIGN_MD_CHARS
                    ? `${designMd.slice(0, DesignSystemTool.DESIGN_MD_CHARS)}\n…(cut)`
                    : designMd;
            lines.push("", "The design system's DESIGN.md:", "````markdown", text.trimEnd(), "````");
        }
        return lines.join("\n");
    }
}
