/**
 * Environment for the Claude Code processes the daemon starts.
 *
 * When the daemon itself was started from inside a Claude Code session (e.g. its terminal), it
 * inherits that session's variables, which would make the child believe it is a nested session or
 * that a host manages its login. These are removed, so the child uses the user's own login
 * (`claude auth login`) or `ANTHROPIC_API_KEY`, as from a plain shell.
 */
export class ClaudeEnvironment {
    private static readonly SESSION_VARIABLES = [
        /^CLAUDECODE$/,
        /^CLAUDE_PID$/,
        /^CLAUDE_EFFORT$/,
        /^CLAUDE_AGENT_SDK_/,
        /^CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|ENTRYPOINT|EXECPATH|SIMPLE)$/,
        /^CLAUDE_CODE_(HOST|MESSAGING|DESKTOP|SDK_HAS)_/,
        /^CLAUDE_CODE_(ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|OAUTH_SCOPES)$/,
        /^CLAUDE_CODE_(REPORT_FINDINGS|TERMINAL_MCP_TOOLS|SESSION_ATTENDED|STARTUP_FAILURE_RESULTS)$/,
        /^CLAUDE_CODE_(EMIT_|ENABLE_SDK_|ENABLE_ASK_|DISABLE_CRON|DISABLE_TERMINAL_TITLE|EAGER_FLUSH)/,
        /^CLAUDE_PREVIEW_/,
    ];

    /**
     * Builds the child environment.
     *
     * @param env - the daemon's environment
     */
    public static forChild(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
        const child: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(env)) {
            if (!ClaudeEnvironment.SESSION_VARIABLES.some((pattern) => pattern.test(name))) {
                child[name] = value;
            }
        }
        // the desktop host routes its sessions through a local proxy; a plain shell talks to the API
        if (env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH !== undefined) {
            delete child.ANTHROPIC_BASE_URL;
        }
        return child;
    }
}
