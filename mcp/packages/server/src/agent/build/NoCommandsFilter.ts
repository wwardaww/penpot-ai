import type { WorkflowToolFilter } from "@penpot/mcp-common";

/**
 * Tool filter of the build turns: Claude writes the code and Penforge runs the commands (install,
 * typecheck, build), so a command is refused at once. Asking the user instead left the build waiting
 * up to five minutes for an answer to a question hidden behind the build dialog.
 */
export class NoCommandsFilter implements WorkflowToolFilter {
    private static readonly COMMANDS = new Set(["Bash", "PowerShell", "BashOutput", "KillShell"]);
    private static readonly REASON =
        "Do not run commands in this step; Penforge installs, checks and builds the app itself.";

    public check(toolName: string): string | null {
        return NoCommandsFilter.COMMANDS.has(toolName) ? NoCommandsFilter.REASON : null;
    }
}
