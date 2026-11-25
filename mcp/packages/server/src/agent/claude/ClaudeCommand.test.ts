import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { RunnerEvent } from "../runner/ClaudeRunner";
import { CliProcessRunner } from "../runner/CliProcessRunner";
import { LocalCliRunner } from "../runner/LocalCliRunner";
import { ClaudeCommandName } from "./ClaudeCommandName";
import { ClaudeCommands } from "./ClaudeCommands";
import { ClaudeLauncher } from "./ClaudeLauncher";
import { ClaudeSource } from "./ClaudeSource";
import { LoginShell } from "./LoginShell";

const POSIX = process.platform !== "win32";

/**
 * Stand-in for Claude Code: answers `--version`, else records how it was started and replies to the
 * first message like `--output-format stream-json` does (a control request gets its answer first).
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
    console.log("9.8.7 (Claude Code)");
    process.exit(0);
}
appendFileSync(process.env.FAKE_LOG, JSON.stringify({
    args, cwd: process.cwd(), base: process.env.ANTHROPIC_BASE_URL ?? null,
}) + "\\n");
process.stderr.write("claude is up\\n");
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf("\\n")) >= 0; buffer = buffer.slice(end + 1)) {
        const message = JSON.parse(buffer.slice(0, end));
        if (message.type === "control_request") {
            out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
        } else if (message.type === "user") {
            out({ type: "system", subtype: "init", session_id: "s1", mcp_servers: [] });
            if (process.env.FAKE_HANG) {
                setInterval(() => {}, 1000);
                return;
            }
            out({ type: "result", subtype: "success", result: "hello", session_id: "s1", is_error: false, usage: {} });
        }
    }
});
process.stdin.on("end", () => process.env.FAKE_HANG || process.exit(0));
`;

let home: string;
let bin: string;
let log: string;
let env: NodeJS.ProcessEnv;
/** the real environment: no test may read the start files of the person running it */
const realEnv = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL };

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "penforge claude home-"));
    bin = join(home, "bin");
    log = join(home, "claude.log");
    mkdirSync(bin);
    program("claude", FAKE_CLAUDE);
    env = {
        HOME: home,
        SHELL: "/bin/bash",
        PATH: [bin, join(process.execPath, ".."), "/usr/bin", "/bin"].join(delimiter),
        FAKE_LOG: log,
    };
    Object.assign(process.env, { HOME: home, PATH: env.PATH, SHELL: env.SHELL });
});

afterEach(() => {
    Object.assign(process.env, realEnv);
    rmSync(home, { recursive: true, force: true });
});

function program(name: string, text: string, folder: string = bin): string {
    const path = join(folder, name);
    writeFileSync(path, text);
    chmodSync(path, 0o755);
    return path;
}

/** Start file of the fake home; Ubuntu's returns early in shells that are not interactive. */
function bashrc(...lines: string[]): void {
    writeFileSync(
        join(home, ".bashrc"),
        ["case $- in *i*) ;; *) return;; esac", "echo noise of the start file", ...lines, ""].join("\n")
    );
}

/** The user's two commands as they are on his computer, with a script that forwards nothing. */
function localClaude(): void {
    const script = program(
        "Claude-local.sh",
        [
            "#!/bin/bash",
            'echo "Starting the local model, token SECRET"',
            "cd /",
            "export ANTHROPIC_BASE_URL=http://127.0.0.1:1234",
            "export ANTHROPIC_AUTH_TOKEN=SECRET",
            "claude --model qwen/qwen3.5-9b",
            "",
        ].join("\n"),
        home
    );
    bashrc(`alias claude-local='clear && "${script}"'`);
}

function commands(): ClaudeCommands {
    return new ClaudeCommands({ env, home, platform: "linux" });
}

function source(command: string, startTimeoutMs?: number): ClaudeSource {
    const found = commands();
    return new ClaudeSource(found, () => command, new ClaudeLauncher(found.shell, startTimeoutMs));
}

