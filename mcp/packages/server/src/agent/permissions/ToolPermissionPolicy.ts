import { PENPOT_MCP_SERVER_NAME } from "../runner/LocalCliRunner";
import type { ToolPermissionHandler, ToolUseDecision, ToolUseRequest } from "../runner/ClaudeRunner";
import type { PathGuard } from "../workspace/pathGuard";
import type { PermissionAsker, PermissionPrompt } from "./PermissionBroker";

/**
 * Permission policy for Claude's tool uses within one project.
 *
 * - Penpot MCP tools are always allowed; the tab's MCP session id is added when missing.
 * - File tools are allowed inside the project folder; outside it the user is asked.
 * - Shell commands, web access and unknown tools need the user's permission. A permission the user
 *   asked to remember holds for the same tool and target (command name, host, path) for the
 *   lifetime of the policy.
 */
export class ToolPermissionPolicy implements ToolPermissionHandler {
    private static readonly PENPOT_TOOL_PREFIX = `mcp__${PENPOT_MCP_SERVER_NAME}__`;
    private static readonly SAFE_TOOLS = new Set(["TodoWrite", "ToolSearch", "Task", "Agent", "ExitPlanMode"]);
    private static readonly READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
    private static readonly WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    private static readonly SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
    private static readonly PATH_FIELDS = ["file_path", "path", "notebook_path"];

    /** the daemon's token store (W20), never readable by Claude, not even with permission */
    private static readonly SECRETS_FILE = /(?:^|\/|\\)secrets\.json$/i;
    private static readonly SECRETS_DENIED = "Penforge's account tokens are not available to Claude.";

    private readonly remembered = new Set<string>();

    /**
     * @param guard - guard of the project folder
     * @param asker - asks the user
     * @param mcpSessionId - gets the Penpot MCP session of the client's tab
     */
    constructor(
        private readonly guard: PathGuard,
        private readonly asker: PermissionAsker,
        private readonly mcpSessionId: () => string | undefined
    ) {}

    public async decide(request: ToolUseRequest): Promise<ToolUseDecision> {
        const { toolName, input } = request;
        if (toolName.startsWith(ToolPermissionPolicy.PENPOT_TOOL_PREFIX)) {
            return { allow: true, updatedInput: this.withSessionId(input) };
        }
        if (toolName === "AskUserQuestion") {
            return { allow: false, message: "Ask the user in your reply instead; this tool is not available." };
        }
        if (ToolPermissionPolicy.SAFE_TOOLS.has(toolName)) {
            return { allow: true };
        }
        const isRead = ToolPermissionPolicy.READ_TOOLS.has(toolName);
        if (isRead || ToolPermissionPolicy.WRITE_TOOLS.has(toolName)) {
            const outside = this.pathsOutsideProject(input);
            if (outside.length === 0) {
                return { allow: true };
            }
            if (outside.some((path) => ToolPermissionPolicy.SECRETS_FILE.test(path))) {
                return { allow: false, message: ToolPermissionPolicy.SECRETS_DENIED };
            }
            return this.askUser(`${toolName}:${outside.join("|")}`, request, {
                title: isRead
                    ? "Allow reading a file outside the project?"
                    : "Allow changing a file outside the project?",
                description: `Claude wants to ${isRead ? "read" : "change"} ${outside.join(", ")}`,
                risk: isRead ? "medium" : "high",
            });
        }
        if (ToolPermissionPolicy.SHELL_TOOLS.has(toolName)) {
            const command = String(input.command ?? "").trim();
            if (/secrets\.json/i.test(command)) {
                return { allow: false, message: ToolPermissionPolicy.SECRETS_DENIED };
            }
            const program = command.split(/\s+/)[0] ?? "";
            return this.askUser(`${toolName}:${program}`, request, {
                title: "Allow running a command?",
                description: `Claude wants to run: ${command}`,
                risk: "medium",
            });
        }
        if (toolName === "WebFetch" || toolName === "WebSearch") {
            const target = toolName === "WebFetch" ? ToolPermissionPolicy.hostOf(input.url) : String(input.query ?? "");
            return this.askUser(toolName === "WebFetch" ? `${toolName}:${target}` : toolName, request, {
                title: "Allow web access?",
                description:
                    toolName === "WebFetch"
                        ? `Claude wants to open ${target}`
                        : `Claude wants to search for "${target}"`,
                risk: "low",
            });
        }
        return this.askUser(toolName, request, {
            title: `Allow ${toolName}?`,
            description: `Claude wants to use the tool ${toolName}.`,
            risk: "medium",
        });
    }

    private async askUser(key: string, request: ToolUseRequest, prompt: PermissionPrompt): Promise<ToolUseDecision> {
        if (this.remembered.has(key)) {
            return { allow: true };
        }
        const answer = await this.asker.ask(prompt, request.signal);
        if (!answer.allow) {
            return { allow: false, message: "The user did not allow this." };
        }
        if (answer.remember) {
            this.remembered.add(key);
        }
        return { allow: true };
    }

    private withSessionId(input: Record<string, unknown>): Record<string, unknown> {
        const sessionId = this.mcpSessionId();
        if (!sessionId || input.sessionId !== undefined) {
            return input;
        }
        return { ...input, sessionId };
    }

    private pathsOutsideProject(input: Record<string, unknown>): string[] {
        return ToolPermissionPolicy.PATH_FIELDS.map((field) => input[field])
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .filter((value) => !this.guard.contains(value));
    }

    private static hostOf(url: unknown): string {
        try {
            return new URL(String(url)).host;
        } catch {
            return String(url);
        }
    }
}
