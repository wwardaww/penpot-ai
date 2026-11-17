/**
 * Rules for the commands of a stack (`stack.json` `commands.*`), which the daemon runs in
 * `app-src/` without asking the user.
 *
 * These rules are not a sandbox: the commands run scripts and dependencies that Claude wrote or
 * chose (`package.json` scripts, build tools, install hooks). The trust boundary is "Claude writes
 * the code, the daemon runs it", the same as when the user runs the generated app. The rules only
 * keep the command line itself predictable:
 * - the program is a package manager; `npx` only for {@link NPX_PACKAGES}, and no subcommand that
 *   fetches and runs an arbitrary package (`exec`, `dlx`, `x`);
 * - every argument is a plain token (letters, digits, `@+=:,./_~-`, or the `{port}` placeholder),
 *   so no spaces, quotes, shell operators, or cmd.exe expansions (`%`, `^`) when Windows starts
 *   the command through a shell;
 * - a dev server host flag names a loopback host, and no argument binds all interfaces.
 */
export class StackCommand {
    /** Programs a command may start. */
    public static readonly PROGRAMS = ["npm", "npx", "pnpm", "yarn", "bun"] as const;

    /** Packages `npx` may run. */
    public static readonly NPX_PACKAGES = ["expo", "vite", "next", "tsc"] as const;

    private static readonly FETCH_AND_RUN = new Set(["exec", "dlx", "x"]);
    private static readonly ARG = /^(?:[A-Za-z0-9@+=:,./_~-]|\{port\})+$/;
    private static readonly HOST_FLAGS = new Set(["--host", "--hostname", "-H"]);
    private static readonly LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    private static readonly ALL_INTERFACES = new Set(["0.0.0.0", "::", "[::]"]);

    /**
     * Checks a command.
     *
     * @param argv - the argument vector
     * @returns why the command is refused, or null when it is acceptable
     */
    public static problem(argv: string[]): string | null {
        if (argv.length === 0 || argv.length > 16) {
            return "a command has 1 to 16 arguments";
        }
        const unsafe = argv.find((arg) => !StackCommand.ARG.test(arg));
        if (unsafe !== undefined) {
            return `unsafe argument ${JSON.stringify(unsafe)}`;
        }
        const [program, first] = argv;
        if (!(StackCommand.PROGRAMS as readonly string[]).includes(program)) {
            return `a command starts with one of ${StackCommand.PROGRAMS.join(", ")}`;
        }
        if (program === "npx" && !(StackCommand.NPX_PACKAGES as readonly string[]).includes(first ?? "")) {
            return `npx may only run ${StackCommand.NPX_PACKAGES.join(", ")}`;
        }
        if (program !== "npx" && first !== undefined && StackCommand.FETCH_AND_RUN.has(first)) {
            return `"${program} ${first}" runs arbitrary packages`;
        }
        return StackCommand.hostProblem(argv);
    }

    private static hostProblem(argv: string[]): string | null {
        for (let index = 0; index < argv.length; index++) {
            const arg = argv[index];
            if (StackCommand.ALL_INTERFACES.has(arg)) {
                return `${arg} would expose the dev server on the network`;
            }
            const [flag, inline] = arg.includes("=")
                ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
                : [arg, undefined];
            if (!StackCommand.HOST_FLAGS.has(flag)) {
                continue;
            }
            const host = inline ?? argv[index + 1];
            if (host === undefined || !StackCommand.LOOPBACK.has(host)) {
                return `${flag} must name a loopback host (127.0.0.1)`;
            }
        }
        return null;
    }
}
