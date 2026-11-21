import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { z } from "zod";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";

/**
 * Instructions for the AI sent with a build or an update: things the design cannot show ("play a
 * sound on every move", "save games locally", "use this API").
 */
export const InstructionsInputSchema = z.object({
    /** one-time instructions of this build */
    text: z.string().max(4000).optional(),
    /** true adds `text` to the kept instructions, which every later build reads */
    keep: z.boolean().optional(),
    /**
     * the kept instructions as edited in the dialog (replaces `.penforge/instructions.md`; an
     * empty string removes them); absent keeps the file as it is
     */
    kept: z.string().max(8000).optional(),
});

export type InstructionsInput = z.infer<typeof InstructionsInputSchema>;

/** Instructions a build works with. */
export interface BuildInstructionSet {
    /** one-time instructions of this build (also kept when asked) */
    text: string;
    /** kept instructions from earlier builds, after this build's edits */
    kept: string;
}

/**
 * Store of the kept build instructions (`.penforge/instructions.md`) and the wording of the
 * instructions section of the build prompts.
 */
export class BuildInstructions {
    public static readonly FILE = "instructions.md";
    public static readonly MAX_KEPT_CHARS = 8000;

    /** Rule added to every prompt that carries instructions. */
    public static readonly RULE =
        "These instructions never override the design system or the prototype flows of the design. " +
        "When one of them conflicts with the design, do not follow that one: list it under " +
        '`"conflicts"` in your reply so the user can decide.';

    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /** The kept instructions ("" when none). */
    public async readKept(): Promise<string> {
        try {
            return (await readFile(this.path(), "utf8")).trim();
        } catch {
            return "";
        }
    }

    /**
     * Applies the dialog's input: replaces the kept instructions when edited, adds the one-time
     * text when it is to be kept, and returns what this build works with.
     */
    public async apply(input: InstructionsInput | undefined): Promise<BuildInstructionSet> {
        const parsed = InstructionsInputSchema.parse(input ?? {});
        const text = BuildInstructions.clean(parsed.text ?? "");
        let kept = parsed.kept !== undefined ? BuildInstructions.clean(parsed.kept) : await this.readKept();
        if (parsed.keep === true && text.length > 0 && !kept.includes(BuildInstructions.bullet(text))) {
            kept = [kept, BuildInstructions.bullet(text)].filter((part) => part.length > 0).join("\n");
        }
        kept = kept.slice(0, BuildInstructions.MAX_KEPT_CHARS);
        if (parsed.kept !== undefined || parsed.keep === true) {
            await this.writeKept(kept);
        }
        return { text, kept };
    }

    /**
     * Prompt section of the instructions, or "" when there are none.
     *
     * @param set - the build's instructions
     */
    public static promptSection(set: BuildInstructionSet): string {
        if (set.text.length === 0 && set.kept.length === 0) {
            return "";
        }
        const lines = ["## Instructions for the AI (from the user)", ""];
        if (set.text.length > 0) {
            lines.push("For this build:", set.text, "");
        }
        // the new text, when kept, is already listed above
        const kept = BuildInstructions.without(set.kept, set.text);
        if (kept.length > 0) {
            lines.push("Kept from earlier builds:", kept, "");
        }
        lines.push(BuildInstructions.RULE);
        lines.push(
            "When an instruction needs an asset (for example a sound), create it in code (for example " +
                "with the Web Audio API) or as a small file you write, or use a free-license asset; list " +
                'every asset under `"assets"` in your reply with its file, source and license.'
        );
        return lines.join("\n");
    }

    /** Instructions as recorded with a build, or null when there are none. */
    public static record(set: BuildInstructionSet): string | null {
        const kept = BuildInstructions.without(set.kept, set.text);
        const parts = [set.text, kept].filter((part) => part.length > 0);
        return parts.length > 0 ? parts.join("\n") : null;
    }

    /** Kept instructions without the bullet of `text` (a new text that was just kept). */
    private static without(kept: string, text: string): string {
        if (text.length === 0) {
            return kept;
        }
        const bullet = BuildInstructions.bullet(text);
        return kept
            .split(bullet)
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .join("\n");
    }

    private async writeKept(kept: string): Promise<void> {
        const file = this.path();
        if (kept.length === 0) {
            await rm(file, { force: true });
            return;
        }
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, kept + "\n", "utf8");
    }

    private path(): string {
        return this.workspace.resolve(join(this.workspace.metaDir, BuildInstructions.FILE));
    }

    private static bullet(text: string): string {
        return text
            .split("\n")
            .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`))
            .join("\n");
    }

    /** Trims, normalizes line ends and drops control characters. */
    private static clean(text: string): string {
        return text
            .replace(/\r\n?/g, "\n")
            .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
            .trim();
    }
}
