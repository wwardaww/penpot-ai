import { userInfo } from "os";
import { basename } from "path";
import { ProcessTree } from "../process/ProcessTree";

/** What a name means in the user's shell. */
export type ShellCommand = { kind: "program"; path: string } | { kind: "alias" } | { kind: "function" };

/**
 * The user's shell, as it reads its start files in a terminal (bash and zsh).
 *
 * Aliases and functions exist in the user's shell only, so finding and running one takes a shell
 * that read the same files. The text of an alias or function is never read: the shell that has it
 * runs it.
 */
export class LoginShell {
    private static readonly LOOKUP_TIMEOUT_MS = 10_000;
    private static readonly MARK = "__PENFORGE_COMMAND__";
    private static readonly LOOKUP = {
        bash: `printf '\\n${LoginShell.MARK}%s:%s\\n' "$(type -t -- "$1")" "$(type -P -- "$1")"`,
        zsh: `printf '\\n${LoginShell.MARK}%s:%s\\n' "\${$(whence -w -- "$1")##*: }" "$(whence -p -- "$1")"`,
    };

    private readonly kind: "bash" | "zsh";

    /**
     * @param file - the shell
     * @param env - environment the shell starts with
     * @param platform - the platform, for what a terminal reads there
     */
    constructor(
        private readonly file: string,
        private readonly env: NodeJS.ProcessEnv,
        private readonly platform: NodeJS.Platform = process.platform
    ) {
        this.kind = basename(file) === "zsh" ? "zsh" : "bash";
    }

    /**
     * Gets the user's shell.
     *
     * @param env - the environment (`SHELL`), else the account's shell decides
     * @param platform - the platform
     * @returns the shell, or null when it is neither bash nor zsh
     */
    public static ofUser(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): LoginShell | null {
        const file = env.SHELL || LoginShell.accountShell();
        return file !== undefined && ["bash", "zsh"].includes(basename(file))
            ? new LoginShell(file, env, platform)
            : null;
    }

    /**
     * Gets the program and arguments that run a script in this shell.
     *
     * @param script - the script; one command per line, so that aliases of the start files hold
     * @param args - its positional parameters
     */
    public run(script: string, args: string[] = []): { file: string; args: string[] } {
        return { file: this.file, args: [...this.flags(), "-c", script, "penforge", ...args] };
    }

    /**
     * Finds out what a name means.
     *
     * @param name - a bare name (see `ClaudeCommandName`)
     */
    public async lookup(name: string): Promise<ShellCommand | null> {
        const { file, args } = this.run(LoginShell.LOOKUP[this.kind], [name]);
        const match = LoginShell.answer(await this.output(file, args));
        switch (match?.[1]) {
            case "alias":
                return { kind: "alias" };
            case "function":
                return { kind: "function" };
            case "file":
            case "command":
            case "hashed":
                return match[2].startsWith("/") ? { kind: "program", path: match[2] } : null;
            default:
                return null;
        }
    }

    /**
     * Environment for a shell without a terminal: commands in start files and aliases (`clear`)
     * fail without a known `TERM`.
     *
     * @param env - the environment
     */
    public static environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        return { ...env, TERM: env.TERM && env.TERM !== "dumb" ? env.TERM : "xterm" };
    }

    /** Terminals start login shells on macOS; a zsh login shell also reads `.zprofile` elsewhere. */
    private flags(): string[] {
        return this.kind === "zsh" || this.platform === "darwin" ? ["-i", "-l"] : ["-i"];
    }

    /** The answer line of {@link LOOKUP}, once it is complete; start files may print before it. */
    private static answer(output: string): RegExpExecArray | null {
        return new RegExp(`^${LoginShell.MARK}([a-z]*):(.*)\\n`, "m").exec(output);
    }

    private async output(file: string, args: string[]): Promise<string> {
        // a process group of its own has no terminal, so the shell cannot stop the daemon's one
        const tree = new ProcessTree(
            { file, args, windowsVerbatimArguments: false },
            { env: LoginShell.environment(this.env), stdio: ["ignore", "pipe", "ignore"] }
        );
        let output = "";
        let timer: NodeJS.Timeout | undefined;
        await new Promise<void>((resolve) => {
            timer = setTimeout(resolve, LoginShell.LOOKUP_TIMEOUT_MS);
            tree.child.on("error", () => resolve());
            tree.child.once("close", () => resolve());
            tree.child.stdout?.on("data", (chunk: Buffer) => {
                output = (output + chunk.toString()).slice(-64 * 1024);
                // a program the start files left running would keep the output open
                if (LoginShell.answer(output)) {
                    resolve();
                }
            });
        });
        clearTimeout(timer);
        await tree.kill();
        return output;
    }

    private static accountShell(): string | undefined {
        try {
            return userInfo().shell ?? undefined;
        } catch {
            return undefined;
        }
    }
}
