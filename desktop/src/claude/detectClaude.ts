import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Finds an executable on `PATH` (with `PATHEXT` on Windows); undefined when missing. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
    const pathValue = env.PATH ?? env.Path ?? "";
    const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
    for (const dir of pathValue.split(platform === "win32" ? ";" : delimiter)) {
        if (!dir) {
            continue;
        }
        for (const ext of exts) {
            const candidate = join(dir.replace(/^"|"$/g, ""), name + ext.toLowerCase());
            if (isFile(candidate)) {
                return candidate;
            }
            const upper = join(dir.replace(/^"|"$/g, ""), name + ext);
            if (ext && isFile(upper)) {
                return upper;
            }
        }
    }
    return undefined;
}

function isFile(path: string): boolean {
    try {
        return existsSync(path) && statSync(path).isFile();
    } catch {
        return false;
    }
}

/** Places the installers of Claude Code put the binary, searched when it is not on PATH. */
export function wellKnownClaudePaths(home: string, platform: NodeJS.Platform = process.platform): string[] {
    if (platform === "win32") {
        return [join(home, ".local", "bin", "claude.exe"), join(home, "AppData", "Roaming", "npm", "claude.cmd")];
    }
    return [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

interface RunResult {
    code: number | null;
    output: string;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve) => {
        // .cmd shims need cmd.exe on Windows; arguments here are fixed words, no user input
        const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
        const child = shim
            ? spawn("cmd.exe", ["/d", "/s", "/c", `"${command}" ${args.join(" ")}`], { env, windowsHide: true, windowsVerbatimArguments: true })
            : spawn(command, args, { env, windowsHide: true });
        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timer);
            resolve({ code: -1, output: error.message });
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolve({ code, output: output.trim() });
        });
    });
}

export interface ClaudeStatus {
    found: boolean;
    path?: string;
    version?: string;
    loggedIn: boolean;
    detail?: string;
}

/**
 * Interprets `claude auth status`. The command answers JSON (`loggedIn`) in recent versions
 * and text in older ones; a non-zero exit means not logged in.
 */
export function parseAuthStatus(result: RunResult): { loggedIn: boolean; detail: string } {
    const detail = result.output.slice(0, 400);
    if (result.code !== 0) {
        return { loggedIn: false, detail };
    }
    try {
        const json = JSON.parse(result.output) as { loggedIn?: boolean };
        if (typeof json.loggedIn === "boolean") {
            return { loggedIn: json.loggedIn, detail };
        }
    } catch {
        // text output
    }
    return { loggedIn: !/not\s+logged\s+in|logged\s+out|no\s+credentials/i.test(result.output), detail };
}

/** Looks for the `claude` CLI and asks whether it is logged in. */
export async function detectClaude(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): Promise<ClaudeStatus> {
    const path = findOnPath("claude", env, platform) ?? wellKnownClaudePaths(home, platform).find((candidate) => isAbsolute(candidate) && isFile(candidate));
    if (!path) {
        return { found: false, loggedIn: false };
    }
    const version = await run(path, ["--version"], env, 15_000);
    if (version.code !== 0) {
        return { found: false, path, loggedIn: false, detail: version.output.slice(0, 400) };
    }
    const status = parseAuthStatus(await run(path, ["auth", "status"], env, 15_000));
    return { found: true, path, version: version.output.split(/\r?\n/)[0], loggedIn: status.loggedIn, detail: status.detail };
}

/**
 * PATH of the user's login shell. macOS apps started from Finder get a minimal PATH without
 * `~/.local/bin` or Homebrew, where `claude`, `node` and `git` usually live.
 */
export async function loginShellPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
    if (platform === "win32") {
        return undefined;
    }
    const shell = env.SHELL || "/bin/zsh";
    const result = await run(shell, ["-ilc", 'printf "__PF_PATH__%s__PF_PATH__" "$PATH"'], env, 8_000);
    const match = /__PF_PATH__(.*)__PF_PATH__/s.exec(result.output);
    return match?.[1] || undefined;
}

/** Opens a terminal running `claude auth login` (the CLI drives the browser sign-in). */
export function openLoginTerminal(claudePath: string, platform: NodeJS.Platform = process.platform): void {
    if (platform === "win32") {
        // `/k` strips one pair of outer quotes: wrap the quoted path in another pair
        spawn("cmd.exe", ["/d", "/c", "start", '"Claude login"', "cmd.exe", "/k", `""${claudePath}" auth login"`], {
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
        }).unref();
        return;
    }
    if (platform === "darwin") {
        const script = `tell application "Terminal" to do script ${JSON.stringify(`'${claudePath.replace(/'/g, "'\\''")}' auth login`)}`;
        spawn("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate'], { detached: true, stdio: "ignore" }).unref();
        return;
    }
    spawn("x-terminal-emulator", ["-e", claudePath, "auth", "login"], { detached: true, stdio: "ignore" }).unref();
}
