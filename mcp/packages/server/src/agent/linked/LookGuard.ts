/** A changed file that is not only about the look. */
export interface OutsideLookChange {
    path: string;
    /** `path`: not a style / view / component / asset / UI file; `logic`: such a file gained logic */
    reason: "path" | "logic";
    /** what was found (English, for the summary card) */
    detail: string;
}

/**
 * Check of a Re-Design diff (W38 look-only rule): flags files outside style, view, component,
 * asset and UI paths, and look files whose added lines bring logic (network calls, routes, state
 * stores, storage, data models). Heuristic and conservative: it lists, the user decides (Revert).
 */
export class LookGuard {
    private static readonly ASSET_EXTENSIONS = new Set([
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".svg",
        ".ico",
        ".avif",
        ".bmp",
        ".ttf",
        ".otf",
        ".woff",
        ".woff2",
        ".eot",
    ]);
    private static readonly STYLE_EXTENSIONS = new Set([
        ".css",
        ".scss",
        ".sass",
        ".less",
        ".styl",
        ".pcss",
        ".uss",
        ".tss",
    ]);
    private static readonly VIEW_EXTENSIONS = new Set([
        ".tsx",
        ".jsx",
        ".vue",
        ".svelte",
        ".astro",
        ".html",
        ".htm",
        ".dart",
        ".swift",
        ".kt",
        ".xml",
        ".xaml",
        ".uxml",
        ".erb",
        ".hbs",
        ".ejs",
        ".pug",
        ".twig",
        ".razor",
        ".cshtml",
        ".storyboard",
        ".xib",
        ".ts",
        ".js",
        ".mjs",
    ]);
    /** folders whose files are about the look */
    private static readonly LOOK_SEGMENT =
        /(^|\/)(components?|ui|views?|screens?|pages?|layouts?|styles?|themes?|theme|assets|fonts|images|img|icons|widgets?|res\/(drawable[^/]*|values[^/]*|layout[^/]*|font|mipmap[^/]*)|public|static|design|tokens|css|scss)(\/|$)/i;
    /** file names that are about the look wherever they are */
    private static readonly LOOK_NAME =
        /(^|[./_-])(theme|themes|styles?|colou?rs|tokens|typography|palette|fonts?|tailwind\.config|global|globals|variables|spacing)([./_-]|$)/i;
    /** added code that is logic, not look */
    private static readonly LOGIC_PATTERNS: Array<[RegExp, string]> = [
        [
            /\bfetch\s*\(|\baxios\b|XMLHttpRequest|\bhttp(s)?\.(get|post|put|delete|request)\s*\(|\bgql`|\buseQuery\s*\(|\buseMutation\s*\(/,
            "network call",
        ],
        [
            /<Route\b|\bcreateBrowserRouter\b|\buseNavigate\b|\brouter\.(push|replace)\s*\(|\bpath\s*:\s*["'`]\//,
            "route",
        ],
        [
            /\bcreateSlice\s*\(|\bcreateStore\s*\(|\bdefineStore\s*\(|\buseReducer\s*\(|\bcreateContext\s*\(|\bzustand\b/,
            "state store",
        ],
        [
            /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bAsyncStorage\b|\bSharedPreferences\b|\bUserDefaults\b/,
            "storage",
        ],
        [
            /\b(interface|type)\s+\w+(Model|Entity|Dto|DTO|Schema)\b|\bclass\s+\w+(Model|Entity|Repository|Service)\b|\bmongoose\.|\bprisma\./,
            "data model",
        ],
        [/\bSELECT\s+.+\s+FROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i, "database query"],
    ];

    /**
     * Checks the changed files of a Re-Design.
     *
     * @param files - changed paths (relative, `/` separated) with the lines each gained
     * @param allowed - paths the user's own feature request covers (not flagged)
     */
    public static check(
        files: Array<{ path: string; added: string[] }>,
        allowed: readonly string[] = []
    ): OutsideLookChange[] {
        const allowedSet = new Set(allowed.map((path) => LookGuard.normalize(path)));
        const flagged: OutsideLookChange[] = [];
        for (const file of files) {
            const path = LookGuard.normalize(file.path);
            if (allowedSet.has(path)) {
                continue;
            }
            if (!LookGuard.isLookPath(path)) {
                flagged.push({
                    path: file.path,
                    reason: "path",
                    detail: "not a style, view, component, asset or UI file",
                });
                continue;
            }
            const ext = LookGuard.extension(path);
            if (LookGuard.ASSET_EXTENSIONS.has(ext) || LookGuard.STYLE_EXTENSIONS.has(ext)) {
                continue;
            }
            const found = LookGuard.logicIn(file.added);
            if (found !== null) {
                flagged.push({ path: file.path, reason: "logic", detail: found });
            }
        }
        return flagged;
    }

    /**
     * Tells whether a path holds look only: styles and assets anywhere, view files in look folders
     * or with look names.
     *
     * @param path - relative path, `/` separated
     */
    public static isLookPath(path: string): boolean {
        const normalized = LookGuard.normalize(path);
        const ext = LookGuard.extension(normalized);
        if (LookGuard.ASSET_EXTENSIONS.has(ext) || LookGuard.STYLE_EXTENSIONS.has(ext)) {
            return true;
        }
        if (!LookGuard.VIEW_EXTENSIONS.has(ext)) {
            return false;
        }
        const name = normalized.slice(normalized.lastIndexOf("/") + 1);
        if (/\.(test|spec)\.[a-z]+$/i.test(name)) {
            return false;
        }
        const dir = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
        if (LookGuard.LOOK_SEGMENT.test(dir) || LookGuard.LOOK_NAME.test(name)) {
            return true;
        }
        // single-file components and markup are views wherever they live
        return [
            ".tsx",
            ".jsx",
            ".vue",
            ".svelte",
            ".astro",
            ".html",
            ".htm",
            ".uxml",
            ".xaml",
            ".storyboard",
            ".xib",
        ].includes(ext);
    }

    private static logicIn(lines: string[]): string | null {
        for (const line of lines) {
            const code = line.trim();
            if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) {
                continue;
            }
            for (const [pattern, label] of LookGuard.LOGIC_PATTERNS) {
                if (pattern.test(code)) {
                    return `${label}: ${code.length > 100 ? `${code.slice(0, 100)}…` : code}`;
                }
            }
        }
        return null;
    }

    private static extension(path: string): string {
        const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
        return name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
    }

    private static normalize(path: string): string {
        return path.split("\\").join("/").replace(/^\.\//, "");
    }
}
