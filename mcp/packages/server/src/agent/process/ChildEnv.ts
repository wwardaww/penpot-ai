/**
 * Environment for processes of the generated app: the daemon's environment without secrets.
 *
 * Drops Penforge, Anthropic and Claude settings and every variable whose name looks like a
 * credential (token, secret, password, API or private key), so code written by the AI cannot read
 * them. W08 has its own helper; they are to be merged into one.
 */
export class ChildEnv {
    private static readonly DROPPED_PREFIXES = /^(PENFORGE_|ANTHROPIC_|CLAUDE_|CLAUDECODE)/i;
    private static readonly SECRET_NAMES =
        /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|_KEY$|^KEY$)/i;

    /**
     * Copies an environment without secrets.
     *
     * @param env - the source environment
     * @param extra - variables set on top (never dropped)
     */
    public static scrub(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
        const result: NodeJS.ProcessEnv = {};
        for (const [name, value] of Object.entries(env)) {
            if (value !== undefined && !ChildEnv.isSecret(name)) {
                result[name] = value;
            }
        }
        return { ...result, ...extra };
    }

    /**
     * Checks whether a variable name is dropped.
     *
     * @param name - the variable name
     */
    public static isSecret(name: string): boolean {
        return ChildEnv.DROPPED_PREFIXES.test(name) || ChildEnv.SECRET_NAMES.test(name);
    }
}
