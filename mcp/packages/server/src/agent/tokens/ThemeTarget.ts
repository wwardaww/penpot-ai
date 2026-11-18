import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { extname, isAbsolute, join, normalize } from "path";
import { type ModuleKind, type ThemeFormat, ThemeGenerator } from "./ThemeGenerator";
import { ThemeBlock } from "./ThemeBlock";
import { TokenSyncError } from "./TokenSyncError";

/** Stack facts that decide the theme format. */
export interface StackFamily {
    /** React Native / Expo app */
    native: boolean;
    /** Tailwind CSS major version, or null without Tailwind */
    tailwind: number | null;
    typescript: boolean;
}

/** Theme file a sync writes. */
export interface ThemeTarget {
    /** path relative to `app-src/`, forward slashes */
    file: string;
    format: ThemeFormat;
    module: ModuleKind;
    quote: "'" | '"';
    /** current text ("" for a new file) */
    text: string;
    /** false when the sync creates the file */
    exists: boolean;
}

/**
 * Finder of the theme file of the generated app, so the tokens land in the theme the build already
 * wrote (W08 writes one, e.g. `src/theme.ts` for Expo) instead of a second one.
 *
 * Order: `stack.json` `themeFile`; a known theme file that already holds the generated block; the
 * first known theme file that exists (dedicated theme files first, then, for web apps, the global
 * stylesheet); else a new file at the stack's usual place (`src/theme.ts` for React Native,
 * `src/theme.css` for the web). The format follows the stack family and the file type.
 */
export class ThemeLocator {
    private static readonly NAMED = [
        "src/theme.ts",
        "src/theme.css",
        "src/theme/index.ts",
        "src/theme.js",
        "src/theme/index.js",
        "src/styles/theme.ts",
        "src/styles/theme.css",
        "src/styles/tokens.css",
        "src/tokens.css",
        "src/constants/theme.ts",
        "constants/theme.ts",
        "app/theme.ts",
        "app/theme.css",
        "styles/theme.css",
        "theme.ts",
        "theme.js",
    ];

    private static readonly GLOBAL_STYLES = [
        "src/index.css",
        "src/styles.css",
        "src/global.css",
        "src/styles/globals.css",
        "src/styles/global.css",
        "src/app/globals.css",
        "app/globals.css",
        "styles/globals.css",
        "global.css",
    ];

    private static readonly TAILWIND_CONFIGS = [
        "tailwind.config.ts",
        "tailwind.config.js",
        "tailwind.config.mjs",
        "tailwind.config.cjs",
    ];

    private static readonly CSS_EXTENSIONS = new Set([".css", ".scss", ".less", ".pcss"]);
    private static readonly JS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

    private constructor() {}

    /**
     * Finds the theme file of an app.
     *
     * @param appSrcDir - the `app-src/` folder
     * @param stack - the raw `stack.json` (null without one)
     * @throws TokenSyncError `unsafe-theme-path` when `themeFile` leaves `app-src/`
     */
    public static async locate(appSrcDir: string, stack: Record<string, unknown> | null): Promise<ThemeTarget> {
        const family = await ThemeLocator.family(appSrcDir, stack);
        const recorded = typeof stack?.themeFile === "string" ? ThemeLocator.safePath(stack.themeFile) : null;
        const candidates = ThemeLocator.candidates(family);
        let file: string | null = recorded !== null && existsSync(join(appSrcDir, recorded)) ? recorded : null;
        if (file === null) {
            for (const candidate of candidates) {
                if (
                    existsSync(join(appSrcDir, candidate)) &&
                    ThemeBlock.has(await ThemeLocator.read(appSrcDir, candidate))
                ) {
                    file = candidate;
                    break;
                }
            }
        }
        file ??= candidates.find((candidate) => existsSync(join(appSrcDir, candidate))) ?? null;
        file ??= recorded ?? ThemeLocator.defaultFile(family);

        const exists = existsSync(join(appSrcDir, file));
        const text = exists ? await ThemeLocator.read(appSrcDir, file) : "";
        const recordedFormat = file === recorded ? stack?.themeFormat : undefined;
        const format = ThemeLocator.format(file, text, family, recordedFormat);
        return {
            file,
            format,
            module: ThemeLocator.moduleKind(file, text),
            quote: ThemeLocator.quote(text),
            text,
            exists,
        };
    }

