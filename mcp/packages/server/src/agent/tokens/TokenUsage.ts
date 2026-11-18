import { readdir, readFile, stat } from "fs/promises";
import { extname, join } from "path";
import { ThemeBlock } from "./ThemeBlock";
import type { ThemeGenerator } from "./ThemeGenerator";
import type { ThemeEntry, ThemeModel } from "./ThemeModel";

/**
 * Finder of tokens the app code does not use yet (no `tokens.color.primary`, `var(--color-primary)`
 * or Tailwind utility outside the generated block). Decides whether a sync asks Claude to make
 * the code use the tokens, and lists those tokens in that request.
 *
 * Reads source files of `app-src/` only (no dependencies, build output or git data), with limits
 * so a large app cannot slow a sync down.
 */
export class TokenUsage {
    private static readonly SKIPPED_DIRS = new Set([
        "node_modules",
        ".git",
        "dist",
        "build",
        ".next",
        ".expo",
        ".turbo",
        ".cache",
        "coverage",
        "android",
        "ios",
        "public",
    ]);
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
    private static readonly MAX_FILES = 2000;
    private static readonly MAX_FILE_BYTES = 512 * 1024;

    private constructor() {}

    /**
     * Lists the entries no source file uses.
     *
     * @param appSrcDir - the `app-src/` folder
     * @param model - the theme model
     * @param generator - the generator of the theme format (knows how code refers to a token)
     */
    public static async unused(appSrcDir: string, model: ThemeModel, generator: ThemeGenerator): Promise<ThemeEntry[]> {
        const sources = await TokenUsage.sources(appSrcDir);
        return model.entries.filter(
            (entry) => !generator.usagePatterns(entry).some((pattern) => sources.some((text) => pattern.test(text)))
        );
    }

    /** Source texts of the app, generated blocks removed. */
    private static async sources(appSrcDir: string): Promise<string[]> {
        const texts: string[] = [];
        const pending = [appSrcDir];
        while (pending.length > 0 && texts.length < TokenUsage.MAX_FILES) {
            const dir = pending.shift()!;
            let names: string[];
            try {
                names = await readdir(dir);
            } catch {
                continue;
            }
            for (const name of names.sort()) {
                const path = join(dir, name);
                let info;
                try {
                    info = await stat(path);
                } catch {
                    continue;
                }
                if (info.isDirectory()) {
                    if (!TokenUsage.SKIPPED_DIRS.has(name) && !name.startsWith(".")) {
                        pending.push(path);
                    }
                } else if (
                    TokenUsage.SOURCE_EXTENSIONS.has(extname(name).toLowerCase()) &&
                    info.size <= TokenUsage.MAX_FILE_BYTES &&
                    texts.length < TokenUsage.MAX_FILES
                ) {
                    try {
                        texts.push(TokenUsage.withoutBlock(await readFile(path, "utf8")));
                    } catch {
                        // unreadable file: skip
                    }
                }
            }
        }
        return texts;
    }

    private static withoutBlock(text: string): string {
        try {
            return ThemeBlock.strip(text);
        } catch {
            return text;
        }
    }
}
