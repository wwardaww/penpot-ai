import { lstatSync } from "fs";
import { readFile } from "fs/promises";
import { extname, isAbsolute, join, normalize } from "path";
import { ThemeBlock } from "./ThemeBlock";
import { type ModuleKind, type ThemeFormat, ThemeGenerator } from "./ThemeGenerator";
import { SourceFiles } from "./SourceFiles";
import { TokenSyncError } from "./TokenSyncError";

/** Stack facts that decide the theme format. */
export interface StackFamily {
    /** React Native / Expo app */
    native: boolean;
    /** Tailwind CSS major version, or null without Tailwind */
    tailwind: number | null;
    typescript: boolean;
}

/** Theme file a sync writes; always a file the app already has. */
export interface ThemeTarget {
    /** path relative to `app-src/`, forward slashes */
    file: string;
    format: ThemeFormat;
    module: ModuleKind;
    /** name of the JS theme object; unused for CSS formats */
    objectName: string;
    /** current text */
    text: string;
}

/**
 * Finder of the theme file of the generated app, so the tokens land in the theme the build wrote
 * (W08 writes one, e.g. `src/theme.ts` for Expo) instead of a second one. It never invents a
 * file: an app without a theme file gets none from a sync (the build or Claude makes one).
 *
 * Order: `stack.json` `themeFile`; a known theme file that already holds the generated block; for
 * Tailwind v4 the stylesheet that imports Tailwind (only that one is processed into utilities);
 * the first known theme file that exists (dedicated theme files first, then, for web apps, the
 * global stylesheet). Symbolic links are never used. The format follows the stack family and the
 * file; a JS theme object is named `tokens` unless the file declares that name already.
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
    private static readonly TAILWIND_IMPORT = /@import\s+(?:url\(\s*)?["']tailwindcss(?:\/[\w./-]*)?["']/;
    /** names tried for the JS theme object, in order */
    private static readonly OBJECT_NAMES = ["tokens", "designTokens", "penpotTokens", "themeTokens"];

    private constructor() {}

    /**
     * Finds the theme file of an app.
     *
     * @param appSrcDir - the `app-src/` folder
     * @param stack - the raw `stack.json` (null without one)
     * @returns the target, or null when the app has no theme file
     * @throws TokenSyncError `unsafe-theme-path` when `themeFile` leaves `app-src/` or is a link
     */
    public static async locate(appSrcDir: string, stack: Record<string, unknown> | null): Promise<ThemeTarget | null> {
        const family = await ThemeLocator.family(appSrcDir, stack);
        let recorded: string | null = null;
        if (typeof stack?.themeFile === "string") {
            recorded = ThemeLocator.safePath(stack.themeFile);
            const kind = ThemeLocator.kind(appSrcDir, recorded);
            if (kind === "link") {
                throw new TokenSyncError(
                    "unsafe-theme-path",
                    `stack.json themeFile ${JSON.stringify(stack.themeFile)} is a link`
                );
            }
            if (kind !== "file") {
                recorded = null;
            }
        }
        const tailwindEntry =
            family.tailwind !== null && family.tailwind >= 4 ? await ThemeLocator.tailwindEntry(appSrcDir) : null;
        const candidates = ThemeLocator.candidates(family).filter(
            (file) => ThemeLocator.kind(appSrcDir, file) === "file"
        );

        let file = recorded;
        if (file === null) {
            for (const candidate of [...(tailwindEntry ? [tailwindEntry] : []), ...candidates]) {
                if (ThemeBlock.has(await ThemeLocator.read(appSrcDir, candidate))) {
                    file = candidate;
                    break;
                }
            }
        }
        file ??= tailwindEntry ?? candidates[0] ?? null;
        if (file === null) {
            return null;
        }
        const text = await ThemeLocator.read(appSrcDir, file);
        const recordedFormat = file === recorded ? stack?.themeFormat : undefined;
        return {
            file,
            format: ThemeLocator.format(file, text, family, recordedFormat),
            module: ThemeLocator.moduleKind(file, text),
            objectName: ThemeLocator.objectName(text),
            text,
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
        const native = deps.has("react-native") || deps.has("expo") || /expo|react[- ]?native/i.test(name);
        let tailwind: number | null = null;
        if (deps.has("@tailwindcss/vite") || deps.has("@tailwindcss/postcss") || deps.has("@tailwindcss/cli")) {
            tailwind = 4;
        } else if (deps.has("tailwindcss")) {
            const major = /(\d+)/.exec(deps.get("tailwindcss") ?? "")?.[1];
            tailwind = major === undefined ? 4 : Number(major);
        } else if (/tailwind/i.test(name)) {
            tailwind = Number(/tailwind(?:css)?\s*v?(\d+)/i.exec(name)?.[1] ?? 4);
        }
        const typescript = deps.has("typescript") || ThemeLocator.kind(appSrcDir, "tsconfig.json") === "file";
        return { native, tailwind: native ? null : tailwind, typescript };
    }

    /**
     * Name for the JS theme object: the one the block already declares, else the first of
     * `tokens`, `designTokens`… that the rest of the file does not declare or import.
     *
     * @param text - the theme file text
     */
    public static objectName(text: string): string {
        let block: string | null = null;
        let rest = text;
        try {
            block = ThemeBlock.extract(text);
            rest = ThemeBlock.strip(text);
        } catch {
            block = null;
        }
        const declared =
            block === null ? null : /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/.exec(block)?.[1];
        if (declared && !ThemeLocator.declares(rest, declared)) {
            return declared;
        }
        return ThemeLocator.OBJECT_NAMES.find((name) => !ThemeLocator.declares(rest, name)) ?? "penforgeTokens";
    }

    /** Tells whether code declares, imports or exports a name. */
    private static declares(code: string, name: string): boolean {
        const n = name.replace(/\$/g, "\\$");
        return [
            new RegExp(`\\b(?:const|let|var|function|class|enum|interface|type|namespace)\\s+${n}\\b`),
            new RegExp(`\\bimport\\s+(?:type\\s+)?${n}\\b`),
            new RegExp(`\\bimport\\b[^;]*?\\{[^}]*?(?:^|[\\s,{])${n}\\s*(?:,|\\})[^;]*?\\bfrom\\b`, "s"),
            new RegExp(`\\bimport\\b[^;]*?\\bas\\s+${n}\\b`),
            new RegExp(`\\bexport\\s*\\{[^}]*?\\b${n}\\b[^}]*\\}`),
            new RegExp(`\\{[^}]*?\\b${n}\\b[^}]*\\}\\s*=\\s*require\\(`),
        ].some((pattern) => pattern.test(code));
    }

    /** First stylesheet of the app that imports Tailwind v4, or null. */
    private static async tailwindEntry(appSrcDir: string): Promise<string | null> {
        const sheets = await SourceFiles.list(appSrcDir, ThemeLocator.CSS_EXTENSIONS);
        const preferred = [...ThemeLocator.GLOBAL_STYLES, ...ThemeLocator.NAMED];
        const entries = sheets
            .filter((sheet) => ThemeLocator.TAILWIND_IMPORT.test(sheet.text))
            .map((sheet) => sheet.file);
        entries.sort((a, b) => ThemeLocator.rank(preferred, a) - ThemeLocator.rank(preferred, b) || a.localeCompare(b));
        return entries[0] ?? null;
    }

    private static rank(list: string[], file: string): number {
        const index = list.indexOf(file);
        return index === -1 ? list.length : index;
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

    private static format(file: string, text: string, family: StackFamily, recorded: unknown): ThemeFormat {
        const css = ThemeLocator.CSS_EXTENSIONS.has(extname(file).toLowerCase());
        // `@theme` only works in a stylesheet Tailwind processes: the one importing it
        const tailwindEntry = css && ThemeLocator.TAILWIND_IMPORT.test(text);
        if (typeof recorded === "string" && (ThemeGenerator.FORMATS as string[]).includes(recorded)) {
            const format = recorded as ThemeFormat;
            const fits =
                (format === "css" && css) ||
                (format === "tailwind" && tailwindEntry) ||
                ((format === "react-native" || format === "js-web") && !css);
            if (fits) {
                return format;
            }
        }
        if (css) {
            return tailwindEntry ? "tailwind" : "css";
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

    /** What a path inside `app-src/` is, without following links (in the file or its folders). */
    public static kind(appSrcDir: string, file: string): "file" | "link" | "other" | "missing" {
        const segments = file.split("/");
        try {
            for (let end = 1; end <= segments.length; end++) {
                const info = lstatSync(join(appSrcDir, ...segments.slice(0, end)));
                if (info.isSymbolicLink()) {
                    return "link";
                }
                if (end === segments.length) {
                    return info.isFile() ? "file" : "other";
                }
            }
            return "other";
        } catch {
            return "missing";
        }
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

    private static async dependencies(appSrcDir: string): Promise<Map<string, string>> {
        const deps = new Map<string, string>();
        try {
            const pkg = JSON.parse(await readFile(join(appSrcDir, "package.json"), "utf8")) as Record<string, unknown>;
            for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
                const entries = pkg[field];
                if (typeof entries === "object" && entries !== null) {
                    for (const [name, version] of Object.entries(entries)) {
                        deps.set(name, String(version));
                    }
                }
            }
        } catch {
            // no or broken package.json: no dependencies
        }
        return deps;
    }

    private static async read(appSrcDir: string, file: string): Promise<string> {
        try {
            return await readFile(join(appSrcDir, file), "utf8");
        } catch {
            return "";
        }
    }
}
