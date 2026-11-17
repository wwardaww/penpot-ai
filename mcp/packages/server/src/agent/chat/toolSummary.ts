import type { Persona, ToolCallStatus } from "@penpot/mcp-common";

/**
 * Describer of Claude's tool calls for the chat (`chat.tool`).
 *
 * Designers get outcome language; developers also get the tool name and, as detail, its input or
 * error text.
 */
export class ToolSummary {
    private static readonly PENPOT_PREFIX = "mcp__penpot__";

    private static readonly PHRASES: [RegExp, string][] = [
        [
            /^mcp__penpot__(get_node_properties|list_boards|get_prototype_graph|list_canvas_comments)$/,
            "Reading the design",
        ],
        [/^mcp__penpot__(capture_node_screenshot|export_shape)$/, "Looking at the design"],
        [/^mcp__penpot__(update_design_node|execute_code|import_image)$/, "Working on the design"],
        [/^mcp__penpot__(resolve_canvas_comment)$/, "Updating comments"],
        [/^mcp__penpot__(generate_code_hints)$/, "Studying the design's structure"],
        [/^mcp__penpot__/, "Using Penpot"],
        [/^(Read|Glob|Grep|LS|NotebookRead)$/, "Reading project files"],
        [/^(Write|Edit|MultiEdit|NotebookEdit)$/, "Updating project files"],
        [/^(Bash|PowerShell)$/, "Running a command"],
        [/^(WebFetch|WebSearch)$/, "Searching the web"],
        [/^(TodoWrite)$/, "Planning the next steps"],
        [/^(Task|Agent)$/, "Working on a sub-task"],
    ];

    private static readonly MAX_DETAIL_CHARS = 2000;

    /**
     * Describes a tool call.
     *
     * @param toolName - the tool name
     * @param status - status of the call
     * @param persona - persona of the user
     */
    public static summary(toolName: string, status: ToolCallStatus, persona: Persona): string {
        const phrase = ToolSummary.PHRASES.find(([pattern]) => pattern.test(toolName))?.[1] ?? "Working";
        const failed = status === "error" ? " (did not work, trying another way)" : "";
        if (persona === "developer") {
            const name = toolName.startsWith(ToolSummary.PENPOT_PREFIX)
                ? toolName.slice(ToolSummary.PENPOT_PREFIX.length)
                : toolName;
            return `${phrase} · ${name}${failed}`;
        }
        return `${phrase}${failed}`;
    }

    /**
     * Gets the technical detail of a tool call, for developers only.
     *
     * @param persona - persona of the user
     * @param input - tool input
     * @param errorText - error text of a failed call
     */
    public static detail(persona: Persona, input: unknown, errorText?: string): string | undefined {
        if (persona !== "developer") {
            return undefined;
        }
        const text = errorText ?? (input === undefined ? undefined : JSON.stringify(input, null, 2));
        if (!text) {
            return undefined;
        }
        return text.length > ToolSummary.MAX_DETAIL_CHARS ? `${text.slice(0, ToolSummary.MAX_DETAIL_CHARS)}…` : text;
    }
}
