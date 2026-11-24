// Writes the bundled design skills (`<skill>/reference/*.md`, `LICENSE`, `SOURCE.json`) from git
// checkouts of their repositories at the pinned commits. Developer tool: it is not part of the
// daemon and not copied to dist. It only reads git objects; nothing of the repositories is run.
//
// The upstream text is written for website code with its own scripts, a browser checker and a
// `Stop` hook. The bundle holds only Markdown prose: front matter, fenced code, the sections not
// listed below and every sentence that names a script, a command, a hook, a kit asset, an HTML
// tag or attribute or WebGL are left out. `SOURCE.json` records the hash of each upstream file and
// of the file written here.
//
// Usage (from mcp/packages/server):
//   node src/agent/skills/build-bundle.mjs <folder with taste-skill/ and no-ai-slop/ checkouts>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `sections`: level-2 headings kept (`true` = all); `drop`: headings of any level left out. */
const SKILLS = [
    {
        name: "taste-skill",
        url: "https://github.com/Leonxlnx/taste-skill",
        commit: "6c0b5c78f5d31776e2210305abaa210cdc0030bf",
        root: "skills/taste-skill",
        strict: true,
        files: [
            {
                file: "overview.md",
                from: "SKILL.md",
                sections: [
                    "House rules",
                    "1. The kind of business decides everything",
                    "2. The page plan by kind",
                    "6. Never",
                ],
            },
            {
                file: "layout.md",
                from: "references/layout-v4.md",
                sections: [
                    "1. What the good sites do",
                    "2. One section per screen",
                    "3. The hero",
                    "4. Equal edges and the grid",
                    "5. Type",
                ],
            },
            {
                file: "sections.md",
                from: "references/sections.md",
                sections: ["1. Plan in screens", "3. The plans", "4. Place", "5. Visuals"],
                drop: ["The deal"],
            },
            {
                file: "system.md",
                from: "references/system.md",
                sections: [
                    "Base",
                    "Type",
                    "Colour",
                    "Radius and buttons",
                    "Nav",
                    "Footer",
                    "Cards, lists and forms",
                    "Forms",
                    "Access",
                ],
            },
            {
                file: "cards.md",
                from: "references/cards.md",
                sections: [
                    "Why theirs look expensive",
                    "The card",
                    "Two levels, never three",
                    "The panel",
                    "The fragment on it",
                    "Edges and fades",
                    "Never",
                ],
            },
            {
                file: "photos.md",
                from: "references/photos.md",
                sections: ["Place them", "Credits and words (PH-38, CO-22)", "Never"],
            },
            {
                file: "grounds.md",
                from: "references/backgrounds.md",
                sections: ["The three tokens (every kind)", "Other kinds stay flat"],
            },
            {
                file: "icons.md",
                from: "references/icons.md",
                sections: ["Which one", "How they sit"],
                drop: ["The violet rule (a judgement, stated)"],
            },
            {
                file: "diagrams.md",
                from: "references/diagrams.md",
                sections: ["When a diagram, when a UI fragment", "Labels plain"],
            },
            {
                file: "motion.md",
                from: "references/motion.md",
                sections: [
                    "The rule: every page moves, in three places",
                    "The hover layer",
                    "Reduced motion, no script, phones",
                    "Never",
                ],
            },
            { file: "copy.md", from: "references/copy.md", sections: true },
            { file: "copy-voice.md", from: "references/copy-voice.md", sections: true, drop: ["6. Check"] },
            { file: "copy-registers.md", from: "references/copy-registers.md", sections: true },
            { file: "copy-moves.md", from: "references/copy-moves.md", sections: true },
            { file: "copy-tells.md", from: "references/copy-tells.md", sections: true },
        ],
    },
    {
        name: "no-ai-slop",
        url: "https://github.com/petergyang/no-ai-slop",
        commit: "000650b156983f5159695b441477f4e63b25dc85",
        root: "skills/no-ai-slop",
        strict: false,
        files: [
            { file: "rules.md", from: "SKILL.md", sections: ["Editing principles", "Words to cut", "Patterns to cut"] },
            {
                file: "checks.md",
                from: "eval.md",
                sections: ["Editing principles", "Words to cut", "Patterns to cut", "Final read"],
                left: /What changed|detect requests/i,
            },
        ],
    },
];

