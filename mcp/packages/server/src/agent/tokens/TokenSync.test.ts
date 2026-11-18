import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type {
    Persona,
    WorkflowClaudeRequest,
    WorkflowClaudeResult,
    WorkflowContext,
    WorkflowQuestion,
    WorkflowToolResult,
} from "@penpot/mcp-common";
import { BuildLock } from "../build/BuildLock";
import type { CommandExecutor, CommandOptions, CommandOutcome } from "../build/CommandExecutor";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { DesignTokens, type PenpotTokenSnapshot } from "./DesignTokens";
import { PenpotTokenReader } from "./PenpotTokenReader";
import { SourceFiles } from "./SourceFiles";
import { ThemeBlock } from "./ThemeBlock";
import { ThemeGenerator } from "./ThemeGenerator";
import { ThemeModel } from "./ThemeModel";
import { ThemeLocator } from "./ThemeTarget";
import { TokenManifest } from "./TokenManifest";
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

    public remove(name: string): void {
        for (const set of this.sets) {
            set.tokens = set.tokens.filter((t) => t.name !== name);
        }
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
    /** answers every check when set (the app folder decides the outcome) */
    public script: ((cwd: string) => CommandOutcome) | null = null;

    public async execute(argv: string[], options: CommandOptions): Promise<CommandOutcome> {
        this.calls.push(argv.join(" "));
        if (this.script) {
            return this.script(options.cwd);
        }
        if (this.failures > 0) {
            this.failures--;
            return { code: 2, output: "src/theme.ts(3,1): error TS2451: Cannot redeclare", timedOut: false };
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
let answers: string[];
let questions: WorkflowQuestion[];

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
        ask: async (question) => {
            questions.push(question);
            const answer = answers.shift();
            if (answer === undefined) {
                throw new Error("no questions expected");
            }
            return answer;
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
    return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });
}

function commitAll(message = "build"): void {
    git(workspace.appSrcDir, "add", "-A");
    git(workspace.appSrcDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
}

const EXPO_THEME = `import type { TextStyle } from 'react-native';

/** Design tokens taken from the Penpot board "iPhone" (390×844). */
export const colors = {
  accent: '#6c5ce7',
  surface: '#ffffff',
} as const;
`;

async function stackJson(extra: Record<string, unknown> = {}): Promise<void> {
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
        ...extra,
    });
}

