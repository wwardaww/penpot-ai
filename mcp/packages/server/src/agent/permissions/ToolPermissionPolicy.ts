import { realpathSync } from "fs";
import { homedir } from "os";
import { isAbsolute, relative, resolve } from "path";
import { PENPOT_MCP_SERVER_NAME } from "../runner/LocalCliRunner";
import type { ToolPermissionHandler, ToolUseDecision, ToolUseRequest } from "../runner/ClaudeRunner";
import type { PathGuard } from "../workspace/pathGuard";
import { AutoApprovalLimits } from "./AutoApprovalLimits";
import { DestructiveDesign } from "./DestructiveDesign";
import type { PermissionAsker, PermissionPrompt } from "./PermissionBroker";

/**
 * Permission policy for Claude's tool uses within one project.
 *
 * - Penpot MCP tools are allowed; the tab's MCP session id is added when missing. Uses that delete
 *   pages, library items, tokens or comments ({@link DestructiveDesign}) need the user's permission.
 * - File tools are allowed inside the project folder and, for a Game UI / Existing project (W38),
 *   inside its linked folder (the guard holds both); outside them the user is asked.
 * - Shell commands, web access and unknown tools need the user's permission. A permission the user
 *   asked to remember holds for the same tool and target (command name, host) for the lifetime of
 *   the policy; never for a path outside the project, nor for a command that names one.
 * - The Penforge home outside the project (other projects, `config.json`, the token store
 *   `secrets.json` and its temporary files) is refused without asking, to file tools and to
 *   commands that name it or `secrets.json`. This is a denylist on what a command names: an
 *   approved interpreter (`node`, `python`) can still reach those files through a script, and
 *   so can any program that runs as the user. DPAPI encryption of the tokens does not stop a
 *   program of the same user either.
 *
 * In the permission mode `auto` the asker approves what this policy would ask about, except for
 * what {@link AutoApprovalLimits} refuses (changes outside the project, publishing); what the
 * policy refuses without asking stays refused in every mode.
 */
export class ToolPermissionPolicy implements ToolPermissionHandler {
    private static readonly PENPOT_TOOL_PREFIX = `mcp__${PENPOT_MCP_SERVER_NAME}__`;
    private static readonly SAFE_TOOLS = new Set(["TodoWrite", "ToolSearch", "Task", "Agent", "ExitPlanMode"]);
    private static readonly READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
    private static readonly WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    private static readonly SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
    private static readonly PATH_FIELDS = ["file_path", "path", "notebook_path"];

