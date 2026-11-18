import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type {
    Persona,
    WorkflowClaudeRequest,
    WorkflowClaudeResult,
    WorkflowContext,
    WorkflowToolResult,
} from "@penpot/mcp-common";
import { BuildLock } from "../build/BuildLock";
import type { CommandExecutor, CommandOptions, CommandOutcome } from "../build/CommandExecutor";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { DesignTokens, type PenpotTokenSnapshot } from "./DesignTokens";
import { PenpotTokenReader } from "./PenpotTokenReader";
import { ThemeBlock } from "./ThemeBlock";
import { ThemeGenerator } from "./ThemeGenerator";
import { ThemeModel } from "./ThemeModel";
import { ThemeLocator } from "./ThemeTarget";
import { TokenSync, type TokenSyncParams, type TokenSyncResult } from "./TokenSync";
import { TokenSyncError } from "./TokenSyncError";
import { TokenThemeNote } from "./TokenThemeNote";

// fakes -----------------------------------------------------------------------------------------

interface FakeToken {
    name: string;
    type: string;
    value: unknown;
    resolvedValue: unknown;
    description: string;
}

/** Minimal `penpot` global for the reader script: a file with token sets. */
class FakePenpot {
    public reachable = true;
    public calls = 0;
    public sets: { name: string; active: boolean; tokens: FakeToken[] }[] = [];

    public set(name: string, active: boolean, tokens: [string, string, unknown][]): void {
        this.sets.push({
            name,
            active,
            tokens: tokens.map(([tokenName, type, resolved]) => ({
                name: tokenName,
                type,
                value: typeof resolved === "object" ? resolved : String(resolved),
                resolvedValue: resolved,
                description: "",
            })),
        });
    }

    public token(name: string): FakeToken {
        const found = this.sets.flatMap((s) => s.tokens).find((t) => t.name === name);
        assert.ok(found, `token ${name}`);
        return found;
    }

    public async call(tool: string, args: Record<string, unknown> = {}): Promise<WorkflowToolResult> {
        assert.equal(tool, "execute_code");
        this.calls++;
        if (!this.reachable) {
            return { isError: true, content: [], text: "Tool execution failed: no plugin connected" };
        }
        const penpot = {
            currentFile: { name: "Todo" },
            library: { local: { tokens: { themes: [{ group: "", name: "Light", active: true }], sets: this.sets } } },
        };
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
            ...names: string[]
        ) => (...values: unknown[]) => Promise<unknown>;
        const result = await new AsyncFunction("penpot", String(args.code))(penpot);
        return { isError: false, content: [], text: JSON.stringify({ result, log: "" }) };
    }
}

/** Scripted Claude for the link pass: edits files of app-src. */
class FakeClaude {
    public readonly requests: WorkflowClaudeRequest[] = [];
    public edits: ((appSrc: string) => void)[] = [];

    public async run(request: WorkflowClaudeRequest): Promise<WorkflowClaudeResult> {
        this.requests.push(request);
        this.edits.shift()?.(workspace.appSrcDir);
        return { text: "Done.", sessionId: "session-1" };
    }
}

class FakeExecutor implements CommandExecutor {
    public readonly calls: string[] = [];
    public failures = 0;

    public async execute(argv: string[], _options: CommandOptions): Promise<CommandOutcome> {
        this.calls.push(argv.join(" "));
        if (this.failures > 0) {
            this.failures--;
            return { code: 2, output: "src/theme.ts(3,1): error TS2304", timedOut: false };
        }
        return { code: 0, output: "ok", timedOut: false };
    }
}

let home: string;
let workspace: ProjectWorkspace;
let penpot: FakePenpot;
let claude: FakeClaude;
let executor: FakeExecutor;
let events: { kind: string; payload: any }[];

function context(persona: Persona = "developer"): WorkflowContext {
    return {
        runId: "run-1",
        context: {
            fileId: "file-1",
            fileName: "Todo",
            projectId: "project-1",
            teamId: "team-1",
            pageId: "page-1",
            persona,
            platform: "mobile",
        },
        runner: { run: (request) => claude.run(request) },
        tools: { call: (tool, args) => penpot.call(tool, args), list: async () => ["execute_code"] },
        workspace,
        signal: new AbortController().signal,
        emit: (kind, payload) => {
            events.push({ kind, payload });
        },
        ask: async () => {
            throw new Error("no questions expected");
        },
    };
}

