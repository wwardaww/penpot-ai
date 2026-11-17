import { existsSync, statSync } from "fs";
import { delimiter, extname, isAbsolute, join } from "path";

/** How to spawn a validated argument vector without a shell. */
export interface SpawnSpec {
    file: string;
    args: string[];
    /** pass `args` unquoted (only for the `cmd.exe` wrapper of a batch file) */
    windowsVerbatimArguments: boolean;
}

/**
 * Translator of a validated argument vector into a shell-free spawn.
 *
 * On POSIX the program is spawned directly. On Windows the program is looked up in `PATH` with
 * `PATHEXT`: executables are spawned directly; batch shims (`npm.cmd`) cannot run without
 * `cmd.exe`, so they run as `cmd.exe /d /s /c ""<shim>" "<arg>" …"` with every argument quoted.
 * Arguments that `cmd.exe` would expand even inside quotes (`%`, `^`) are refused there.
 */
export class CommandLauncher {
    private static readonly BATCH_EXTENSIONS = [".cmd", ".bat"];
    private static readonly CMD_UNSAFE = /["%^\r\n]/;

    /**
     * @param env - environment holding `PATH`, `PATHEXT` and `ComSpec`
     * @param platform - the platform whose rules apply
     */
    constructor(
        private readonly env: NodeJS.ProcessEnv,
        private readonly platform: NodeJS.Platform = process.platform
    ) {}

    /**
     * Builds the spawn of an argument vector.
     *
     * @param argv - a validated argument vector (see `CommandPolicy`)
     * @throws Error when the program cannot be found or an argument is unsafe for `cmd.exe`
     */
    public spawnSpec(argv: readonly string[]): SpawnSpec {
        const [program, ...args] = argv;
        if (this.platform !== "win32") {
            return { file: program, args, windowsVerbatimArguments: false };
        }
        const resolved = this.resolveWindows(program);
        if (!CommandLauncher.BATCH_EXTENSIONS.includes(extname(resolved).toLowerCase())) {
            return { file: resolved, args, windowsVerbatimArguments: false };
        }
        for (const part of [resolved, ...args]) {
            if (CommandLauncher.CMD_UNSAFE.test(part)) {
                throw new Error(`Cannot pass ${JSON.stringify(part)} to ${program} safely`);
            }
        }
        const line = [resolved, ...args].map((part) => `"${part}"`).join(" ");
        return {
            file: this.envValue("ComSpec") ?? "cmd.exe",
            args: ["/d", "/s", "/c", `"${line}"`],
            windowsVerbatimArguments: true,
        };
    }

    private resolveWindows(program: string): string {
        const extensions = (this.envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter((ext) => ext.length > 0)
            .map((ext) => ext.toLowerCase());
        const dirs = (this.envValue("PATH") ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
        for (const dir of dirs) {
            for (const ext of extensions) {
                const candidate = join(dir, program + ext);
                if (CommandLauncher.isFile(candidate)) {
                    return candidate;
                }
            }
        }
        throw new Error(`${program} was not found on PATH`);
    }

    /** Reads an environment variable case-insensitively (Windows names are). */
    private envValue(name: string): string | undefined {
        const key = Object.keys(this.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        return key === undefined ? undefined : this.env[key];
    }

    private static isFile(path: string): boolean {
        try {
            return existsSync(path) && statSync(path).isFile();
        } catch {
            return false;
        }
    }
}