    /** the daemon's token store (W20) and its temporary files */
    private static readonly SECRETS_FILE = /(?:^|\/|\\)secrets\.json(?:\.[0-9a-f]+\.tmp)?$/i;
    /** commands that name the token store or the Penforge home through a variable or `~` */
    private static readonly PROTECTED_COMMAND =
        /secret[\w*?[\]-]*\.json|(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE|\$env:HOME)[\\/]+["']?Penforge/i;
    /** command words that may point outside the project: absolute, home or parent paths, variables */
    private static readonly OUTSIDE_WORD = /^["']?(?:\/|~|\.\.|[A-Za-z]:|\\\\)|[$%]/;
    private static readonly PROTECTED_DENIED =
        "Penforge's own files (account tokens, settings, other projects) are not available to Claude.";

    private static readonly AWAY =
        "The user is away and cannot answer. Take the option you would recommend, or else the most sensible one, " +
        "go on, and say in your reply what you assumed.";

    private readonly remembered = new Set<string>();
    private readonly limits: AutoApprovalLimits;

    /**
     * @param guard - guard of the project folder
     * @param asker - asks the user
     * @param mcpSessionId - gets the Penpot MCP session of the client's tab
     * @param area - the project folder and the Penforge home around it (protected outside the project)
     */
    constructor(
        private readonly guard: PathGuard,
        private readonly asker: PermissionAsker,
        private readonly mcpSessionId: () => string | undefined,
        private readonly area?: { projectRoot: string; penforgeHome: string }
    ) {
        this.limits = new AutoApprovalLimits({
            cwd: area?.projectRoot ?? guard.root,
            contains: (path) => this.isInProject(path),
        });
    }

    public async decide(request: ToolUseRequest): Promise<ToolUseDecision> {
        const { toolName, input } = request;
        if (toolName.startsWith(ToolPermissionPolicy.PENPOT_TOOL_PREFIX)) {
            const updatedInput = this.withSessionId(input);
            const deletes = DestructiveDesign.check(
                toolName.slice(ToolPermissionPolicy.PENPOT_TOOL_PREFIX.length),
                input
            );
            if (deletes === null) {
                return { allow: true, updatedInput };
            }
            const decision = await this.askUser(`penpot-delete:${deletes}`, request, {
                title: "Allow deleting design content?",
                description: `Claude wants to delete ${deletes} in this file. Check that you asked for it.`,
                risk: "high",
            });
            return decision.allow ? { allow: true, updatedInput } : decision;
        }
        if (toolName === "AskUserQuestion") {
            return {
                allow: false,
                message: this.asker.unattended
                    ? ToolPermissionPolicy.AWAY
                    : "Ask the user in your reply instead; this tool is not available.",
            };
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
            if (outside.some((path) => this.isProtected(path))) {
                return { allow: false, message: ToolPermissionPolicy.PROTECTED_DENIED };
            }
            return this.askUser(null, request, {
                title: isRead
                    ? "Allow reading a file outside the project?"
                    : "Allow changing a file outside the project?",
                description: `Claude wants to ${isRead ? "read" : "change"} ${outside.join(", ")}`,
                risk: isRead ? "medium" : "high",
                autoRefusal: this.limits.files(outside, isRead),
            });
        }
        if (ToolPermissionPolicy.SHELL_TOOLS.has(toolName)) {
            const command = String(input.command ?? "").trim();
            if (this.namesProtected(command)) {
                return { allow: false, message: ToolPermissionPolicy.PROTECTED_DENIED };
            }
            const words = command.split(/\s+/);
            const program = words[0] ?? "";
            const leavesProject = words.slice(1).some((word) => ToolPermissionPolicy.OUTSIDE_WORD.test(word));
            return this.askUser(leavesProject ? null : `${toolName}:${program}`, request, {
                title: "Allow running a command?",
                description: `Claude wants to run: ${command}`,
                risk: "medium",
                autoRefusal: this.limits.command(command),
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
            autoRefusal: this.limits.tool(toolName, input),
        });
    }

    /**
     * Asks the user, unless a remembered answer covers `key`; a null key is never remembered.
     */
    private async askUser(
        key: string | null,
        request: ToolUseRequest,
        prompt: PermissionPrompt
    ): Promise<ToolUseDecision> {
        // a remembered answer is no reason to publish while the user is away
        const refusedAway = this.asker.unattended && (prompt.autoRefusal ?? null) !== null;
        if (key !== null && this.remembered.has(key) && !refusedAway) {
            return { allow: true };
        }
        const answer = await this.asker.ask(prompt, request.signal);
        if (!answer.allow) {
            return { allow: false, message: answer.reason ?? "The user did not allow this." };
        }
        if (answer.remember && key !== null) {
            this.remembered.add(key);
        }
        return { allow: true };
    }

    /** Tells whether a path outside the project is a secrets file or lies in the Penforge home. */
    private isProtected(path: string): boolean {
        if (ToolPermissionPolicy.SECRETS_FILE.test(path)) {
            return true;
        }
        if (!this.area) {
            return false;
        }
        const expanded = path.startsWith("~") ? resolve(homedir(), path.slice(1).replace(/^[\\/]+/, "")) : path;
        const absolute = resolve(this.area.projectRoot, expanded);
        // a link inside a linked folder (W38) may point into the Penforge home: check its target too
        return [absolute, ToolPermissionPolicy.realPath(absolute)].some((candidate) => {
            const rel = relative(this.area!.penforgeHome, candidate);
            return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
        });
    }

    private static realPath(path: string): string {
        try {
            return realpathSync.native(path);
        } catch {
            return path;
        }
    }

    /** Tells whether a command names a secrets file or the Penforge home. */
    private namesProtected(command: string): boolean {
        if (ToolPermissionPolicy.PROTECTED_COMMAND.test(command)) {
            return true;
        }
        if (!this.area) {
            return false;
        }
        const normalize = (text: string) => text.replace(/\\/g, "/").toLowerCase();
        return normalize(command).includes(normalize(this.area.penforgeHome));
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

    /** Whether a path is inside the project; a path that cannot be checked is not. */
    private isInProject(path: string): boolean {
        try {
            return this.guard.contains(path);
        } catch {
            return false;
        }
    }

    private static hostOf(url: unknown): string {
        try {
            return new URL(String(url)).host;
        } catch {
            return String(url);
        }
    }
}
