/**
 * Environment for child processes that run code Claude wrote (generated app scripts, dev
 * servers).
 *
 * Starts from an allowlist of the variables tools need to work (paths, temp folders, locale,
 * Windows system folders, npm settings) and drops every variable whose name looks like a secret,
 * so the daemon's token, Anthropic or Claude credentials and other keys never reach that code.
 * Shared with the dev server manager (W09).
 */
export class ChildEnvironment {
    /** variables kept as they are (compared without case) */
    private static readonly KEEP = new Set(
        [
            "PATH",
            "HOME",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "APPDATA",
            "LOCALAPPDATA",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "COMMONPROGRAMFILES",
            "TEMP",
            "TMP",
            "TMPDIR",
            "SYSTEMROOT",
            "SYSTEMDRIVE",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "OS",
            "PROCESSOR_ARCHITECTURE",
            "NUMBER_OF_PROCESSORS",
            "USER",
            "USERNAME",
            "LOGNAME",
            "SHELL",
            "TERM",
            "LANG",
            "LANGUAGE",
            "TZ",
            "NVM_DIR",
            "PNPM_HOME",
            "BUN_INSTALL",
            "COREPACK_HOME",
        ].map((name) => name.toUpperCase())
    );

    /** prefixes of variables kept (compared without case) */
    private static readonly KEEP_PREFIXES = ["LC_", "XDG_", "NPM_CONFIG_", "YARN_", "COREPACK_"];

    /** names that look like secrets; dropped even when kept above */
    private static readonly SECRET = /TOKEN|SECRET|PASSW|KEY|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT/i;

    /**
     * Builds the environment of a child process.
     *
     * @param source - environment to filter, usually `process.env`
     * @param extra - variables to set on top (never filtered)
     */
    public static scrub(
        source: NodeJS.ProcessEnv = process.env,
        extra: Record<string, string> = {}
    ): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [name, value] of Object.entries(source)) {
            if (value !== undefined && ChildEnvironment.keeps(name)) {
                result[name] = value;
            }
        }
        return { ...result, ...extra };
    }

    /**
     * Tells whether a variable is passed on.
     *
     * @param name - the variable name
     */
    public static keeps(name: string): boolean {
        const upper = name.toUpperCase();
        if (ChildEnvironment.SECRET.test(upper)) {
            return false;
        }
        return (
            ChildEnvironment.KEEP.has(upper) ||
            ChildEnvironment.KEEP_PREFIXES.some((prefix) => upper.startsWith(prefix))
        );
    }
}
