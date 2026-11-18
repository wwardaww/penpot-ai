import { readFile } from "fs/promises";
import { join } from "path";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { ThemeBlock } from "./ThemeBlock";
import type { ThemeFormat } from "./ThemeGenerator";
import { ThemeLocator } from "./ThemeTarget";

/**
 * Note for Claude's build turns (W08 `build-run`) about the app's token theme, so generated
 * components reference the design tokens instead of repeating their values.
 */
export class TokenThemeNote {
    private static readonly REFERENCES: Record<ThemeFormat, string> = {
        "react-native": "`tokens.color.primary`, `tokens.spacing.md`, `tokens.typography.title`",
        "js-web": "`tokens.color.primary`, `tokens.spacing.md`, `tokens.typography.title`",
        css: "`var(--color-primary)`, `var(--spacing-md)`, `var(--radius-card)`",
        tailwind: "Tailwind theme variables, so utilities like `bg-primary`, `p-md`, `rounded-card`, `text-title`",
    };

    private constructor() {}

    /**
     * Gets the note, or "" when the app's theme has no generated token block yet.
     *
     * @param workspace - the project workspace
     */
    public static async forBuild(workspace: WorkflowWorkspaceApi): Promise<string> {
        try {
            const raw = await workspace.readJson<unknown>("stack.json", null);
            const stack = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
            const target = await ThemeLocator.locate(workspace.appSrcDir, stack);
            if (!target.exists || !ThemeBlock.has(target.text)) {
                return "";
            }
            const text = await readFile(join(workspace.appSrcDir, target.file), "utf8");
            if (!ThemeBlock.has(text)) {
                return "";
            }
            return [
                "Design tokens: the theme file `app-src/" + target.file + "` holds a generated block between the",
                `\`${ThemeBlock.BEGIN}\` and \`${ThemeBlock.END}\` comments with the design tokens of the Penpot file`,
                `(${TokenThemeNote.REFERENCES[target.format]}). Never edit that block; Penforge rewrites it when`,
                "the tokens change. Build the theme and the components on it: reference the tokens instead of",
                "repeating their values, and write literal values only where no token fits. Keep the theme file",
                "where it is (do not create a second theme file).",
            ].join("\n");
        } catch {
            return "";
        }
    }
}
