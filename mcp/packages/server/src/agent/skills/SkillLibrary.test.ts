import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Platform } from "@penpot/mcp-common";
import { PenforgeSkillTool } from "../../tools/penforge/PenforgeSkillTool";
import { ToolSummary } from "../chat/toolSummary";
import { TurnRunner, type TurnSetup } from "../chat/TurnRunner";
import { LinkedToolFilter } from "../linked/LinkedToolFilter";
import { PromptRegistry } from "../prompts/promptRegistry";
import type { ClaudeRunner, RunnerConversation, RunnerInput, RunnerOptions } from "../runner/ClaudeRunner";
import { CommentToolFilter } from "../workflows/fix-comment-fixer";
import { SkillLibrary } from "./SkillLibrary";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, "..");
const REPO = join(HERE, "..", "..", "..", "..", "..", "..");
const MARK = "# Design rules (always on)";
/** files of the folder that are ours and not part of the bundle */
const OWN_CODE = /\.(ts|mjs)$/;

interface Source {
    url: string;
    commit: string;
    date: string;
    license: string;
    files: { file: string; upstream: string; upstreamSha256: string; sha256: string }[];
}

const library = SkillLibrary.locate();
const prompts = PromptRegistry.locate();

function filesBelow(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? filesBelow(path) : [path];
    });
}

