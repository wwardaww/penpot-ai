import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** What a turn makes: a design on the Penpot canvas or code from an approved design. */
export type SkillTarget = "canvas" | "code";

/** A part of a skill's full text, as {@link SkillLibrary.sections} lists it. */
export interface SkillSection {
    /** `<file>` for a whole file, `<file>/<heading>` for one of its sections */
    id: string;
    title: string;
    chars: number;
}

/**
 * Library of the bundled design skills (W40), independent of the AI provider.
 *
 * A skill is a folder here: `adapter.md` (ours, its summary for the Penpot canvas), `reference/*.md`
 * (shortened upstream text), `LICENSE` and `SOURCE.json`. The summaries of all skills form the core
 * that {@link PromptRegistry} adds to the system prompt of every turn that designs or writes UI;
 * the full text is read with the MCP tool `penforge_skill`. There is no switch for it.
 */
export class SkillLibrary {
    /** names of the bundled skills, in the order of the core */
    public static readonly SKILLS = ["taste-skill", "no-ai-slop"] as const;

    /** workflow prompts whose turns design or write UI, with what they make */
    public static readonly DESIGNING: Readonly<Record<string, SkillTarget>> = {
        chat: "canvas",
        "generate-screen": "canvas",
        "adapt-responsive": "canvas",
        "design-md-draft": "canvas",
        "design-md-import": "canvas",
        "design-system-generate": "canvas",
        "design-system-missing": "canvas",
        "design-system-redesign": "canvas",
        "fix-comment": "canvas",
        "build-run": "code",
        "code-redesign": "code",
        "game-ui-export": "code",
    };

    /**
     * Workflow prompts that read, check, name or sync and so get no core. A new `<name>.prompt.md`
     * must be listed here or in {@link DESIGNING}; a test checks it.
     */
    public static readonly NOT_DESIGNING: ReadonlySet<string> = new Set([
        "audit",
        "auto-name",
        "build-plan",
        "cleanup-import",
        "design-md-export",
        "fix-comments",
        "instruct",
        "project-read",
        "token-sync",
        "visual-qa",
        "wire-prototype",
    ]);

    private static readonly FILE_NAME = /^reference\/([a-z0-9-]+)\.md$/;
    private static readonly NOTICE =
        "> Reference text of %s (MIT licence, shortened). It was written for hand-coded websites: ignore class " +
        "names, files, kits and steps that do not exist here. The order of your design rules holds: the user, " +
        "the project, its design system, then this text.\n\n";

    private readonly cache = new Map<string, string>();

    /**
     * @param dir - folder holding `core.md` and one folder per skill
     */
    constructor(private readonly dir: string) {}

    /**
     * Creates a library on the skills shipped with the daemon.
     *
     * Looks next to this module (running from source) and in `agent/skills/` below the bundle's
     * folder (running from `dist/`).
     */
    public static locate(): SkillLibrary {
        const here = dirname(fileURLToPath(import.meta.url));
        const found = [here, join(here, "agent", "skills")].find((dir) => existsSync(join(dir, "core.md")));
        if (!found) {
            throw new Error(`Penforge design skills not found next to ${here}`);
        }
        return new SkillLibrary(found);
    }

    /**
     * Gets what the turns of a workflow prompt make, or null when they neither design nor write UI.
     *
     * @param workflow - name of the workflow prompt, if the turn has one
     */
    public static targetOf(workflow: string | undefined): SkillTarget | null {
        return workflow !== undefined && Object.hasOwn(SkillLibrary.DESIGNING, workflow)
            ? SkillLibrary.DESIGNING[workflow]
            : null;
    }

    /**
     * Gets the template of the core: the precedence, then the summary of every skill. Its sections
     * `{{#web}}`, `{{#mobile}}`, `{{#game}}`, `{{#canvas}}` and `{{#code}}` are kept when they apply.
     */
    public core(): string {
        return [this.read("core.md"), ...SkillLibrary.SKILLS.map((skill) => this.read(join(skill, "adapter.md")))]
            .map((part) => part.trim())
            .join("\n\n");
    }

    /**
     * Lists the parts of a skill's full text.
     *
     * @param skill - name of the skill
     */
    public sections(skill: string): SkillSection[] {
        return this.parts(skill).map(({ id, title, text }) => ({ id, title, chars: text.length }));
    }

    /**
     * Gets a part of a skill's full text. The part is looked up in the list of bundled parts; the
     * id never becomes a file path.
     *
     * @param skill - name of the skill
     * @param section - id of the part, as {@link sections} lists it
     */
    public text(skill: string, section: string): string {
        const part = this.parts(skill).find(({ id }) => id === section);
        if (!part) {
            throw new Error(
                `Unknown section ${JSON.stringify(section)} of ${skill}; call without a section for the list`
            );
        }
        return SkillLibrary.NOTICE.replace("%s", skill) + part.text;
    }

    /** Splits the bundled files of a skill into whole files and their level-2 sections. */
    private parts(skill: string): { id: string; title: string; text: string }[] {
        if (!(SkillLibrary.SKILLS as readonly string[]).includes(skill)) {
            throw new Error(`Unknown skill ${JSON.stringify(skill)}; one of ${SkillLibrary.SKILLS.join(", ")}`);
        }
        const source = JSON.parse(this.read(join(skill, "SOURCE.json"))) as { files: { file: string }[] };
        return source.files.flatMap(({ file }) => {
            const name = SkillLibrary.FILE_NAME.exec(file)?.[1];
            if (name === undefined) {
                return [];
            }
            const text = this.read(join(skill, "reference", `${name}.md`));
            const sections = text
                .split(/^(?=## )/m)
                .filter((part) => part.startsWith("## "))
                .map((part) => {
                    const title = part.slice(3, part.indexOf("\n")).trim();
                    return { id: `${name}/${SkillLibrary.slug(title)}`, title, text: part };
                });
            return [{ id: name, title: /^# (.+)$/m.exec(text)?.[1] ?? name, text }, ...sections];
        });
    }

    private static slug(title: string): string {
        return title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    }

    private read(path: string): string {
        let content = this.cache.get(path);
        if (content === undefined) {
            content = readFileSync(join(this.dir, path), "utf8").replace(/\r\n/g, "\n");
            this.cache.set(path, content);
        }
        return content;
    }
}
