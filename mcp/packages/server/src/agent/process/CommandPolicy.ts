import { AgentError } from "../AgentClient";

/**
 * Rule set for the dev command of a stack: an argument vector, never a shell line.
 *
 * The first element must be an allowed program (package managers by default) and every argument
 * may hold only characters without shell meaning; `{port}` is the port placeholder. The same rules
 * as the build pipeline's `CommandSchema` (W08), so both accept the same `stack.json`.
 */
export class CommandPolicy {
    /** Programs a stack command may start by default. */
    public static readonly PACKAGE_MANAGERS = ["npm", "npx", "pnpm", "yarn", "bun"];

    /** Pattern of one argument: no spaces, quotes or shell operators. */
    private static readonly ARG = /^(?:[A-Za-z0-9@%+=:,./_~^-]|\{port\})+$/;
    private static readonly MAX_ARGS = 16;
    private static readonly PORT_PLACEHOLDER = /\{port\}/g;

    /**
     * @param programs - programs the first argument may name
     */
    constructor(public readonly programs: readonly string[] = CommandPolicy.PACKAGE_MANAGERS) {}

    /**
     * Validates a dev command.
     *
     * @param value - an argument vector, or (legacy form) a command line split at whitespace
     * @returns the argument vector
     * @throws AgentError `bad-request` when the command is not acceptable
     */
    public validate(value: unknown): string[] {
        const argv = typeof value === "string" ? value.trim().split(/\s+/) : value;
        if (!Array.isArray(argv) || argv.length === 0 || argv.length > CommandPolicy.MAX_ARGS) {
            throw new AgentError("bad-request", "The dev command must be a list of 1 to 16 arguments");
        }
        for (const arg of argv) {
            if (typeof arg !== "string" || !CommandPolicy.ARG.test(arg)) {
                throw new AgentError("bad-request", `Unsafe dev command argument ${JSON.stringify(arg)}`);
            }
        }
        if (!this.programs.includes(argv[0])) {
            throw new AgentError("bad-request", `The dev command must start with one of ${this.programs.join(", ")}`);
        }
        return [...argv];
    }

    /**
     * Replaces the port placeholder in every argument.
     *
     * @param argv - a validated argument vector
     * @param port - the port
     */
    public static withPort(argv: readonly string[], port: number): string[] {
        return argv.map((arg) => arg.replace(CommandPolicy.PORT_PLACEHOLDER, String(port)));
    }
}