function starts(): { args: string[]; cwd: string; base: string | null }[] {
    return existsSync(log)
        ? readFileSync(log, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
        : [];
}

function shimFolders(): string[] {
    return readdirSync(tmpdir()).filter((name) => /^penforge-claude-[A-Za-z0-9]{6}$/.test(name));
}

async function turn(
    runner: LocalCliRunner | CliProcessRunner,
    signal?: AbortSignal,
    onEvent?: (event: RunnerEvent) => void
): Promise<RunnerEvent[]> {
    const events: RunnerEvent[] = [];
    const opts = {
        cwd: home,
        systemPromptAppend: "it's a 'quoted' $(prompt)",
        permissions: { decide: async () => ({ allow: true as const }) },
        signal,
        env: env as Record<string, string>,
    };
    for await (const event of runner.send({ id: "c1" }, { text: "hi" }, opts)) {
        events.push(event);
        onEvent?.(event);
    }
    return events;
}

function localRunner(command: string, startTimeoutMs?: number): LocalCliRunner {
    return new LocalCliRunner({
        mcpUrl: "http://127.0.0.1:1/mcp",
        model: "claude-override",
        claude: source(command, startTimeoutMs),
    });
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        assert.ok(Date.now() < deadline, "timed out");
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe("the name of a Claude command", () => {
    test("is a bare name or an absolute path", () => {
        assert.equal(ClaudeCommandName.parse("claude-local", "linux"), "claude-local");
        assert.equal(ClaudeCommandName.parse("  claude.2 ", "linux"), "claude.2");
        assert.equal(ClaudeCommandName.parse("", "linux"), "claude");
        assert.equal(ClaudeCommandName.parse("/opt/my tools/claude", "linux"), "/opt/my tools/claude");
        assert.equal(
            ClaudeCommandName.parse("C:\\Program Files (x86)\\claude.cmd", "win32"),
            "C:\\Program Files (x86)\\claude.cmd"
        );
    });

    test("takes no arguments, shell syntax, relative paths or shares", () => {
        const refused = [
            "claude --model x",
            "claude; rm -rf /",
            "claude && ls",
            "$(claude)",
            "`claude`",
            "-claude",
            "./claude",
            "../claude",
            "~/claude",
            "bin/claude",
            "/opt/claude --model x",
            "/opt/claude;ls",
            "/opt/claude\nls",
            "/opt/$HOME/claude",
            "/opt/'claude'",
            "claude|cat",
            "claude>x",
            "a".repeat(65),
        ];
        for (const value of refused) {
            assert.equal(ClaudeCommandName.parse(value, "linux"), null, JSON.stringify(value));
        }
        for (const value of [
            "\\\\server\\share\\claude.exe",
            "\\\\.\\pipe\\x",
            "C:claude.exe",
            "C:\\a.exe:x",
            "/bin/x",
        ]) {
            assert.equal(ClaudeCommandName.parse(value, "win32"), null, value);
        }
    });
});

describe("whether a Claude command is Claude itself", () => {
    test("by its name", () => {
        assert.equal(ClaudeCommandName.isClaude("claude", "linux"), true);
        assert.equal(ClaudeCommandName.isClaude("claude", "win32"), true);
        for (const command of ["claude-local", "claude2", "Claude", "qwen", "claude.exe"]) {
            assert.equal(ClaudeCommandName.isClaude(command, "linux"), false, command);
        }
    });

    test("by the file name of its path", () => {
        assert.equal(ClaudeCommandName.isClaude("/home/me/my tools/claude", "linux"), true);
        for (const command of ["/usr/bin/claude-local", "/opt/claude/qwen", "/opt/claude.exe", "bin/claude"]) {
            assert.equal(ClaudeCommandName.isClaude(command, "linux"), false, command);
        }
        for (const command of ["C:\\Tools\\claude.exe", "C:/Tools/Claude.CMD", "D:\\claude"]) {
            assert.equal(ClaudeCommandName.isClaude(command, "win32"), true, command);
        }
        for (const command of ["C:\\Tools\\claude-local.cmd", "C:\\claude\\qwen.exe", "C:\\claude.bat"]) {
            assert.equal(ClaudeCommandName.isClaude(command, "win32"), false, command);
        }
    });

    test("is read anew for every turn", () => {
        let value = "claude";
        const source = new ClaudeSource(new ClaudeCommands({ env, home, shell: null }), () => value);
        assert.equal(source.isClaude, true);
        value = "claude-local";
        assert.equal(source.isClaude, false);
    });
});

describe("finding a Claude command", { skip: !POSIX }, () => {
    test("prefers a program on PATH over an alias", async () => {
        bashrc("alias claude='echo alias'");
        assert.deepEqual(await commands().find("claude"), {
            command: "claude",
            kind: "program",
            path: join(bin, "claude"),
            wrapper: false,
        });
    });

    test("finds programs in the well-known folders without PATH", async () => {
        const folder = join(home, ".local", "bin");
        mkdirSync(folder, { recursive: true });
        const path = program("claude-next", FAKE_CLAUDE, folder);
        const found = await commands().find("claude-next");
        assert.deepEqual(found, { command: "claude-next", kind: "program", path, wrapper: false });
    });

    test("uses the path the daemon was started with for claude", async () => {
        const path = program("other-claude.js", FAKE_CLAUDE, home);
        const found = new ClaudeCommands({ env, home, configuredPath: path, shell: null });
        assert.equal((await found.find("claude"))?.path, path);
        assert.equal(await found.findClaude(), path);
    });

    test("falls back to the bundled copy for claude only", async () => {
        const found = new ClaudeCommands({
            env: { PATH: "" },
            home: join(home, "none"),
            shell: null,
            platform: "win32",
        });
        assert.deepEqual(await found.find("claude"), { command: "claude", kind: "bundled", wrapper: false });
        assert.equal(await found.find("claude-local"), null);
    });

    test("finds aliases, functions and programs of the shell's own PATH", async () => {
        const folder = join(home, "tools");
        mkdirSync(folder);
        const path = program("claude-tool", "#!/bin/sh\nexec claude\n", folder);
        bashrc("alias claude-local='clear && true'", "claude-fn() { claude; }", `PATH="$PATH:${folder}"`);
        assert.deepEqual(await commands().find("claude-local"), {
            command: "claude-local",
            kind: "alias",
            wrapper: true,
        });
        assert.equal((await commands().find("claude-fn"))?.kind, "function");
        assert.deepEqual(await commands().find("claude-tool"), {
            command: "claude-tool",
            kind: "program",
            path,
            wrapper: true,
        });
    });

    test("finds nothing for shell builtins, unknown names and files that cannot run", async () => {
        bashrc();
        writeFileSync(join(bin, "claude-text"), "text");
        for (const name of ["claude-missing", "eval", "claude-text", join(bin, "claude-text"), "/nowhere/claude"]) {
            assert.equal(await commands().find(name), null, name);
        }
    });

    test("on Windows only .exe and .cmd programs count, and no shell is asked", async () => {
        program("claude-local.cmd", "", bin);
        program("claude-local.ps1", "", bin);
        program("claude-script.ps1", "", bin);
        const found = new ClaudeCommands({ env: { PATH: bin }, home, platform: "win32" });
        assert.equal(found.shell, null);
        assert.equal((await found.find("claude-local"))?.path, join(bin, "claude-local.cmd"));
        assert.equal(await found.find("claude-script"), null);
    });

    test("only bash and zsh are asked", () => {
        assert.equal(LoginShell.ofUser({ SHELL: "/usr/bin/fish" }), null);
        assert.ok(LoginShell.ofUser({ SHELL: "/bin/bash" }));
        assert.deepEqual(new LoginShell("/bin/zsh", {}).run("x").args, ["-i", "-l", "-c", "x", "penforge"]);
    });
});

describe("turns of a Claude command", { skip: !POSIX }, () => {
    test("an alias that forwards nothing runs the turn, with its own model and environment", async () => {
        localClaude();
        const events = await turn(localRunner("claude-local"));
        assert.equal(events.at(-1)?.kind, "done", JSON.stringify(events));
        const [start] = starts();
        assert.deepEqual(start.args.slice(0, 2), ["--model", "qwen/qwen3.5-9b"], "the wrapper's arguments come first");
        assert.ok(start.args.includes("--output-format"), "the daemon's arguments reach Claude Code");
        assert.ok(
            !start.args.join(" ").includes("claude-override"),
            "the daemon's model does not replace the wrapper's"
        );
        assert.equal(start.base, "http://127.0.0.1:1234");
        assert.equal(start.cwd, home, "Claude works in the project whatever the wrapper's folder");
        assert.doesNotMatch(JSON.stringify(events), /SECRET|Starting/);
    });

    test("claude itself runs as before, with the daemon's model", async () => {
        const events = await turn(localRunner("claude"));
        assert.equal(events.at(-1)?.kind, "done", JSON.stringify(events));
        assert.ok(starts()[0].args.join(" ").includes("--model=claude-override"));
    });

    test("a change of the command holds from the next turn on", async () => {
        localClaude();
        let command = "claude";
        const found = commands();
        const runner = new LocalCliRunner({
            mcpUrl: "http://127.0.0.1:1/mcp",
            claude: new ClaudeSource(found, () => command),
        });
        await turn(runner);
        command = "claude-local";
        await turn(runner);
        assert.deepEqual(
            starts().map((start) => start.base),
            [null, "http://127.0.0.1:1234"]
        );
    });

    test("a function and a script work the same way, also after a version check", async () => {
        program("claude-script", "#!/bin/sh\nclaude --version\nexec claude --model from-script\n");
        bashrc("claude-fn() { command claude --model from-function; }");
        for (const [command, model] of [
            ["claude-fn", "from-function"],
            ["claude-script", "from-script"],
            [join(bin, "claude-script"), "from-script"],
        ]) {
            const events = await turn(localRunner(command));
            assert.equal(events.at(-1)?.kind, "done", `${command}: ${JSON.stringify(events)}`);
            assert.deepEqual(starts().at(-1)?.args.slice(0, 2), ["--model", model]);
        }
    });

    test("the spawn runner starts wrappers too", async () => {
        localClaude();
        const runner = new CliProcessRunner({
            mcpUrl: "http://127.0.0.1:1/mcp",
            model: "m",
            claude: source("claude-local"),
        });
        const events = await turn(runner);
        assert.equal(events.at(-1)?.kind, "done", JSON.stringify(events));
        const { args } = starts()[0];
        assert.equal(args[args.indexOf("--append-system-prompt") + 1], "it's a 'quoted' $(prompt)");
        assert.equal(args.filter((arg) => arg.startsWith("--model")).length, 1);
    });

    test("a wrapper that never reaches claude ends with a clear error", async () => {
        bashrc("alias claude-broken='echo SECRET; false'", "alias claude-hang='sleep 600'");
        for (const [command, pattern] of [
            ["claude-broken", /"claude-broken" ended without starting claude/],
            ["claude-hang", /"claude-hang" took too long/],
        ] as const) {
            for (const runner of [
                localRunner(command, 1500),
                new CliProcessRunner({ mcpUrl: "http://127.0.0.1:1/mcp", claude: source(command, 1500) }),
            ]) {
                const last = (await turn(runner)).at(-1);
                assert.equal(last?.kind, "error", runner.kind);
                assert.match((last as { message: string }).message, pattern, runner.kind);
                assert.doesNotMatch((last as { message: string }).message, /SECRET|sleep/);
            }
        }
        await until(() => shimFolders().length === 0);
    });

    test("an unknown command ends with a clear error", async () => {
        bashrc();
        const last = (await turn(localRunner("claude-missing"))).at(-1);
        assert.match((last as { message: string }).message, /"claude-missing" was not found/);
    });

    test("stopping a turn ends every process of the wrapper", async () => {
        const pids = join(home, "pids");
        bashrc(
            `claude-busy() { sleep 600 & echo $! >> "${pids}"; echo $BASHPID >> "${pids}"; FAKE_HANG=1 command claude; }`
        );
        const abort = new AbortController();
        const events = await turn(localRunner("claude-busy"), abort.signal, (event) => {
            if (event.kind === "session") {
                abort.abort();
            }
        });
        assert.deepEqual(events.at(-1), { kind: "error", message: "cancelled" });
        const started = readFileSync(pids, "utf8").trim().split("\n").map(Number);
        assert.equal(started.length, 2);
        await until(() => started.every((pid) => !isAlive(pid)), 15_000);
        await until(() => shimFolders().length === 0);
    });
});

describe("testing a Claude command", { skip: !POSIX }, () => {
    test("reports the version of a program and of a wrapper", async () => {
        localClaude();
        const direct = await source("claude").check("claude");
        assert.equal(direct.version, "9.8.7");
        assert.equal(direct.command?.path, join(bin, "claude"));
        const alias = await source("claude").check("claude-local");
        assert.deepEqual([alias.found, alias.command?.kind, alias.version], [true, "alias", "9.8.7"]);
        assert.deepEqual(starts(), [], "no session was started");
    });

    test("reports what is wrong and nothing the command printed", async () => {
        program("not-claude", "#!/usr/bin/env node\nconsole.log('SECRET');\n");
        bashrc("alias claude-broken='echo SECRET'");
        const missing = await source("claude").check("claude-missing");
        assert.deepEqual(missing, { found: false, problem: "not-found" });
        const broken = await source("claude").check("claude-broken");
        assert.equal(broken.problem, "not-started");
        const other = await source("claude").check("not-claude");
        assert.equal(other.problem, "failed");
        assert.doesNotMatch(JSON.stringify([broken, other]), /SECRET/);
    });
});