/** Expo app like the one W08 builds, with its own `src/theme.ts`, committed. */
async function expoApp(theme: string = EXPO_THEME): Promise<void> {
    write("package.json", JSON.stringify({ dependencies: { expo: "~54.0.0", "react-native": "0.81.0" } }));
    write("tsconfig.json", "{}\n");
    write("src/theme.ts", theme);
    write(
        "src/components/Card.tsx",
        "import { colors } from '../theme';\nexport const card = { backgroundColor: '#ffffff' };\n"
    );
    commitAll();
    await stackJson();
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
    answers = [];
    questions = [];
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

function single(name: string, type: string, resolved: unknown): PenpotTokenSnapshot {
    return {
        fileName: "",
        activeThemes: [],
        sets: [{ name: "s", active: true, tokens: [{ name, type, value: "", resolved, description: "" }] }],
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
    const dtcg = JSON.parse(JSON.stringify(tokens.toDtcg()));
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

test("tokens: prototype names are refused and never reach Object.prototype", () => {
    const tokens = DesignTokens.fromSnapshot({
        fileName: "",
        activeThemes: [],
        sets: [
            {
                name: "s",
                active: true,
                tokens: [
                    { name: "__proto__.isError", type: "color", value: "", resolved: "#ffffff", description: "" },
                    { name: "color.constructor.x", type: "color", value: "", resolved: "#ffffff", description: "" },
                    { name: "color.prototype", type: "color", value: "", resolved: "#ffffff", description: "" },
                    { name: "color.$value", type: "color", value: "", resolved: "#ffffff", description: "" },
                    { name: "bad\nname", type: "color", value: "", resolved: "#ffffff", description: "" },
                    { name: "color.ok", type: "color", value: "", resolved: "#ffffff", description: "" },
                ],
            },
        ],
    });
    assert.deepEqual(
        tokens.tokens.map((t) => t.name),
        ["color.ok"]
    );
    assert.deepEqual(
        tokens.refused.map((t) => t.reason),
        ["name", "name", "name", "name", "name"]
    );
    const dtcg = tokens.toDtcg();
    assert.equal(({} as any).isError, undefined);
    assert.equal(Object.getPrototypeOf(dtcg), null);
    assert.equal(JSON.parse(JSON.stringify(dtcg)).color.ok.$value, "#ffffff");
});

test("tokens: values that are not plain values of their type are refused", () => {
    const refused = (type: string, resolved: unknown) =>
        DesignTokens.fromSnapshot(single("t", type, resolved)).refused.length === 1;
    assert.ok(refused("color", "red;} body{background:url(x)"));
    assert.ok(refused("color", '@plugin "./x.js"'));
    assert.ok(refused("color", "#12345"));
    assert.ok(refused("textCase", "uppercase;}"));
    assert.ok(refused("textDecoration", "underline\n}"));
    assert.ok(refused("fontFamilies", ['Inter", sans-serif; } @import "x']));
    assert.ok(refused("spacing", "16px; color: red"));
    assert.ok(refused("shadow", [{ color: "red;}", offsetX: 0, offsetY: 0, blur: 0, spread: 0 }]));
    assert.ok(
        refused("typography", [{ fontFamilies: ["Inter"], fontSizes: 16, textCase: "upper}" }]),
        "a bad part refuses the whole typography"
    );
    const ok = (type: string, resolved: unknown) =>
        DesignTokens.fromSnapshot(single("t", type, resolved)).tokens[0]?.value;
    assert.deepEqual(ok("color", "rgba(0, 0, 0, 0.5)"), { kind: "color", value: "rgba(0, 0, 0, 0.5)" });
    assert.deepEqual(ok("color", "Transparent"), { kind: "color", value: "transparent" });
    assert.deepEqual(ok("textCase", "Uppercase"), { kind: "string", value: "uppercase" });
    assert.deepEqual(ok("fontFamilies", ["Plus Jakarta Sans", "sans-serif"]), {
        kind: "fontFamily",
        value: ["Plus Jakarta Sans", "sans-serif"],
    });
    assert.equal(DesignTokens.checkValue({ kind: "color", value: "red;}" }), null);
    assert.equal(DesignTokens.checkValue({ kind: "string", value: "x" }), null);
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
    assert.equal(ThemeGenerator.create("react-native").reference(spacing), 'tokens.spacing["2xl"]');
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

test("generator: React Native theme object uses numbers, px line heights and JSON strings", () => {
    const text = ThemeGenerator.create("react-native", "ts").render(sampleModel()).join("\n");
    assert.match(text, /^export const tokens = \{/);
    assert.match(text, /primary: "#6c5ce7",/);
    assert.match(text, /md: 16,/);
    assert.match(text, /card: 24,/);
    assert.match(text, /card: "0px 4px 14px 0px rgba\(26, 27, 46, 0\.05\)",/);
    assert.match(
        text,
        /title: \{ fontFamily: "Plus Jakarta Sans", fontSize: 24, fontWeight: "700", lineHeight: 29, letterSpacing: 0 \},/
    );
    assert.match(text, /\} as const;$/);
    assert.match(ThemeGenerator.create("react-native", "ts", "designTokens").render(sampleModel())[0], /designTokens/);
});

test("generator: web object, CSS variables and Tailwind v4 theme", () => {
    const model = sampleModel();
    const web = ThemeGenerator.create("js-web", "esm").render(model).join("\n");
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

test("locator: Expo app uses its own src/theme.ts; no theme file means no target", async () => {
    await expoApp();
    const expo = await ThemeLocator.locate(workspace.appSrcDir, { name: "Expo" });
    assert.ok(expo);
    assert.deepEqual(
        [expo.file, expo.format, expo.module, expo.objectName],
        ["src/theme.ts", "react-native", "ts", "tokens"]
    );

    rmSync(workspace.appSrcDir, { recursive: true, force: true });
    mkdirSync(workspace.appSrcDir, { recursive: true });
    write("package.json", JSON.stringify({ devDependencies: { "@tailwindcss/vite": "^4.1.0" } }));
    assert.equal(await ThemeLocator.locate(workspace.appSrcDir, { name: "React + Vite + Tailwind" }), null);

    write("src/index.css", "body {}\n");
    const plain = await ThemeLocator.locate(workspace.appSrcDir, { name: "React + Vite" });
    assert.deepEqual([plain?.file, plain?.format], ["src/index.css", "css"], "no Tailwind import: plain CSS");

    await assert.rejects(
        ThemeLocator.locate(workspace.appSrcDir, { themeFile: "../outside.css" }),
        (error: unknown) => error instanceof TokenSyncError && error.code === "unsafe-theme-path"
    );
});

test("locator: Tailwind v4 tokens go to the stylesheet that imports Tailwind", async () => {
    write(
        "package.json",
        JSON.stringify({ devDependencies: { tailwindcss: "^4.1.0", "@tailwindcss/vite": "^4.1.0" } })
    );
    write("src/theme.css", ":root { --x: 1px; }\n");
    write("src/styles/app.css", '@import "tailwindcss";\n\nbody { margin: 0; }\n');
    const target = await ThemeLocator.locate(workspace.appSrcDir, { name: "React + Vite + Tailwind" });
    assert.deepEqual([target?.file, target?.format], ["src/styles/app.css", "tailwind"]);
    const recorded = await ThemeLocator.locate(workspace.appSrcDir, {
        themeFile: "src/theme.css",
        themeFormat: "tailwind",
    });
    assert.equal(recorded?.format, "css", "a recorded tailwind format needs the Tailwind import");
});

test("locator: an existing `tokens` declaration gets another object name, kept later", () => {
    assert.equal(ThemeLocator.objectName("export const tokens = { a: 1 };\n"), "designTokens");
    assert.equal(ThemeLocator.objectName("import { tokens } from './other';\n"), "designTokens");
    assert.equal(
        ThemeLocator.objectName("import { foo as tokens } from './x';\nconst designTokens = 1;\n"),
        "penpotTokens"
    );
    const withBlock = ThemeBlock.write(
        "export const tokens = { a: 1 };\n",
        ["export const designTokens = {} as const;"],
        "line",
        "js"
    );
    assert.equal(ThemeLocator.objectName(withBlock), "designTokens");
    assert.equal(ThemeLocator.objectName("const colors = {};\n"), "tokens");
    assert.equal(ThemeLocator.objectName("import { tokens as t } from './x';\n"), "tokens");
});

test("locator and sources: links are never followed", async () => {
    const outside = join(home, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "theme.ts"), "export const x = 1;\n");
    write("package.json", JSON.stringify({ dependencies: { expo: "~54.0.0" } }));
    symlinkSync(outside, join(workspace.appSrcDir, "src"), "junction");
    assert.equal(await ThemeLocator.locate(workspace.appSrcDir, { name: "Expo" }), null);
    await assert.rejects(
        ThemeLocator.locate(workspace.appSrcDir, { themeFile: "src/theme.ts" }),
        (error: unknown) => error instanceof TokenSyncError && error.code === "unsafe-theme-path"
    );
    symlinkSync(workspace.appSrcDir, join(outside, "loop"), "junction");
    const files = await SourceFiles.list(workspace.appSrcDir, new Set([".ts", ".json"]));
    assert.deepEqual(
        files.map((f) => f.file),
        ["package.json"]
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
    assert.equal(result.link, null, "no Claude pass by default");
    assert.equal(claude.requests.length, 0);

    const theme = read("src/theme.ts");
    assert.ok(theme.includes("export const colors = {"), "the build's theme stays");
    assert.ok(theme.includes('primary: "#6c5ce7",'));
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
    const manifest = await TokenManifest.read(workspace);
    assert.deepEqual(manifest?.sets, ["core"]);
    assert.equal(manifest?.tokens.get("color.primary")?.key, "primary");
});

test("sync: a changed color token updates the block; a second run changes nothing", async () => {
    await expoApp();
    tokens();
    await sync();
    const commits = git(workspace.appSrcDir, "rev-list", "--count", "HEAD").trim();

    penpot.token("color.primary").resolvedValue = "#ff0000";
    const changed = await sync({ trigger: "watch" });
    assert.equal(changed?.outcome, "updated");
    assert.deepEqual(changed?.changes, { added: [], changed: ["color.primary"], removed: [] });
    assert.ok(read("src/theme.ts").includes('primary: "#ff0000",'));
    assert.equal(Number(git(workspace.appSrcDir, "rev-list", "--count", "HEAD")), Number(commits) + 1);

    const same = await sync();
    assert.equal(same?.outcome, "unchanged");
    assert.equal(same?.themeChanged, false);
    assert.equal(same?.commits.appSrc, null);
    assert.equal(same?.commits.design, null);
});

test("sync: an app built before W21 that declares `tokens` keeps compiling", async () => {
    await expoApp(`${EXPO_THEME}\nexport const tokens = { gap: 8 } as const;\n`);
    tokens();
    const result = await sync();
    assert.equal(result?.outcome, "updated");
    const theme = read("src/theme.ts");
    assert.match(theme, /export const designTokens = \{/);
    assert.match(theme, /export const tokens = \{ gap: 8 \} as const;/);
    penpot.token("color.primary").resolvedValue = "#ff0000";
    await sync();
    assert.match(read("src/theme.ts"), /export const designTokens = \{/, "the name stays");
    assert.match(await TokenThemeNote.forBuild(workspace), /designTokens\.color\.primary/);
});

test("sync: a theme change that fails the type check is put back", async () => {
    await expoApp();
    tokens();
    mkdirSync(join(workspace.appSrcDir, "node_modules"));
    executor.failures = 1;
    await assert.rejects(sync({ trigger: "watch" }));
    assert.equal(events.find((e) => e.kind === "failed")?.payload.code, "theme-check-failed");
    assert.equal(read("src/theme.ts"), EXPO_THEME);
    assert.equal(await TokenManifest.read(workspace), null, "nothing recorded");

    executor.failures = 1;
    events = [];
    const summary = await new TokenSync(context(), { preBuild: true }, { executor }).run();
    assert.match(summary?.summary ?? "", /Token sync skipped/, "a build goes on");
    assert.equal(read("src/theme.ts"), EXPO_THEME);
});

test("sync: type errors the app already had do not stop the theme; new ones do", async () => {
    await expoApp();
    tokens();
    mkdirSync(join(workspace.appSrcDir, "node_modules"));
    const old = "src/screens/Home.tsx(12,3): error TS2322: Type 'string' is not assignable to type 'number'.";
    executor.script = (cwd) => {
        const theme = readFileSync(join(cwd, "src/theme.ts"), "utf8");
        // the block moves lines, so the same error shows at another position
        const lines = [ThemeBlock.has(theme) ? old.replace("(12,3)", "(40,3)") : old];
        if (theme.includes('"#ff0000"')) {
            lines.push("src/theme.ts(9,5): error TS2451: Cannot redeclare block-scoped variable 'x'.");
        }
        return { code: 2, output: lines.join("\n"), timedOut: false };
    };
    const result = await sync();
    assert.equal(result?.outcome, "updated");
    assert.equal(result?.preexistingErrors, 1);
    assert.ok(read("src/theme.ts").includes('primary: "#6c5ce7",'));
    assert.match(TokenSync.summary(result!), /already had 1 type error/);

    penpot.token("color.primary").resolvedValue = "#ff0000";
    const before = read("src/theme.ts");
    await assert.rejects(sync({ trigger: "watch" }));
    assert.equal(events.find((e) => e.kind === "failed")?.payload.code, "theme-check-failed");
    assert.equal(read("src/theme.ts"), before, "a new error puts the theme back");
});

test("sync: no type check when the block does not change", async () => {
    await expoApp();
    tokens();
    mkdirSync(join(workspace.appSrcDir, "node_modules"));
    await sync();
    const checks = executor.calls.length;
    assert.equal((await sync({ trigger: "watch" }))?.outcome, "unchanged");
    assert.equal(executor.calls.length, checks);
});

test("sync: a block no recorded sync wrote is replaced only after asking", async () => {
    await expoApp();
    tokens();
    await sync();
    rmSync(join(workspace.metaDir, TokenManifest.FILE));
    assert.equal((await sync({ trigger: "watch" }))?.outcome, "unchanged", "the same block needs no question");

    write("src/theme.ts", read("src/theme.ts").replace("md: 16,", "md: 20,"));
    commitAll("older block");
    assert.equal((await sync({ trigger: "watch" }))?.outcome, "block-edited");
    assert.match(read("src/theme.ts"), /md: 20,/);
    answers = ["keep"];
    assert.equal((await sync())?.outcome, "block-edited");
    answers = ["replace"];
    assert.equal((await sync())?.outcome, "updated");
    assert.match(read("src/theme.ts"), /md: 16,/);
    assert.equal(questions.length, 2);
});

test("sync: before the scaffold nothing is written to the app or pinned", async () => {
    await stackJson();
    tokens();
    const result = await sync({ preBuild: true });
    assert.equal(result, undefined, "no events inside a build");
    assert.equal(existsSync(join(workspace.appSrcDir, "src")), false);
    assert.equal((await workspace.readJson<any>("stack.json", null)).themeFile, undefined);
    const manual = await sync();
    assert.equal(manual?.outcome, "no-app");

    write("package.json", JSON.stringify({ dependencies: { react: "19" } }));
    assert.equal((await sync())?.outcome, "no-theme", "an app without a theme file gets none");
});

test("sync: the app follows the chosen sets; switching themes in Penpot is not followed", async () => {
    await expoApp();
    tokens();
    penpot.set("dark", false, [["color.primary", "color", "#000000"]]);
    await sync();
    penpot.sets[1].active = true;
    const watched = await sync({ trigger: "watch" });
    assert.equal(watched?.outcome, "selection-changed");
    assert.deepEqual(watched?.followedSets, ["core"]);
    assert.ok(read("src/theme.ts").includes('primary: "#6c5ce7",'));
    events = [];
    await new TokenSync(context(), { preBuild: true }, { executor }).run();
    assert.ok(read("src/theme.ts").includes('primary: "#6c5ce7",'), "nor before a build");

    const manual = await sync();
    assert.equal(manual?.outcome, "updated");
    assert.ok(read("src/theme.ts").includes('primary: "#000000",'));
    assert.deepEqual((await TokenManifest.read(workspace))?.sets, ["core", "dark"]);
});

test("sync: tokens that left Penpot stay while the code uses them; names never move", async () => {
    await expoApp();
    tokens();
    await sync();
    write("src/components/Card.tsx", "import { tokens } from '../theme';\nexport const c = tokens.color.surface;\n");
    commitAll("use surface");

    penpot.remove("color.surface");
    penpot.remove("color.primary");
    penpot.sets[0].tokens.push({
        name: "colors.primary",
        type: "color",
        value: "#123456",
        resolvedValue: "#123456",
        description: "",
    });
    const result = await sync();
    assert.deepEqual(result?.deprecated, ["color.surface"]);
    const theme = read("src/theme.ts");
    assert.match(theme, /\/\/ deprecated: no longer in Penpot; kept while the code uses it\n {4}surface: "#ffffff",/);
    assert.match(theme, /primary2: "#123456",/, "the old name is not given to another token");
    assert.doesNotMatch(theme, /\bprimary: /);

    write("src/components/Card.tsx", "export const c = 1;\n");
    commitAll("drop surface");
    const later = await sync();
    assert.deepEqual(later?.deprecated, []);
    assert.doesNotMatch(read("src/theme.ts"), /surface: "/);
});

test("sync: a block edited by hand is never overwritten without asking", async () => {
    await expoApp();
    tokens();
    await sync();
    write("src/theme.ts", read("src/theme.ts").replace("md: 16,", "md: 18,"));
    commitAll("hand edit");
    penpot.token("color.primary").resolvedValue = "#ff0000";

    const watched = await sync({ trigger: "watch" });
    assert.equal(watched?.outcome, "block-edited");
    assert.match(read("src/theme.ts"), /md: 18,/);

    answers = ["keep"];
    assert.equal((await sync())?.outcome, "block-edited");
    assert.equal(questions.length, 1);
    assert.match(read("src/theme.ts"), /md: 18,/);

    answers = ["replace"];
    assert.equal((await sync())?.outcome, "updated");
    assert.match(read("src/theme.ts"), /md: 16,/);
    assert.match(read("src/theme.ts"), /primary: "#ff0000",/);
});

test("sync: a theme file with other unsaved edits is updated but not committed", async () => {
    await expoApp();
    tokens();
    write("src/theme.ts", `${EXPO_THEME}export const extra = 1;\n`);
    const head = git(workspace.appSrcDir, "rev-parse", "HEAD").trim();
    const result = await sync();
    assert.deepEqual(result?.uncommitted, ["src/theme.ts"]);
    assert.equal(result?.commits.appSrc, null);
    assert.equal(git(workspace.appSrcDir, "rev-parse", "HEAD").trim(), head);
    assert.match(read("src/theme.ts"), /export const extra = 1;/);
    assert.match(read("src/theme.ts"), /penforge:tokens:begin/);
});

test("sync: the watcher skips projects without an app; no tokens is reported", async () => {
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
                .replace('primary: "#6c5ce7",', 'primary: "#000000",')
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
    assert.ok(theme.includes('primary: "#6c5ce7",'), "the block edit was undone");
    assert.deepEqual(executor.calls, ["npx tsc --noEmit", "npx tsc --noEmit"], "after the theme and after Claude");
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

test("sync with link: broken markers put the theme file back before the block", async () => {
    await expoApp();
    tokens();
    claude.edits.push((appSrc) => {
        const theme = readFileSync(join(appSrc, "src/theme.ts"), "utf8");
        writeFileSync(join(appSrc, "src/theme.ts"), theme.replace("// penforge:tokens:end", "export const oops = 1;"));
    });
    await sync({ link: "always" });
    const theme = read("src/theme.ts");
    assert.equal(theme.split("export const tokens").length, 2, "one declaration");
    assert.doesNotMatch(theme, /oops/);
    assert.ok(ThemeBlock.has(theme));
});

test("sync with link: a change that keeps failing the type check is undone", async () => {
    await expoApp();
    tokens();
    mkdirSync(join(workspace.appSrcDir, "node_modules"));
    claude.edits.push((appSrc) => {
        writeFileSync(join(appSrc, "src/components/Card.tsx"), "export const card = tokens.color.surface;\n");
    });
    claude.edits.push(() => {});
    // theme check passes, then the two checks after Claude fail
    executor.failures = 0;
    const original = executor.execute.bind(executor);
    let calls = 0;
    executor.execute = async (argv, options) => {
        calls++;
        if (calls > 1) {
            executor.failures = 1;
        }
        return original(argv, options);
    };
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