async function sync(params: TokenSyncParams = {}): Promise<TokenSyncResult | undefined> {
    events = [];
    await new TokenSync(context(), params, { executor }).run();
    return events.find((e) => e.kind === "result")?.payload as TokenSyncResult | undefined;
}

function write(file: string, text: string): void {
    const path = join(workspace.appSrcDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}

function read(file: string): string {
    return readFileSync(join(workspace.appSrcDir, file), "utf8");
}

function git(dir: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

const EXPO_THEME = `import type { TextStyle } from 'react-native';

/** Design tokens taken from the Penpot board "iPhone" (390×844). */
export const colors = {
  accent: '#6c5ce7',
  surface: '#ffffff',
} as const;
`;

/** Expo app like the one W08 builds, with its own `src/theme.ts`, committed. */
async function expoApp(): Promise<void> {
    write("package.json", JSON.stringify({ dependencies: { expo: "~54.0.0", "react-native": "0.81.0" } }));
    write("tsconfig.json", "{}\n");
    write("src/theme.ts", EXPO_THEME);
    write(
        "src/components/Card.tsx",
        "import { colors } from '../theme';\nexport const card = { backgroundColor: '#ffffff' };\n"
    );
    git(workspace.appSrcDir, "add", "-A");
    git(workspace.appSrcDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "build");
    await workspace.writeJson("stack.json", {
        schemaVersion: 1,
        platform: "mobile",
        name: "Expo + React Native (TypeScript)",
        version: "expo ~54",
        packageManager: "npm",
        commands: {
            install: ["npm", "install"],
            build: ["npm", "run", "build"],
            typecheck: ["npx", "tsc", "--noEmit"],
            dev: ["npx", "expo", "start", "--web", "--port", "{port}"],
        },
        portEnv: "PORT",
        readyPath: "/",
        preBuild: [],
        dev: "npx expo start --web --port {port}",
    });
}

function tokens(): void {
    penpot.set("core", true, [
        ["color.primary", "color", "#6C5CE7"],
        ["color.surface", "color", "#ffffff"],
        ["spacing.md", "spacing", 16],
        ["radius.card", "borderRadius", 24],
        [
            "shadow.card",
            "shadow",
            [{ color: "rgba(26, 27, 46, 0.05)", inset: false, offsetX: 0, offsetY: 4, blur: 14, spread: 0 }],
        ],
        [
            "typography.title",
            "typography",
            [
                {
                    fontFamilies: ["Plus Jakarta Sans"],
                    fontSizes: 24,
                    fontWeights: "bold",
                    lineHeight: 1.2,
                    letterSpacing: 0,
                },
            ],
        ],
    ]);
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-tokens-"));
    workspace = new ProjectWorkspace(join(home, "projects"), "project-1");
    await workspace.ensure();
    penpot = new FakePenpot();
    claude = new FakeClaude();
    executor = new FakeExecutor();
    events = [];
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

// tokens and generators ------------------------------------------------------------------------

function snapshot(): PenpotTokenSnapshot {
    return {
        fileName: "Todo",
        activeThemes: [],
        sets: [
            {
                name: "base",
                active: true,
                tokens: [
                    { name: "color.primary", type: "color", value: "#111111", resolved: "#111111", description: "" },
                    {
                        name: "color.primary.500",
                        type: "color",
                        value: "{color.primary}",
                        resolved: "#111111",
                        description: "",
                    },
                    { name: "space.4", type: "spacing", value: "4", resolved: 4, description: "" },
                    {
                        name: "weight.bold",
                        type: "fontWeights",
                        value: "Bold Italic",
                        resolved: "Bold Italic",
                        description: "",
                    },
                    { name: "broken", type: "color", value: "{missing}", resolved: null, description: "" },
                ],
            },
            {
                name: "brand",
                active: true,
                tokens: [
                    {
                        name: "color.primary",
                        type: "color",
                        value: "#6C5CE7",
                        resolved: "#6C5CE7",
                        description: "Brand",
                    },
                ],
            },
            {
                name: "dark",
                active: false,
                tokens: [
                    { name: "color.primary", type: "color", value: "#000000", resolved: "#000000", description: "" },
                ],
            },
        ],
    };
}

test("tokens: later active sets win, inactive sets and unresolved tokens are left out", () => {
    const tokens = DesignTokens.fromSnapshot(snapshot());
    const primary = tokens.tokens.find((t) => t.name === "color.primary");
    assert.deepEqual(primary?.value, { kind: "color", value: "#6c5ce7" });
    assert.equal(primary?.set, "brand");
    assert.deepEqual(tokens.skipped, ["broken"]);
    assert.deepEqual(tokens.tokens.find((t) => t.name === "weight.bold")?.value, {
        kind: "fontWeight",
        value: 700,
        italic: true,
    });
    assert.deepEqual(tokens.activeSets, ["base", "brand"]);
});

test("tokens: W3C export nests groups, keeps references in extensions, and diffs by value", () => {
    const tokens = DesignTokens.fromSnapshot(snapshot());
    const dtcg = tokens.toDtcg() as any;
    assert.equal(dtcg.color.primary.$root.$value, "#6c5ce7", "a token that is also a group sits in $root");
    assert.equal(dtcg.color.primary["500"].$extensions.penpot.value, "{color.primary}");
    assert.equal(dtcg.space["4"].$type, "dimension");
    assert.equal(dtcg.space["4"].$value, "4px");

    const changed = structuredClone(dtcg);
    changed.color.primary.$root.$value = "#000000";
    delete changed.space;
    changed.color.extra = { $type: "color", $value: "#fff" };
    assert.deepEqual(tokens.changesSince(changed), {
        added: ["space.4"],
        changed: ["color.primary"],
        removed: ["color.extra"],
    });
    assert.deepEqual(tokens.changesSince(dtcg), { added: [], changed: [], removed: [] });
});

test("theme model: drops the repeated category, folds accents and numbers clashes", () => {
    const model = ThemeModel.build(
        DesignTokens.fromSnapshot({
            fileName: "",
            activeThemes: [],
            sets: [
                {
                    name: "s",
                    active: true,
                    tokens: [
                        { name: "colors.text-primary", type: "color", value: "", resolved: "#111", description: "" },
                        { name: "color.Sağlık.bg", type: "color", value: "", resolved: "#222", description: "" },
                        { name: "color.text.primary", type: "color", value: "", resolved: "#333", description: "" },
                        { name: "spacing.2xl", type: "spacing", value: "", resolved: 32, description: "" },
                    ],
                },
            ],
        })
    );
    const color = model.groups.get("color")!.map((e) => [e.key, e.cssName]);
    assert.deepEqual(color, [
        ["saglikBg", "saglik-bg"],
        ["textPrimary", "text-primary"],
        ["textPrimary2", "text-primary-2"],
    ]);
    const spacing = model.groups.get("spacing")![0];
    assert.equal(spacing.key, "2xl");
    assert.equal(ThemeGenerator.create("react-native").reference(spacing), "tokens.spacing['2xl']");
});

function sampleModel(): ThemeModel {
    penpot = new FakePenpot();
    tokens();
    const sets = penpot.sets.map((s) => ({
        name: s.name,
        active: s.active,
        tokens: s.tokens.map((t) => ({ ...t, resolved: t.resolvedValue })),
    }));
    return ThemeModel.build(DesignTokens.fromSnapshot({ fileName: "Todo", activeThemes: [], sets }));
}

test("generator: React Native theme object uses numbers and px line heights", () => {
    const text = ThemeGenerator.create("react-native", "ts").render(sampleModel()).join("\n");
    assert.match(text, /^export const tokens = \{/);
    assert.match(text, /primary: '#6c5ce7',/);
    assert.match(text, /md: 16,/);
    assert.match(text, /card: 24,/);
    assert.match(text, /card: '0px 4px 14px 0px rgba\(26, 27, 46, 0\.05\)',/);
    assert.match(
        text,
        /title: \{ fontFamily: 'Plus Jakarta Sans', fontSize: 24, fontWeight: '700', lineHeight: 29, letterSpacing: 0 \},/
    );
    assert.match(text, /\} as const;$/);
});

test("generator: web object, CSS variables and Tailwind v4 theme", () => {
    const model = sampleModel();
    const web = ThemeGenerator.create("js-web", "esm", '"').render(model).join("\n");
    assert.match(web, /md: "16px",/);
    assert.match(web, /fontFamily: "\\"Plus Jakarta Sans\\""/);
    assert.match(web, /lineHeight: 1\.2/);
    assert.match(web, /\};$/);

    const css = ThemeGenerator.create("css").render(model).join("\n");
    assert.match(css, /^:root \{/);
    assert.match(css, /--color-primary: #6c5ce7;/);
    assert.match(css, /--spacing-md: 16px;/);
    assert.match(css, /--radius-card: 24px;/);
    assert.match(css, /--typography-title-font-size: 24px;/);
    assert.match(css, /--typography-title-line-height: 1\.2;/);

    const tailwind = ThemeGenerator.create("tailwind").render(model).join("\n");
    assert.match(tailwind, /^@theme \{/);
    assert.match(tailwind, /--text-title: 24px;/);
    assert.match(tailwind, /--text-title--line-height: 1\.2;/);
    assert.match(tailwind, /--font-title: "Plus Jakarta Sans";/);
    assert.doesNotMatch(tailwind, /:root/);
});

// theme block ----------------------------------------------------------------------------------

test("theme block: inserted after imports, before a commented declaration, then replaced", () => {
    const first = ThemeBlock.write(EXPO_THEME, ["export const tokens = {} as const;"], "line", "js");
    const lines = first.split("\n");
    assert.equal(lines[0], "import type { TextStyle } from 'react-native';");
    assert.equal(lines[1], "");
    assert.match(lines[2], /^\/\/ penforge:tokens:begin/);
    assert.equal(lines[3], "export const tokens = {} as const;");
    assert.equal(lines[4], "// penforge:tokens:end");
    assert.equal(lines[5], "");
    assert.match(lines[6], /^\/\*\* Design tokens taken/, "the doc comment stays with its declaration");

    const second = ThemeBlock.write(first, ["export const tokens = { a: 1 } as const;"], "line", "js");
    assert.equal(second, first.replace("{} as const", "{ a: 1 } as const"));
    assert.equal(ThemeBlock.strip(second).includes("tokens = "), false);
});

test("theme block: CSS after @import, CRLF kept, broken markers refused", () => {
    const css = '@import "tailwindcss";\r\n\r\nbody { margin: 0; }\r\n';
    const out = ThemeBlock.write(css, ["@theme {", "}"], "block", "css");
    assert.ok(out.startsWith('@import "tailwindcss";\r\n\r\n/* penforge:tokens:begin'));
    assert.ok(out.includes("/* penforge:tokens:end */\r\n\r\nbody { margin: 0; }\r\n"));
    assert.equal(ThemeBlock.write("", ["x"], "block", "css").split("\n")[1], "x");
    assert.throws(
        () => ThemeBlock.write("// penforge:tokens:begin\nconst a = 1;\n", ["x"], "line", "js"),
        (error: unknown) => error instanceof TokenSyncError && error.code === "broken-block"
    );
});

// theme file -----------------------------------------------------------------------------------

test("locator: Expo app uses its own src/theme.ts, web apps get src/theme.css", async () => {
    await expoApp();
    const expo = await ThemeLocator.locate(workspace.appSrcDir, { name: "Expo" });
    assert.equal(expo.file, "src/theme.ts");
    assert.equal(expo.format, "react-native");
    assert.equal(expo.module, "ts");
    assert.equal(expo.quote, "'");
    assert.equal(expo.exists, true);

    rmSync(workspace.appSrcDir, { recursive: true, force: true });
    mkdirSync(workspace.appSrcDir, { recursive: true });
    write("package.json", JSON.stringify({ devDependencies: { "@tailwindcss/vite": "^4.1.0" } }));
    const web = await ThemeLocator.locate(workspace.appSrcDir, { name: "React + Vite + Tailwind" });
    assert.deepEqual([web.file, web.format, web.exists], ["src/theme.css", "tailwind", false]);

    write("src/index.css", "body {}\n");
    const plain = await ThemeLocator.locate(workspace.appSrcDir, { name: "React + Vite" });
    assert.deepEqual([plain.file, plain.format], ["src/index.css", "tailwind"], "Tailwind 4 in package.json");

    await assert.rejects(
        ThemeLocator.locate(workspace.appSrcDir, { themeFile: "../outside.css" }),
        (error: unknown) => error instanceof TokenSyncError && error.code === "unsafe-theme-path"
    );
});

// workflow ---------------------------------------------------------------------------------------

test("sync: Expo app gets a token block in its theme, the export and stack.json are updated", async () => {
    await expoApp();
    tokens();
    const result = await sync();
    assert.ok(result);
    assert.equal(result.outcome, "updated");
    assert.equal(result.themeFile, "src/theme.ts");
    assert.equal(result.format, "react-native");
    assert.equal(result.tokenCount, 6);
    assert.equal(result.themeCreated, false);
    assert.equal(result.link, null, "no Claude pass by default");
    assert.equal(claude.requests.length, 0);

    const theme = read("src/theme.ts");
    assert.ok(theme.includes("export const colors = {"), "the build's theme stays");
    assert.ok(theme.includes("primary: '#6c5ce7',"));
    assert.equal(theme.split("penforge:tokens:begin").length, 2, "one block, no second theme file");

    const exported = JSON.parse(readFileSync(join(workspace.designDir, "penpot-tokens.json"), "utf8"));
    assert.equal(exported.color.primary.$value, "#6c5ce7");
    assert.match(
        git(workspace.designDir, "log", "-1", "--format=%s"),
        /^penforge\(token-sync\): export 6 design tokens/
    );

    const stack = await workspace.readJson<any>("stack.json", null);
    assert.equal(stack.themeFile, "src/theme.ts");
    assert.equal(stack.themeFormat, "react-native");
    assert.deepEqual(stack.preBuild, ["token-sync"]);
    assert.equal(stack.dev, "npx expo start --web --port {port}", "other stack fields stay");

    assert.equal(
        git(workspace.appSrcDir, "show", "--name-only", "--format=%s", "HEAD").trim(),
        ["penforge(token-sync): update src/theme.ts from the design tokens", "", "src/theme.ts"].join("\n")
    );
    assert.deepEqual(
        events.filter((e) => e.kind === "progress" && e.payload.status === "done").map((e) => e.payload.step),
        ["read-tokens", "export", "theme"]
    );
});

test("sync: a changed color token updates the block; a second run changes nothing", async () => {
    await expoApp();
    tokens();
    await sync();
    const commits = git(workspace.appSrcDir, "rev-list", "--count", "HEAD").trim();

    penpot.token("color.primary").resolvedValue = "#ff0000";
    const changed = await sync();
    assert.equal(changed?.outcome, "updated");
    assert.deepEqual(changed?.changes, { added: [], changed: ["color.primary"], removed: [] });
    assert.ok(read("src/theme.ts").includes("primary: '#ff0000',"));
    assert.equal(Number(git(workspace.appSrcDir, "rev-list", "--count", "HEAD")), Number(commits) + 1);

    const same = await sync();
    assert.equal(same?.outcome, "unchanged");
    assert.equal(same?.themeChanged, false);
    assert.equal(same?.commits.appSrc, null);
    assert.equal(same?.commits.design, null);
});

test("sync: the watcher skips projects without an app; no tokens and no app are reported", async () => {
    const watched = await sync({ trigger: "watch" });
    assert.equal(watched?.outcome, "no-app");
    assert.equal(penpot.calls, 0, "nothing is read from Penpot");

    tokens();
    const manual = await sync();
    assert.equal(manual?.outcome, "no-app");
    assert.ok(existsSync(join(workspace.designDir, "penpot-tokens.json")), "tokens are still exported");

    await expoApp();
    penpot.sets = [];
    const empty = await sync();
    assert.equal(empty?.outcome, "no-tokens");
    assert.equal(read("src/theme.ts"), EXPO_THEME);
});

test("sync: busy while a build runs; a pre-build sync never fails the build and stays quiet", async () => {
    await expoApp();
    tokens();
    const release = BuildLock.tryAcquire(workspace.root)!;
    try {
        assert.equal((await sync())?.outcome, "busy");

        penpot.reachable = false;
        const summary = await new TokenSync(context(), { preBuild: true }, { executor }).run();
        assert.match(summary?.summary ?? "", /Token sync skipped/);

        penpot.reachable = true;
        events = [];
        await new TokenSync(context(), { preBuild: true }, { executor }).run();
        assert.deepEqual(
            events.map((e) => e.kind),
            [],
            "no progress or result events inside the build's run"
        );
        assert.ok(read("src/theme.ts").includes("penforge:tokens:begin"), "the theme is synced under the build's lock");
    } finally {
        release();
    }
});

test("sync: unreachable Penpot fails a manual run with a code", async () => {
    await expoApp();
    penpot.reachable = false;
    await assert.rejects(sync());
    assert.deepEqual(events.find((e) => e.kind === "failed")?.payload.code, "penpot-unreachable");
});

test("sync with link: Claude's code changes are committed and the block is put back", async () => {
    await expoApp();
    tokens();
    mkdirSync(join(workspace.appSrcDir, "node_modules"));
    claude.edits.push((appSrc) => {
        const theme = readFileSync(join(appSrc, "src/theme.ts"), "utf8");
        writeFileSync(
            join(appSrc, "src/theme.ts"),
            theme
                .replace("accent: '#6c5ce7'", "accent: tokens.color.primary")
                .replace("primary: '#6c5ce7',", "primary: '#000000',")
        );
        writeFileSync(
            join(appSrc, "src/components/Card.tsx"),
            "import { tokens } from '../theme';\nexport const card = { backgroundColor: tokens.color.surface };\n"
        );
    });
    const result = await sync({ link: "auto" });
    assert.equal(result?.link, "done");
    assert.deepEqual(result?.linkedFiles, ["src/components/Card.tsx", "src/theme.ts"]);
    assert.equal(claude.requests[0].promptName, "token-sync");
    assert.match(claude.requests[0].prompt, /`tokens\.color\.primary` = #6c5ce7/);
    const theme = read("src/theme.ts");
    assert.ok(theme.includes("accent: tokens.color.primary"));
    assert.ok(theme.includes("primary: '#6c5ce7',"), "the block edit was undone");
    assert.deepEqual(executor.calls, ["npx tsc --noEmit"]);
    assert.equal(
        git(workspace.appSrcDir, "log", "-1", "--format=%s").trim(),
        "penforge(token-sync): use the design tokens in the code"
    );
    assert.ok(events.some((e) => e.kind === "log" && e.payload.code === "block-restored"));

    claude.requests.length = 0;
    const again = await sync({ link: "auto" });
    assert.equal(again?.link, null, "auto does not ask again when the code already uses tokens");
    assert.equal(claude.requests.length, 0);
});

test("sync with link: a change that keeps failing the type check is undone", async () => {
    await expoApp();
    tokens();
    mkdirSync(join(workspace.appSrcDir, "node_modules"));
    executor.failures = 2;
    claude.edits.push((appSrc) => {
        writeFileSync(join(appSrc, "src/components/Card.tsx"), "export const card = tokens.color.surface;\n");
    });
    claude.edits.push(() => {});
    const result = await sync({ link: "always" });
    assert.equal(result?.link, "reverted");
    assert.equal(claude.requests.length, 2, "one fix turn");
    assert.match(claude.requests[1].prompt, /fix the type check/);
    assert.ok(read("src/components/Card.tsx").includes("'#ffffff'"), "the component is back");
    assert.equal(
        git(workspace.appSrcDir, "log", "-1", "--format=%s").trim(),
        "penforge(token-sync): update src/theme.ts from the design tokens"
    );
});

test("build note: tells the build turns about the token block once it exists", async () => {
    await expoApp();
    assert.equal(await TokenThemeNote.forBuild(workspace), "");
    tokens();
    await sync();
    const note = await TokenThemeNote.forBuild(workspace);
    assert.match(note, /app-src\/src\/theme\.ts/);
    assert.match(note, /tokens\.color\.primary/);
    assert.match(note, /Never edit that block/);
});

test("reader: the script reads sets, resolved values and active themes", async () => {
    tokens();
    const snapshot = await new PenpotTokenReader(context().tools).read();
    assert.equal(snapshot.fileName, "Todo");
    assert.deepEqual(snapshot.activeThemes, ["Light"]);
    assert.equal(snapshot.sets[0].tokens[0].resolved, "#6C5CE7");
});