    /**
     * Reads the stack family from `stack.json` and `app-src/package.json`.
     *
     * @param appSrcDir - the `app-src/` folder
     * @param stack - the raw `stack.json`, or null
     */
    public static async family(appSrcDir: string, stack: Record<string, unknown> | null): Promise<StackFamily> {
        const name = `${String(stack?.name ?? "")} ${String(stack?.version ?? "")}`;
        const deps = await ThemeLocator.dependencies(appSrcDir);
        const native = "react-native" in deps || "expo" in deps || /expo|react[- ]?native/i.test(name);
        let tailwind: number | null = null;
        if ("@tailwindcss/vite" in deps || "@tailwindcss/postcss" in deps || "@tailwindcss/cli" in deps) {
            tailwind = 4;
        } else if ("tailwindcss" in deps) {
            const major = /(\d+)/.exec(deps.tailwindcss)?.[1];
            tailwind = major === undefined ? 4 : Number(major);
        } else if (/tailwind/i.test(name)) {
            tailwind = Number(/tailwind(?:css)?\s*v?(\d+)/i.exec(name)?.[1] ?? 4);
        }
        const typescript =
            "typescript" in deps || existsSync(join(appSrcDir, "tsconfig.json")) || /typescript|\bts\b/i.test(name);
        return { native, tailwind: native ? null : tailwind, typescript };
    }

    /** Known theme files to look for, best first. */
    private static candidates(family: StackFamily): string[] {
        if (family.native) {
            return ThemeLocator.NAMED.filter((file) => ThemeLocator.JS_EXTENSIONS.has(extname(file)));
        }
        const list = [...ThemeLocator.NAMED, ...ThemeLocator.GLOBAL_STYLES];
        if (family.tailwind !== null && family.tailwind < 4) {
            list.push(...ThemeLocator.TAILWIND_CONFIGS);
        }
        return list;
    }

    private static defaultFile(family: StackFamily): string {
        if (family.native) {
            return family.typescript ? "src/theme.ts" : "src/theme.js";
        }
        return "src/theme.css";
    }

    private static format(file: string, text: string, family: StackFamily, recorded: unknown): ThemeFormat {
        const css = ThemeLocator.CSS_EXTENSIONS.has(extname(file).toLowerCase());
        const fits = (format: ThemeFormat) => (format === "css" || format === "tailwind") === css;
        if (typeof recorded === "string" && (ThemeGenerator.FORMATS as string[]).includes(recorded)) {
            const format = recorded as ThemeFormat;
            if (fits(format)) {
                return format;
            }
        }
        if (css) {
            const tailwindFile = /@import\s+["']tailwindcss|@theme\b/.test(text);
            return tailwindFile || (family.tailwind !== null && family.tailwind >= 4) ? "tailwind" : "css";
        }
        return family.native ? "react-native" : "js-web";
    }

    private static moduleKind(file: string, text: string): ModuleKind {
        const extension = extname(file).toLowerCase();
        if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) {
            return "ts";
        }
        if (extension === ".cjs") {
            return "cjs";
        }
        return /module\.exports/.test(text) && !/^\s*export\s/m.test(text) ? "cjs" : "esm";
    }

    private static quote(text: string): "'" | '"' {
        const single = (text.match(/'/g) ?? []).length;
        const double = (text.match(/"/g) ?? []).length;
        return double > single ? '"' : "'";
    }

    /** Checks a recorded theme path: relative, inside `app-src/`, a JS or CSS file. */
    private static safePath(path: string): string {
        const clean = normalize(path.replace(/\\/g, "/")).replace(/\\/g, "/").replace(/^\.\//, "");
        const extension = extname(clean).toLowerCase();
        if (
            clean.length === 0 ||
            isAbsolute(clean) ||
            /^[A-Za-z]:/.test(clean) ||
            clean.split("/").includes("..") ||
            clean.split("/").includes("node_modules") ||
            !(ThemeLocator.CSS_EXTENSIONS.has(extension) || ThemeLocator.JS_EXTENSIONS.has(extension))
        ) {
            throw new TokenSyncError(
                "unsafe-theme-path",
                `stack.json themeFile ${JSON.stringify(path)} is not a theme file inside app-src`
            );
        }
        return clean;
    }

    private static async dependencies(appSrcDir: string): Promise<Record<string, string>> {
        try {
            const pkg = JSON.parse(await readFile(join(appSrcDir, "package.json"), "utf8")) as Record<string, unknown>;
            const deps: Record<string, string> = {};
            for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
                const entries = pkg[field];
                if (typeof entries === "object" && entries !== null) {
                    for (const [name, version] of Object.entries(entries)) {
                        deps[name] = String(version);
                    }
                }
            }
            return deps;
        } catch {
            return {};
        }
    }

    private static async read(appSrcDir: string, file: string): Promise<string> {
        try {
            return await readFile(join(appSrcDir, file), "utf8");
        } catch {
            return "";
        }
    }
}