/** sentences that only make sense with upstream's scripts, hooks, browser checker or asset kit */
const STRICT_LEFT_OUT =
    /\.mjs|\.js\b|\.css\b|\.html\b|\.json\b|\bnode\b|\bnpx\b|ffmpeg|<skill>|copy-lint|consistency|\bchecker\b|\bgate\b|\bhooks?\b|starter|assets\/|data-[a-z*]+|<\/?[a-z]+[ >]|`[^`]*=[^`]*`|WebGL|\bshader|\bscript\b|aria-|\bdeal(?:s|t|er|ers)?\b(?=[^.]*`)|--(?:type|kind|has|axis|page)\b|\bfetch\b|\bscan\b|\blint\b|\bsvh\b|\blvh\b|svh\b|\bFAIL/i;

class MarkdownTrimmer {
    constructor(spec, strict) {
        this.spec = spec;
        this.strict = strict;
    }

    run(source) {
        const text = source
            .replace(/\r\n/g, "\n")
            .replace(/^---\n[\s\S]*?\n---\n/, "")
            .replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*\n/gm, "");
        const title = /^# (.+)$/m.exec(text)?.[1] ?? this.spec.file;
        const out = [`# ${title}`];
        for (const section of this.sections(text)) {
            const body = this.units(section.body)
                .map((unit) => this.trim(unit))
                .filter((unit) => unit !== null)
                .join("\n");
            const clean = body.replace(/\n{3,}/g, "\n\n").trim();
            if (clean.length > 0) {
                out.push(`${"#".repeat(section.level)} ${section.title}\n\n${clean}`);
            }
        }
        return `${out.join("\n\n")}\n`;
    }

    sections(text) {
        const found = [];
        let keep = false;
        for (const part of text.split(/^(?=#{2,3} )/m).slice(1)) {
            const [, hashes, title] = /^(#{2,3}) (.+)\n/.exec(part);
            if (hashes.length === 2) {
                keep = this.spec.sections === true || this.spec.sections.includes(title);
            }
            if (keep && !(this.spec.drop ?? []).includes(title)) {
                found.push({ level: hashes.length, title, body: part.slice(part.indexOf("\n") + 1) });
            }
        }
        if (Array.isArray(this.spec.sections)) {
            for (const wanted of this.spec.sections) {
                if (!found.some((section) => section.title === wanted)) {
                    throw new Error(`${this.spec.from}: section ${JSON.stringify(wanted)} not found`);
                }
            }
        }
        return found;
    }

    /** Splits a section into list items, table rows, paragraphs and blank lines. */
    units(body) {
        const units = [];
        let open = false;
        for (const line of body.split("\n")) {
            if (line.trim() === "") {
                units.push("");
                open = false;
            } else if (!open || /^\s*(?:[-*] |\d+\. |\|)/.test(line)) {
                units.push(line);
                open = true;
            } else {
                units[units.length - 1] += `\n${line}`;
            }
        }
        return units;
    }

    trim(unit) {
        if (unit === "" || /^\s*\|[\s|:-]+$/.test(unit)) {
            return unit;
        }
        if (!this.leftOut(unit)) {
            return unit;
        }
        if (/^\s*\|/.test(unit)) {
            return null;
        }
        const sentences = unit.split(/(?<=[^\s\d][.!?]["”)*]*)\s+(?=[A-Z"“*`(])/);
        if (this.leftOut(sentences[0])) {
            return null;
        }
        const kept = sentences.filter((sentence) => !this.leftOut(sentence)).join(" ");
        return this.balanced(kept) ? kept : null;
    }

    leftOut(text) {
        return (this.strict && STRICT_LEFT_OUT.test(text)) || (this.spec.left?.test(text) ?? false);
    }

    balanced(text) {
        const count = (pattern) => (text.match(pattern) ?? []).length;
        return count(/\*\*/g) % 2 === 0 && count(/`/g) % 2 === 0 && count(/\(/g) === count(/\)/g);
    }
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const checkouts = process.argv[2];
if (!checkouts) {
    throw new Error("Usage: node src/agent/skills/build-bundle.mjs <folder with the checkouts>");
}
for (const skill of SKILLS) {
    const repository = join(resolve(checkouts), skill.name);
    const git = (...args) =>
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repository, ...args], { maxBuffer: 1 << 26 });
    const blob = (path) => git("cat-file", "blob", `${skill.commit}:${path}`);
    const target = join(HERE, skill.name);
    rmSync(join(target, "reference"), { recursive: true, force: true });
    mkdirSync(join(target, "reference"), { recursive: true });
    const license = blob("LICENSE").toString("utf8").replace(/\r\n/g, "\n");
    writeFileSync(join(target, "LICENSE"), license);
    const files = [
        { file: "LICENSE", upstream: "LICENSE", upstreamSha256: sha256(blob("LICENSE")), sha256: sha256(license) },
    ];
    for (const spec of skill.files) {
        const path = `${skill.root}/${spec.from}`;
        const source = blob(path);
        const text = new MarkdownTrimmer(spec, skill.strict).run(source.toString("utf8"));
        writeFileSync(join(target, "reference", spec.file), text);
        files.push({
            file: `reference/${spec.file}`,
            upstream: path,
            upstreamSha256: sha256(source),
            sha256: sha256(text),
        });
        console.log(`${skill.name}/${spec.file}: ${source.length} -> ${text.length}`);
    }
    const source = {
        name: skill.name,
        url: skill.url,
        commit: skill.commit,
        date: git("show", "-s", "--format=%cI", skill.commit).toString("utf8").trim(),
        license: "MIT",
        modified:
            "Markdown only, shortened by build-bundle.mjs: front matter, code blocks and whatever needs " +
            "upstream's scripts, hooks, browser checker or asset kit is left out. sha256 is of the file here " +
            "(LF line ends), upstreamSha256 of the upstream file. adapter.md is Penforge's own.",
        files,
    };
    writeFileSync(join(target, "SOURCE.json"), `${JSON.stringify(source, null, 2)}\n`);
}
