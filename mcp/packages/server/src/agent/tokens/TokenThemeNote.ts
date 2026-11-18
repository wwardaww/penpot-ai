import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { ThemeBlock } from "./ThemeBlock";
import { ThemeLocator } from "./ThemeTarget";

/**
 * Note for Claude's build turns (W08 `build-run`) about the app's token theme, so generated
 * components reference the design tokens instead of repeating their values.
 */
export class TokenThemeNote {
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
            if (target === null || !ThemeBlock.has(target.text)) {
                return "";
            }
            const name = target.objectName;
            const references =
                target.format === "css"
                    ? "`var(--color-primary)`, `var(--spacing-md)`, `var(--radius-card)`"
                    : target.format === "tailwind"
                      ? "Tailwind theme variables, so utilities like `bg-primary`, `p-md`, `rounded-card`, `text-title`"
                      : `\`${name}.color.primary\`, \`${name}.spacing.md\`, \`${name}.typography.title\``;
            return [
                "Design tokens: the theme file `app-src/" + target.file + "` holds a generated block between the",
                `\`${ThemeBlock.BEGIN}\` and \`${ThemeBlock.END}\` comments with the design tokens of the Penpot file`,
                `(${references}). Never edit that block; Penforge rewrites it when the tokens change. Build`,
                "the theme and the components on it: reference the tokens instead of repeating their values,",
                "and write literal values only where no token fits. Keep the theme file where it is (do not",
                "create a second theme file).",
            ].join("\n");
        } catch {
            return "";
        }
    }
}