function lf(path: string): string {
    return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function source(skill: string): Source {
    return JSON.parse(lf(join(HERE, skill, "SOURCE.json"))) as Source;
}

function prompt(workflow: string | undefined, platform: Platform = "web"): string {
    return prompts.build({ persona: "designer", platform, projectName: "Shop", workflow, extra: "## Tab" });
}

function core(workflow: string, platform: Platform = "web"): string {
    const text = prompt(workflow, platform);
    return text.slice(text.indexOf(MARK), text.indexOf("## Tab"));
}

test("every workflow prompt is listed as designing or not designing", () => {
    const names = readdirSync(join(AGENT, "workflows"))
        .filter((name) => name.endsWith(".prompt.md"))
        .map((name) => name.replace(/\.prompt\.md$/, ""))
        .sort();
    const listed = [...Object.keys(SkillLibrary.DESIGNING), ...SkillLibrary.NOT_DESIGNING];
    for (const name of names) {
        assert.ok(
            listed.includes(name),
            `src/agent/workflows/${name}.prompt.md is not listed: in src/agent/skills/SkillLibrary.ts add "${name}" ` +
                `to SkillLibrary.DESIGNING (its turns design or write UI) or to SkillLibrary.NOT_DESIGNING`
        );
    }
    // an entry of NOT_DESIGNING may come before its file: it changes nothing
    for (const name of Object.keys(SkillLibrary.DESIGNING)) {
        assert.ok(
            names.includes(name),
            `src/agent/skills/SkillLibrary.ts lists "${name}" in DESIGNING, but ` +
                `src/agent/workflows/${name}.prompt.md does not exist: remove the entry`
        );
    }
    assert.equal(new Set(listed).size, listed.length, "a workflow prompt is listed twice in SkillLibrary.ts");
});

test("turns that design or write UI get the core once, the others never", () => {
    for (const workflow of Object.keys(SkillLibrary.DESIGNING)) {
        assert.equal(prompt(workflow).split(MARK).length, 2, workflow);
    }
    for (const workflow of SkillLibrary.NOT_DESIGNING) {
        assert.ok(!prompt(workflow).includes(MARK), workflow);
    }
    assert.ok(!prompt(undefined).includes(MARK));
    assert.ok(!prompt("to-string").includes(MARK));
    assert.equal(SkillLibrary.targetOf("constructor"), null);
});

test("the core follows the workflow's prompt and comes before the tab context", () => {
    const text = prompt("chat");
    assert.ok(text.indexOf("Task: free chat") < text.indexOf(MARK));
    assert.ok(text.indexOf(MARK) < text.indexOf("## Tab"));
});

test("the core states the order of precedence", () => {
    const flat = core("chat").replace(/\s+/g, " ");
    assert.match(
        flat,
        /the user's words; the project's brief, fonts and DESIGN\.md; the linked design system; these rules; your own taste/
    );
});

test("the core keeps only the rules of the platform and of what the turn makes", () => {
    assert.match(core("generate-screen"), /\*\*Web pages and sites:\*\*/);
    assert.doesNotMatch(core("generate-screen"), /\*\*Game UI:\*\*|\*\*Mobile screens:\*\*/);
    assert.match(core("generate-screen", "game"), /\*\*Game UI:\*\*/);
    assert.doesNotMatch(core("generate-screen", "game"), /\*\*Web pages and sites:\*\*/);
    assert.match(core("generate-screen", "mobile"), /\*\*Mobile screens:\*\*/);
    assert.match(core("generate-screen"), /penforge_skill/);
    assert.doesNotMatch(core("generate-screen"), /In code the approved design/);
    assert.match(core("build-run"), /In code the approved design comes first/);
    for (const workflow of Object.keys(SkillLibrary.DESIGNING)) {
        assert.doesNotMatch(core(workflow), /\{\{/);
    }
});

test("the core stays below 2.5k tokens", () => {
    for (const workflow of Object.keys(SkillLibrary.DESIGNING)) {
        for (const platform of ["web", "mobile", "game"] as Platform[]) {
            // 3 characters per token is a pessimistic count for English with some Turkish
            assert.ok(core(workflow, platform).length / 3 <= 2500, `${workflow} ${platform}`);
        }
    }
});

test("the core reaches any runner as plain system prompt text", async () => {
    const seen: string[] = [];
    const runner = {
        async *send(_conversation: RunnerConversation, _input: RunnerInput, options: RunnerOptions) {
            seen.push(options.systemPromptAppend);
        },
    } as unknown as ClaudeRunner;
    const root = mkdtempSync(join(tmpdir(), "penforge-skill-"));
    try {
        const turns = new TurnRunner(runner, prompts);
        const setup = {
            context: { persona: "designer", platform: "web", fileId: "f", fileName: "File", pageId: "p" },
            workspace: { root, metaDir: join(root, ".penforge"), linked: null, linkedRoot: null },
            permissions: {},
            tools: null,
        } as unknown as TurnSetup;
        for (const workflow of ["chat", "generate-screen"]) {
            for await (const _event of turns.run(setup, { id: "c" }, { text: "hi", workflow })) {
                // no events
            }
        }
        assert.equal(seen.length, 2);
        for (const text of seen) {
            assert.ok(text.includes(MARK));
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the bundled files match the pinned sources", () => {
    const commits = {
        "taste-skill": "6c0b5c78f5d31776e2210305abaa210cdc0030bf",
        "no-ai-slop": "000650b156983f5159695b441477f4e63b25dc85",
    };
    for (const skill of SkillLibrary.SKILLS) {
        const { commit, license, files, url, date } = source(skill);
        assert.equal(commit, commits[skill]);
        assert.equal(license, "MIT");
        assert.match(url, /^https:\/\/github\.com\//);
        assert.match(date, /^2026-/);
        for (const { file, sha256, upstreamSha256 } of files) {
            const actual = createHash("sha256")
                .update(lf(join(HERE, skill, file)))
                .digest("hex");
            assert.equal(actual, sha256, `${skill}/${file}`);
            assert.match(upstreamSha256, /^[0-9a-f]{64}$/);
        }
        const present = filesBelow(join(HERE, skill))
            .map((path) => relative(join(HERE, skill), path).split("\\").join("/"))
            .sort();
        assert.deepEqual(present, ["SOURCE.json", "adapter.md", ...files.map(({ file }) => file)].sort());
        assert.match(lf(join(HERE, skill, "LICENSE")), /MIT License[\s\S]*Permission is hereby granted/);
    }
});

test("the bundle holds no scripts, hooks, commands or media", () => {
    for (const path of filesBelow(HERE).filter((file) => !OWN_CODE.test(file))) {
        assert.match(path, /(?:\.md|SOURCE\.json|LICENSE)$/);
    }
    for (const skill of SkillLibrary.SKILLS) {
        for (const path of filesBelow(join(HERE, skill, "reference"))) {
            const text = lf(path);
            assert.doesNotMatch(text, /^---$/m, `${path}: front matter`);
            assert.doesNotMatch(text, /^\s*(?:```|~~~)/m, `${path}: code block`);
            assert.doesNotMatch(
                text,
                /\.mjs\b|\bnode -|\bnpx\b|\bnpm\b|\bcurl\b|\bbash\b|install\.sh|<script|CLAUDE_|\bStop\b.*hook|hooks?:|<skill>/i,
                path
            );
        }
    }
});

test("the copied assets hold the skills, without code", () => {
    const root = mkdtempSync(join(tmpdir(), "penforge-assets-"));
    try {
        mkdirSync(join(root, "src", "agent"), { recursive: true });
        for (const part of ["prompts", "workflows", "skills"]) {
            cpSync(join(AGENT, part), join(root, "src", "agent", part), { recursive: true });
        }
        const run = spawnSync(process.execPath, [join(AGENT, "copy-assets.mjs")], { cwd: root, encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
        const copied = join(root, "dist", "agent", "skills");
        const expected = filesBelow(HERE)
            .filter((path) => !OWN_CODE.test(path))
            .map((path) => relative(HERE, path))
            .sort();
        const actual = filesBelow(copied)
            .map((path) => relative(copied, path))
            .sort();
        assert.deepEqual(actual, expected);
        assert.ok(new SkillLibrary(copied).core().startsWith(MARK));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the desktop build ships the skills' licences", () => {
    const stage = lf(join(REPO, "desktop", "scripts", "stage.mjs"));
    const notice = lf(join(REPO, "desktop", "build-resources", "license.txt"));
    for (const skill of SkillLibrary.SKILLS) {
        assert.ok(stage.includes(`${skill}-LICENSE.txt`), skill);
        assert.ok(notice.includes(skill), skill);
        assert.ok(existsSync(join(HERE, skill, "LICENSE")));
    }
});

test("penforge_skill lists the parts and returns one of them", async () => {
    const tool = new PenforgeSkillTool({} as never, library);
    const list = await textOf(tool, { name: "taste-skill" });
    assert.match(list, /- `layout`: /);
    assert.match(list, /- `layout\/3-the-hero`: 3\. The hero/);
    const hero = await textOf(tool, { name: "taste-skill", section: "layout/3-the-hero" });
    assert.match(hero, /^> Reference text of taste-skill/);
    assert.match(hero, /## 3\. The hero/);
    assert.doesNotMatch(hero, /## 5\. Type/);
    const rules = await textOf(tool, { name: "no-ai-slop", section: "rules" });
    assert.match(rules, /Patterns to cut/);
});

test("every listed part has its own id and can be read", () => {
    for (const skill of SkillLibrary.SKILLS) {
        const ids = library.sections(skill).map(({ id }) => id);
        assert.equal(new Set(ids).size, ids.length, skill);
        for (const id of ids) {
            assert.ok(library.text(skill, id).length > 200, `${skill}/${id}`);
        }
    }
});

test("penforge_skill refuses paths and unknown names", async () => {
    const tool = new PenforgeSkillTool({} as never, library);
    for (const section of [
        "../core",
        "../../prompts/base",
        "SOURCE.json",
        "LICENSE",
        "C:\\Windows\\win.ini",
        "/etc/passwd",
    ]) {
        await assert.rejects(textOf(tool, { name: "taste-skill", section }), /Unknown section/);
    }
    for (const name of ["..", "../prompts", "taste-skill/../no-ai-slop"]) {
        assert.throws(() => library.sections(name), /Unknown skill/);
        assert.throws(() => library.text(name, "rules"), /Unknown skill/);
    }
});

test("the linked folder's tool filter allows the skill and still denies the rest", () => {
    const root = join(tmpdir(), "linked");
    const filter = new LinkedToolFilter(root, [root], root, true);
    assert.equal(filter.check("mcp__penpot__penforge_skill", { name: "taste-skill" }), null);
    assert.ok(filter.allowedTools.includes("mcp__penpot__penforge_skill"));
    for (const denied of [
        "execute_code",
        "update_design_node",
        "update_prototype",
        "update_animations",
        "import_image",
    ]) {
        assert.notEqual(filter.check(`mcp__penpot__${denied}`, {}), null, denied);
        assert.ok(!filter.allowedTools.includes(`mcp__penpot__${denied}`), denied);
    }
    for (const denied of ["Bash", "WebFetch", "mcp__other__penforge_skill"]) {
        assert.notEqual(filter.check(denied, {}), null, denied);
    }
    assert.notEqual(filter.check("Read", { file_path: join(tmpdir(), "elsewhere", "a.txt") }), null);
    assert.notEqual(filter.check("Write", { file_path: join(tmpdir(), "elsewhere", "a.txt") }), null);

    // without Penpot tools (the project read) the skill is denied as well
    const noPenpot = new LinkedToolFilter(root, [root], null, false);
    assert.notEqual(noPenpot.check("mcp__penpot__penforge_skill", {}), null);
    assert.ok(!noPenpot.allowedTools.some((tool) => tool.startsWith("mcp__penpot__")));
});

test("the comment fixer's tool filter allows the skill and still denies the rest", () => {
    const filter = new CommentToolFilter(false);
    assert.equal(filter.check("mcp__penpot__penforge_skill", { name: "no-ai-slop" }), null);
    assert.equal(CommentToolFilter.changesDesign("mcp__penpot__penforge_skill"), false);
    for (const denied of [
        "mcp__penpot__execute_code",
        "mcp__penpot__resolve_canvas_comment",
        "mcp__penpot__update_prototype",
        "mcp__penpot__update_animations",
        "mcp__penpot__import_image",
        "mcp__other__penforge_skill",
        "Bash",
        "Read",
        "Write",
        "WebFetch",
    ]) {
        assert.notEqual(filter.check(denied, {}), null, denied);
    }
    const structural = new CommentToolFilter(true);
    assert.notEqual(structural.check("mcp__penpot__execute_code", { code: "fetch('x')" }), null);
});

test("the chat names the skill tool in plain words", () => {
    assert.equal(
        ToolSummary.summary("mcp__penpot__penforge_skill", "running", "designer"),
        "Checking the design rules"
    );
    assert.equal(ToolSummary.summary("mcp__penpot__penforge_other", "running", "designer"), "Using Penpot");
});

/** Calls the tool without the server and gets its text. */
async function textOf(tool: PenforgeSkillTool, args: { name: string; section?: string }): Promise<string> {
    const response = await (
        tool as unknown as { executeCore(args: object): Promise<{ content: { text: string }[] }> }
    ).executeCore(args);
    return response.content[0].text;
}
