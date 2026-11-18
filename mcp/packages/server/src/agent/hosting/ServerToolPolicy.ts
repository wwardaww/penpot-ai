import type { ToolPermissionHandler, ToolUseDecision, ToolUseRequest } from "../runner/ClaudeRunner";
import type { PathGuard } from "../workspace/pathGuard";

/**
 * Tool policy of server mode, in front of the local policy.
 *
 * The daemon container holds every team's project folders and the install's master key, so
 * Claude may not run commands there (`Bash`, `PowerShell`), may not fetch URLs from there
 * (`WebFetch` could reach internal services such as the Penpot backend or the database), and
 * may not touch files outside its project folder or inside a `.git` folder (a written git config
 * can make the daemon's own `git` calls run commands); these are refused without asking the user.
 * Everything else goes to the local policy.
 */
export class ServerToolPolicy implements ToolPermissionHandler {
    private static readonly REFUSED_TOOLS = new Set(["Bash", "PowerShell", "BashOutput", "KillShell", "WebFetch"]);
    private static readonly PATH_FIELDS = ["file_path", "path", "notebook_path"];
    private static readonly GIT_DIR = /(^|[\\/])\.git([\\/]|$)/i;
    private static readonly COMMAND_REFUSED =
        "Commands and web requests do not run on this server. Edit the project files instead; builds and " +
        "previews run in the sandbox.";
    private static readonly OUTSIDE_REFUSED = "Only files inside this project are available on this server.";

    /**
     * @param inner - the local policy
     * @param guard - guard of the project folder
     */
    constructor(
        private readonly inner: ToolPermissionHandler,
        private readonly guard: PathGuard
    ) {}

    public decide(request: ToolUseRequest): Promise<ToolUseDecision> {
        if (ServerToolPolicy.REFUSED_TOOLS.has(request.toolName)) {
            return Promise.resolve({ allow: false, message: ServerToolPolicy.COMMAND_REFUSED });
        }
        const outside = ServerToolPolicy.PATH_FIELDS.map((field) => request.input[field]).some(
            (value) =>
                typeof value === "string" &&
                value.length > 0 &&
                (!this.guard.contains(value) || ServerToolPolicy.GIT_DIR.test(value))
        );
        if (outside) {
            return Promise.resolve({ allow: false, message: ServerToolPolicy.OUTSIDE_REFUSED });
        }
        return this.inner.decide(request);
    }
}
