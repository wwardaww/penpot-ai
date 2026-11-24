import { z } from "zod";
import { Tool } from "../../Tool";
import { TextResponse, type ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { SkillLibrary } from "../../agent/skills/SkillLibrary";

/**
 * Arguments of {@link PenforgeSkillTool}.
 */
export class PenforgeSkillArgs {
    static schema = {
        name: z
            .enum(SkillLibrary.SKILLS)
            .describe("taste-skill = look, layout and page structure; no-ai-slop = texts in the interface."),
        section: z
            .string()
            .min(1)
            .max(120)
            .optional()
            .describe('Part to read, e.g. "layout/3-the-hero" or "layout". Leave out for the list of parts.'),
    };

    name!: (typeof SkillLibrary.SKILLS)[number];
    section?: string;
}

/**
 * Returns the full text of a bundled design skill (W40). Read-only: it serves only the bundled
 * parts and needs no open file, plugin or AI provider feature.
 */
export class PenforgeSkillTool extends Tool<PenforgeSkillArgs> {
    /**
     * @param mcpServer - the MCP server
     * @param library - the bundled skills; located on first use by default
     */
    constructor(
        mcpServer: PenpotMcpServer,
        private library?: SkillLibrary
    ) {
        super(mcpServer, PenforgeSkillArgs.schema);
    }

    public getToolName(): string {
        return "penforge_skill";
    }

    public getToolDescription(): string {
        return (
            "Returns Penforge's full design rules: layout, sections, type, colour, cards and copy (taste-skill), " +
            "or how to write interface texts without AI patterns (no-ai-slop). Without `section` it lists the " +
            "parts with their size; read only the parts the task needs."
        );
    }

    protected async executeCore(args: PenforgeSkillArgs): Promise<ToolResponse> {
        this.library ??= SkillLibrary.locate();
        if (args.section !== undefined) {
            return new TextResponse(this.library.text(args.name, args.section));
        }
        const lines = this.library
            .sections(args.name)
            .map(({ id, title, chars }) => `- \`${id}\`: ${title} (${chars} characters)`);
        return new TextResponse(`# Parts of ${args.name}\n\n${lines.join("\n")}\n`);
    }
}
