import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, delimiter, isAbsolute, join } from "path";
import type { ClaudeCommandKind } from "@penpot/mcp-common";
import { ClaudeEnvironment } from "../runner/ClaudeEnvironment";
import { ClaudeCommandName } from "./ClaudeCommandName";
import { LoginShell } from "./LoginShell";

/** A Claude command found on this computer. */
export interface ClaudeCommand {
    /** the command as the user typed it */
    command: string;
    kind: ClaudeCommandKind;
    /** file of a program; unset for aliases, functions and the bundled copy */
    path?: string;
    /**
     * Whether the command only leads to Claude Code (an alias, a function, a shell script). It then
     * runs through a `ClaudeLauncher`, and what it sets itself, such as the model, holds.
     */
    wrapper: boolean;
}

/** Where {@link ClaudeCommands} looks. */
export interface ClaudeCommandsOptions {
    /** path of `claude` the daemon was started with (`PENFORGE_CLAUDE_PATH`) */
    configuredPath?: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    platform?: NodeJS.Platform;
    /** the user's shell; none on Windows */
    shell?: LoginShell | null;
}

/**
 * Finder of Claude commands.
 *
 * A name is looked up on `PATH`, then where the installers of Claude Code put programs, then in the
 * user's shell (which adds its own `PATH`, aliases and functions). On Windows only `.exe` and
 * `.cmd` programs count. `claude` itself is the path the daemon was started with, when it has one,
 * and the copy bundled with the Agent SDK when none is installed.
 */
export class ClaudeCommands {
    private static readonly WINDOWS_EXTENSIONS = [".exe", ".cmd"];

    /** The user's shell, which runs aliases and functions. */
    public readonly shell: LoginShell | null;

    private readonly configuredPath?: string;
    private readonly env: NodeJS.ProcessEnv;
    private readonly home: string;
    private readonly platform: NodeJS.Platform;

    constructor(options: ClaudeCommandsOptions = {}) {
        this.configuredPath = options.configuredPath;
        this.env = options.env ?? process.env;
        this.home = options.home ?? this.env.HOME ?? homedir();
        this.platform = options.platform ?? process.platform;
        this.shell =
            options.shell !== undefined
                ? options.shell
                : this.platform === "win32"
                  ? null
                  : LoginShell.ofUser(this.environment, this.platform);
    }

    /** Environment Claude commands start with. */
    public get environment(): NodeJS.ProcessEnv {
        return ClaudeEnvironment.forChild(this.env) as NodeJS.ProcessEnv;
    }

    /**
     * Finds a command.
     *
     * @param value - the command, as `ClaudeCommandName` accepts it
     * @returns the command, or null when this computer has none of that name
     */
    public async find(value: string): Promise<ClaudeCommand | null> {
        const command = ClaudeCommandName.parse(value, this.platform);
        if (command === null) {
            return null;
        }
        if (ClaudeCommandName.isPath(command, this.platform)) {
            return this.isProgram(command) ? this.program(command, command) : null;
        }
        const isDefault = command === ClaudeCommandName.DEFAULT;
        const path = isDefault ? this.claudeFile() : this.onPath(command);
        if (path !== undefined) {
            return this.program(command, path);
        }
        const found = await this.shell?.lookup(command);
        if (found?.kind === "program" && this.isProgram(found.path)) {
            return this.program(command, found.path);
        }
        if (found?.kind === "alias" || found?.kind === "function") {
            return { command, kind: found.kind, wrapper: true };
        }
        return isDefault ? { command, kind: "bundled", wrapper: false } : null;
    }

    /**
     * Finds Claude Code itself, which wrappers lead to.
     *
     * @returns its path, or undefined for the copy bundled with the Agent SDK
     */
    public async findClaude(): Promise<string | undefined> {
        const path = this.claudeFile();
        if (path !== undefined) {
            return path;
        }
        const found = await this.shell?.lookup(ClaudeCommandName.DEFAULT);
        return found?.kind === "program" && this.isProgram(found.path) ? found.path : undefined;
    }

    private claudeFile(): string | undefined {
        // the path of the configuration may be a script without the execute permission (`cli.js`)
        return this.configuredPath !== undefined && ClaudeCommands.isFile(this.configuredPath)
            ? this.configuredPath
            : this.onPath(ClaudeCommandName.DEFAULT);
    }

    private program(command: string, path: string): ClaudeCommand {
        return { command, kind: "program", path, wrapper: this.isWrapper(path) };
    }

    private onPath(name: string): string | undefined {
        const windows = this.platform === "win32";
        const folders = [
            ...(this.env.PATH ?? this.env.Path ?? "").split(windows ? ";" : delimiter),
            ...this.wellKnownFolders(),
        ].filter((folder) => isAbsolute(folder.replace(/^"/, "")));
        const named = ClaudeCommands.WINDOWS_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
        const extensions = windows && !named ? ClaudeCommands.WINDOWS_EXTENSIONS : [""];
        for (const folder of folders) {
            for (const extension of extensions) {
                const candidate = join(folder.replace(/^"|"$/g, ""), name + extension);
                if (this.isProgram(candidate)) {
                    return candidate;
                }
            }
        }
        return undefined;
    }

    private wellKnownFolders(): string[] {
        if (this.platform === "win32") {
            return [join(this.home, ".local", "bin"), join(this.home, "AppData", "Roaming", "npm")];
        }
        return [
            join(this.home, ".local", "bin"),
            join(this.home, ".claude", "local"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ];
    }

    private isProgram(path: string): boolean {
        if (!ClaudeCommands.isFile(path)) {
            return false;
        }
        if (this.platform === "win32") {
            const lower = path.toLowerCase();
            return ClaudeCommands.WINDOWS_EXTENSIONS.some((extension) => lower.endsWith(extension));
        }
        try {
            accessSync(path, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Whether a program is a script that starts Claude Code rather than Claude Code itself: a
     * script of any interpreter but a JavaScript one, under another name than `claude`. Windows
     * batch files run as they are.
     */
    private isWrapper(path: string): boolean {
        if (this.platform === "win32") {
            return false;
        }
        const names = [basename(path), basename(ClaudeCommands.realPath(path))];
        if (names.includes(ClaudeCommandName.DEFAULT)) {
            return false;
        }
        const firstLine = ClaudeCommands.head(path).split("\n")[0];
        return firstLine.startsWith("#!") && !/\b(?:node|bun|deno)\b/.test(firstLine);
    }

    private static isFile(path: string): boolean {
        try {
            return statSync(path).isFile();
        } catch {
            return false;
        }
    }

    private static realPath(path: string): string {
        try {
            return realpathSync(path);
        } catch {
            return path;
        }
    }

    private static head(path: string): string {
        const buffer = Buffer.alloc(256);
        try {
            const file = openSync(path, "r");
            try {
                return buffer.toString("latin1", 0, readSync(file, buffer, 0, buffer.length, 0));
            } finally {
                closeSync(file);
            }
        } catch {
            return "";
        }
    }
}
