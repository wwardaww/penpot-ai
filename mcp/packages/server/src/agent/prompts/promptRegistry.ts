import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Persona, Platform } from "@penpot/mcp-common";

/** Values filled into prompt templates. */
export interface PromptVariables {
    persona: Persona;
    platform: Platform;
    projectName: string;
}

/** Parts of a system prompt. */
export interface PromptRequest extends PromptVariables {
    /** workflow whose `<name>.prompt.md` is added, if it exists */
    workflow?: string;
    /** extra text added at the end (e.g. the tab's context) */
    extra?: string;
}

/**
 * Registry of the daemon's prompt templates.
 *
 * A system prompt is `prompts/base.md`, then `prompts/<persona>.md`, then the workflow's
 * `workflows/<name>.prompt.md`, then extra text. Templates may use the placeholders `{{persona}}`,
 * `{{platform}}` and `{{projectName}}`, and sections `{{#value}} … {{/value}}` that are kept only
 * when `value` is the current persona (`designer`, `developer`) or platform (`web`, `mobile`).
 */
export class PromptRegistry {
    private static readonly NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
    private static readonly SECTION_PATTERN = /\{\{#([a-z0-9-]+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g;
    private readonly cache = new Map<string, string | null>();

    /**
     * @param promptsDir - folder holding `base.md` and the persona prompts
     * @param workflowsDir - folder holding the `<name>.prompt.md` workflow prompts
     */
    constructor(
        private readonly promptsDir: string,
        private readonly workflowsDir: string
    ) {}

    /**
     * Creates a registry on the prompt folders shipped with the daemon.
     *
     * Looks next to this module (running from source) and in `agent/` below the bundle's folder
     * (running from `dist/`).
     */
    public static locate(): PromptRegistry {
        const here = dirname(fileURLToPath(import.meta.url));
        const candidates = [
            { prompts: here, workflows: join(here, "..", "workflows") },
            { prompts: join(here, "agent", "prompts"), workflows: join(here, "agent", "workflows") },
        ];
        const found = candidates.find((candidate) => existsSync(join(candidate.prompts, "base.md")));
        if (!found) {
            throw new Error(`Penforge prompts not found next to ${here}`);
        }
        return new PromptRegistry(found.prompts, found.workflows);
    }

    /**
     * Builds a system prompt.
     *
     * @param request - persona, platform, project name, workflow and extra text
     */
    public build(request: PromptRequest): string {
        const parts = [
            this.required(join(this.promptsDir, "base.md")),
            this.required(this.personaFile(request.persona)),
        ];
        if (request.workflow) {
            const workflowPrompt = this.workflowPrompt(request.workflow);
            if (workflowPrompt !== null) {
                parts.push(workflowPrompt);
            }
        }
        if (request.extra) {
            parts.push(request.extra);
        }
        return parts.map((part) => this.render(part, request).trim()).join("\n\n") + "\n";
    }

    /**
     * Gets the raw prompt of a workflow.
     *
     * @param name - the workflow name
     * @returns the template, or null if the workflow has none
     */
    public workflowPrompt(name: string): string | null {
        if (!PromptRegistry.NAME_PATTERN.test(name)) {
            throw new Error(`Invalid workflow prompt name ${JSON.stringify(name)}`);
        }
        return this.read(join(this.workflowsDir, `${name}.prompt.md`));
    }

    /**
     * Fills a template.
     *
     * @param template - the template
     * @param variables - the values
     */
    public render(template: string, variables: PromptVariables): string {
        const active = new Set<string>([variables.persona, variables.platform]);
        return template
            .replace(PromptRegistry.SECTION_PATTERN, (_match, key: string, body: string) =>
                active.has(key) ? body : ""
            )
            .replace(/\{\{(persona|platform|projectName)\}\}/g, (_match, key: keyof PromptVariables) =>
                String(variables[key])
            );
    }

    private personaFile(persona: Persona): string {
        if (persona !== "designer" && persona !== "developer") {
            throw new Error(`Unknown persona ${JSON.stringify(persona)}`);
        }
        return join(this.promptsDir, `${persona}.md`);
    }

    private required(file: string): string {
        const content = this.read(file);
        if (content === null) {
            throw new Error(`Prompt file not found: ${file}`);
        }
        return content;
    }

    private read(file: string): string | null {
        if (!this.cache.has(file)) {
            this.cache.set(file, existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null);
        }
        return this.cache.get(file)!;
    }
}
