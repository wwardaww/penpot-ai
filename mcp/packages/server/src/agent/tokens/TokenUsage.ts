import { ThemeBlock } from "./ThemeBlock";
import type { ThemeGenerator } from "./ThemeGenerator";
import type { ThemeEntry } from "./ThemeModel";
import { SourceFiles } from "./SourceFiles";

/**
 * Uses of tokens in the app code (`tokens.color.primary`, `var(--color-primary)` or a Tailwind
 * utility outside the generated block). Decides whether a sync asks Claude to make the code use
 * the tokens, and which tokens that left Penpot must stay because the code still refers to them.
 */
export class TokenUsage {
    private static readonly SOURCE_EXTENSIONS = new Set([
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".css",
        ".scss",
        ".less",
        ".vue",
        ".svelte",
        ".astro",
        ".html",
    ]);

    private constructor(private readonly sources: string[]) {}

    /**
     * Reads the app's sources, generated blocks removed.
     *
     * @param appSrcDir - the `app-src/` folder
     */
    public static async load(appSrcDir: string): Promise<TokenUsage> {
        const files = await SourceFiles.list(appSrcDir, TokenUsage.SOURCE_EXTENSIONS);
        return new TokenUsage(files.map((file) => TokenUsage.withoutBlock(file.text)));
    }

    /** Tells whether some source uses an entry. */
    public uses(entry: ThemeEntry, generator: ThemeGenerator): boolean {
        return generator.usagePatterns(entry).some((pattern) => this.sources.some((text) => pattern.test(text)));
    }

    /** Lists the entries no source uses. */
    public unused(entries: ThemeEntry[], generator: ThemeGenerator): ThemeEntry[] {
        return entries.filter((entry) => !this.uses(entry, generator));
    }

    private static withoutBlock(text: string): string {
        try {
            return ThemeBlock.strip(text);
        } catch {
            return text;
        }
    }
}
