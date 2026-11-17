import { AgentError } from "../AgentClient";
import { StackCommand } from "../build/StackCommand";

/**
 * Dev command check of the preview: an argument vector, never a shell line.
 *
 * Applies the stack command rules of the build pipeline ({@link StackCommand}: package manager
 * first, plain tokens only, loopback host flags only), so build and preview accept the same
 * `stack.json`. Tests may allow other programs.
 */
export class CommandPolicy {
    private static readonly PORT_PLACEHOLDER = /\{port\}/g;

    /**
     * @param programs - programs the first argument may name; the package managers by default
     */
    constructor(public readonly programs: readonly string[] = StackCommand.PROGRAMS) {}

    /**
     * Validates a dev command.
     *
     * @param value - an argument vector, or (legacy form) a command line split at whitespace
     * @returns the argument vector
     * @throws AgentError `bad-request` when the command is not acceptable
     */
    public validate(value: unknown): string[] {
        const argv =
            typeof value === "string"
                ? value
                      .trim()
                      .split(/\s+/)
                      .filter((arg) => arg.length > 0)
                : value;
        if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
            throw new AgentError("bad-request", "The dev command must be a list of arguments");
        }
        const problem = StackCommand.problem(argv, this.programs);
        if (problem !== null) {
            throw new AgentError("bad-request", `Refusing the dev command: ${problem}`);
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
