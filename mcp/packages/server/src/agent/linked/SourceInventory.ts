import { createHash } from "crypto";
import type { Dirent } from "fs";
import { open, readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import type { GameEngine, LinkedProjectKind } from "@penpot/mcp-common";
import { GitIgnore } from "./GitIgnore";

/** Role of a file in the inventory; sets the reading order. */
export type SourceFileKind = "markdown" | "ui" | "style" | "code" | "config" | "asset-name";

/** One file of a linked folder, as listed by the inventory. */
export interface SourceFile {
    /** path relative to the linked folder, `/` separated */
    path: string;
    kind: SourceFileKind;
    size: number;
    /** SHA-1 of the content; null for files listed by name only (assets, prefabs, `.uasset`) */
    hash: string | null;
    /** lower reads first: Markdown and DESIGN.md, then UI / screen / style files, then the rest */
    priority: number;
}

/** Counts of what the inventory left out. */
export interface SkippedCounts {
    /** dependency, package, build, cache and engine folders */
    folders: number;
    /** paths ignored by `.gitignore` */
    ignored: number;
    /** files larger than the per-file limit */
    tooBig: number;
    /** files over the file or byte budget */
    overBudget: number;
}

/** Content of `.penforge/source-index.json`. */
export interface SourceIndex {
    version: 1;
    kind: LinkedProjectKind;
    engine: GameEngine | null;
    root: string;
    createdAt: string;
    files: SourceFile[];
    skipped: SkippedCounts;
    /** the walk stopped early (too many entries) */
    truncated: boolean;
}

/** Difference between two inventories. */
export interface SourceChanges {
    added: string[];
    changed: string[];
    removed: string[];
}

/** Limits of one inventory. */
export interface InventoryBudget {
    /** files listed at most */
    maxFiles: number;
    /** bytes hashed at most */
    maxBytes: number;
    /** a file larger than this is listed as too big, not read */
    maxFileBytes: number;
    /** directory entries visited at most */
    maxEntries: number;
}

/**
 * Inventory of a linked folder (W38 `project-read` step 1, no Claude): which files the AI reads,
 * with sizes and hashes.
 *
 * Skips dependency, package, build and cache folders (fixed list per project type, plus
 * `.gitignore` rules), hidden folders and links (never followed, so the walk stays inside the
 * folder). Game UI keeps Markdown and UI files only: Unity UI Toolkit files, C# scripts that use
 * the UI namespaces or sit in UI folders, and the names of UI prefabs, scenes, fonts and sprites;
 * Unreal UI sources, UI config and `.uasset` names below UI content folders (never their bytes).
 * Existing project keeps Markdown and all code and style files.
 */
export class SourceInventory {
    public static readonly DEFAULT_BUDGET: InventoryBudget = {
        maxFiles: 4000,
        maxBytes: 64 * 1024 * 1024,
        maxFileBytes: 1024 * 1024,
        maxEntries: 200_000,
    };

    /** folders never entered, any project type */
    private static readonly COMMON_SKIP = [
        "node_modules",
        "bower_components",
        "jspm_packages",
        "vendor",
        "Pods",
        "Carthage",
        "build",
        "dist",
        "out",
        "target",
        "coverage",
        "venv",
        "env",
        "__pycache__",
        "DerivedData",
        "obj",
        "tmp",
        "temp",
    ];
    /** extra folders never entered in a Unity project (top level or anywhere) */
    private static readonly UNITY_SKIP = ["Library", "Temp", "Logs", "UserSettings", "MemoryCaptures"];
    /** extra folders never entered in an Unreal project */
    private static readonly UNREAL_SKIP = [
        "Binaries",
        "Intermediate",
        "Saved",
        "DerivedDataCache",
        "Plugins/Developer",
    ];

    private static readonly CODE_EXTENSIONS = new Set([
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".vue",
        ".svelte",
        ".astro",
        ".html",
        ".htm",
        ".dart",
        ".swift",
        ".kt",
        ".kts",
        ".java",
        ".m",
        ".mm",
        ".h",
        ".py",
        ".rb",
        ".php",
        ".go",
        ".cs",
        ".rs",
        ".erb",
        ".twig",
        ".hbs",
        ".ejs",
        ".pug",
        ".xml",
        ".xaml",
        ".razor",
        ".cshtml",
        ".storyboard",
        ".xib",
    ]);
    private static readonly STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".styl", ".pcss"]);
    private static readonly CONFIG_NAMES = new Set([
        "package.json",
        "tsconfig.json",
        "app.json",
        "pubspec.yaml",
        "tailwind.config.js",
        "tailwind.config.ts",
        "tailwind.config.cjs",
        "tailwind.config.mjs",
        "theme.json",
        "tokens.json",
        "vite.config.ts",
        "vite.config.js",
        "next.config.js",
        "next.config.mjs",
        "angular.json",
    ]);
    private static readonly UI_WORDS =
        /(^|[\\/_.\- ])(ui|hud|menu|menus|widget|widgets|screen|screens|view|views|page|pages|component|components|layout|layouts|theme|themes|style|styles)([\\/_.\- ]|$)/i;
    private static readonly UNITY_UI_FOLDER = /(^|\/)(ui|hud|menu|menus|uitoolkit|ui toolkit|gui|interface)(\/|$)/i;
    private static readonly UNITY_UI_CODE =
        /\busing\s+(UnityEngine\.UI|UnityEngine\.UIElements|TMPro)\b|\b(VisualElement|UIDocument|TextMeshProUGUI|Canvas|RectTransform)\b/;
    private static readonly UNREAL_UI_CODE = /\b(UUserWidget|SWidget|SCompoundWidget|AHUD|UWidget|UMG|Slate)\b/;
    private static readonly UNREAL_UI_NAME = /(widget|hud|menu|\bui\b|_ui|ui_|slate)/i;
    private static readonly UNREAL_UI_CONTENT = /^Content\/(?:.*\/)?(UI|Widgets?|HUD|Menus?)(\/|$)/i;

    private readonly budget: InventoryBudget;

    /**
     * @param root - the linked folder (real path)
     * @param kind - the project type
     * @param engine - the game engine of a Game UI project
     * @param budget - limits (defaults to {@link DEFAULT_BUDGET})
     */
    constructor(
        private readonly root: string,
        private readonly kind: LinkedProjectKind,
        private readonly engine: GameEngine | null,
        budget: Partial<InventoryBudget> = {}
    ) {
        this.budget = { ...SourceInventory.DEFAULT_BUDGET, ...budget };
    }

    /**
     * Walks the folder and lists the files to read.
     *
     * @param onProgress - called now and then with the number of files listed so far
     */
    public async build(onProgress?: (files: number) => void): Promise<SourceIndex> {
        const skipped: SkippedCounts = { folders: 0, ignored: 0, tooBig: 0, overBudget: 0 };
        const files: SourceFile[] = [];
        const ignores: Array<{ base: string; rules: GitIgnore }> = [];
        let entries = 0;
        let bytes = 0;
        let truncated = false;
        const queue: string[] = [""];
        while (queue.length > 0) {
            const dir = queue.shift()!;
            const dirIgnores = [...ignores];
            const ownIgnore = await this.readGitIgnore(dir);
            if (ownIgnore !== null) {
                ignores.push({ base: dir, rules: ownIgnore });
                dirIgnores.push({ base: dir, rules: ownIgnore });
            }
            let dirents: Dirent[];
            try {
                dirents = await readdir(join(this.root, dir), { withFileTypes: true });
            } catch {
                continue;
            }
            dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            for (const entry of dirents) {
                if (++entries > this.budget.maxEntries) {
                    truncated = true;
                    break;
                }
                const rel = dir ? `${dir}/${entry.name}` : entry.name;
                if (entry.isSymbolicLink()) {
                    continue;
                }
                if (entry.isDirectory()) {
                    if (entry.name.startsWith(".") || this.isSkippedFolder(rel, entry.name)) {
                        skipped.folders++;
                    } else if (SourceInventory.ignored(dirIgnores, rel, true)) {
                        skipped.ignored++;
                    } else {
                        queue.push(rel);
                    }
                    continue;
                }
                if (!entry.isFile()) {
                    continue;
                }
                if (SourceInventory.ignored(dirIgnores, rel, false)) {
                    skipped.ignored++;
                    continue;
                }
                const selected = await this.select(rel, entry.name);
                if (selected === null) {
                    continue;
                }
                if (files.length >= this.budget.maxFiles) {
                    skipped.overBudget++;
                    continue;
                }
                const size = await stat(join(this.root, rel))
                    .then((info) => info.size)
                    .catch(() => -1);
                if (size < 0) {
                    continue;
                }
                if (selected.nameOnly) {
                    files.push({ path: rel, kind: selected.kind, size, hash: null, priority: selected.priority });
                    continue;
                }
                if (size > this.budget.maxFileBytes) {
                    skipped.tooBig++;
                    continue;
                }
                if (bytes + size > this.budget.maxBytes) {
                    skipped.overBudget++;
                    continue;
                }
                const hash = await this.hash(rel);
                if (hash === null) {
                    continue;
                }
                bytes += size;
                files.push({ path: rel, kind: selected.kind, size, hash, priority: selected.priority });
                if (files.length % 200 === 0) {
                    onProgress?.(files.length);
                }
            }
            if (truncated) {
                break;
            }
        }
        files.sort((a, b) => a.priority - b.priority || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        onProgress?.(files.length);
        return {
            version: 1,
            kind: this.kind,
            engine: this.engine,
            root: this.root,
            createdAt: new Date().toISOString(),
            files,
            skipped,
            truncated,
        };
    }

    /**
     * Compares two inventories by path and hash (name-only entries by size).
     *
     * @param previous - the older inventory, or null
     * @param current - the newer one
     */
    public static changes(previous: SourceIndex | null, current: SourceIndex): SourceChanges {
        const before = new Map((previous?.files ?? []).map((file) => [file.path, file]));
        const added: string[] = [];
        const changed: string[] = [];
        for (const file of current.files) {
            const old = before.get(file.path);
            if (!old) {
                added.push(file.path);
            } else if (old.hash !== file.hash || old.size !== file.size) {
                changed.push(file.path);
            }
            before.delete(file.path);
        }
        return { added, changed, removed: [...before.keys()] };
    }

    private isSkippedFolder(rel: string, name: string): boolean {
        if (SourceInventory.COMMON_SKIP.includes(name) || (/^Build/i.test(name) && this.engine === "unity")) {
            return true;
        }
        if (this.engine === "unity") {
            return SourceInventory.UNITY_SKIP.includes(name);
        }
        if (this.engine === "unreal") {
            return SourceInventory.UNREAL_SKIP.some((skip) => (skip.includes("/") ? rel === skip : name === skip));
        }
        return false;
    }

    private static ignored(ignores: Array<{ base: string; rules: GitIgnore }>, rel: string, isDir: boolean): boolean {
        let result = false;
        for (const { base, rules } of ignores) {
            if (base && !rel.startsWith(`${base}/`)) {
                continue;
            }
            const match = rules.match(base ? rel.slice(base.length + 1) : rel, isDir);
            if (match !== null) {
                result = match;
            }
        }
        return result;
    }

    /** Decides whether and how a file is listed; null leaves it out. */
    private async select(
        rel: string,
        name: string
    ): Promise<{ kind: SourceFileKind; priority: number; nameOnly: boolean } | null> {
        const lower = name.toLowerCase();
        const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
        if (ext === ".md" || ext === ".mdx") {
            return {
                kind: "markdown",
                priority: lower === "design.md" ? 0 : lower === "readme.md" ? 1 : 2,
                nameOnly: false,
            };
        }
        if (this.engine === "unity") {
            return this.selectUnity(rel, ext);
        }
        if (this.engine === "unreal") {
            return this.selectUnreal(rel, name, ext);
        }
        if (SourceInventory.STYLE_EXTENSIONS.has(ext)) {
            return { kind: "style", priority: 3, nameOnly: false };
        }
        if (SourceInventory.CONFIG_NAMES.has(lower)) {
            return { kind: "config", priority: 4, nameOnly: false };
        }
        if (SourceInventory.CODE_EXTENSIONS.has(ext)) {
            const ui = SourceInventory.UI_WORDS.test(rel);
            return { kind: ui ? "ui" : "code", priority: ui ? 3 : 5, nameOnly: false };
        }
        return null;
    }

    private async selectUnity(
        rel: string,
        ext: string
    ): Promise<{ kind: SourceFileKind; priority: number; nameOnly: boolean } | null> {
        const inUiFolder = SourceInventory.UNITY_UI_FOLDER.test(rel);
        if (ext === ".uxml" || ext === ".uss" || ext === ".tss") {
            return { kind: ext === ".uxml" ? "ui" : "style", priority: 3, nameOnly: false };
        }
        if (ext === ".cs") {
            if (inUiFolder || (await this.contentMatches(rel, SourceInventory.UNITY_UI_CODE))) {
                return { kind: "ui", priority: 3, nameOnly: false };
            }
            return null;
        }
        if (ext === ".prefab" || ext === ".unity") {
            return inUiFolder || /(ui|hud|menu)/i.test(rel.split("/").pop() ?? "")
                ? { kind: "asset-name", priority: 6, nameOnly: true }
                : null;
        }
        if (inUiFolder && [".ttf", ".otf", ".png", ".psd", ".svg", ".jpg", ".tga", ".asset"].includes(ext)) {
            return { kind: "asset-name", priority: 6, nameOnly: true };
        }
        return null;
    }

    private async selectUnreal(
        rel: string,
        name: string,
        ext: string
    ): Promise<{ kind: SourceFileKind; priority: number; nameOnly: boolean } | null> {
        if (rel.startsWith("Source/") && [".h", ".cpp", ".cs"].includes(ext)) {
            if (
                SourceInventory.UNREAL_UI_NAME.test(name) ||
                (await this.contentMatches(rel, SourceInventory.UNREAL_UI_CODE))
            ) {
                return { kind: "ui", priority: 3, nameOnly: false };
            }
            return null;
        }
        if (/^Config\/[^/]+\.ini$/i.test(rel)) {
            return (await this.contentMatches(rel, /\b(UI|Widget|HUD|Slate|UMG)\w*/))
                ? { kind: "config", priority: 4, nameOnly: false }
                : null;
        }
        if (ext === ".uasset" && SourceInventory.UNREAL_UI_CONTENT.test(rel)) {
            return { kind: "asset-name", priority: 6, nameOnly: true };
        }
        return null;
    }

    /** Checks the first 256 KB of a file against a pattern. */
    private async contentMatches(rel: string, pattern: RegExp): Promise<boolean> {
        let handle;
        try {
            handle = await open(join(this.root, rel), "r");
            const buffer = Buffer.alloc(256 * 1024);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return pattern.test(buffer.subarray(0, bytesRead).toString("utf8"));
        } catch {
            return false;
        } finally {
            await handle?.close();
        }
    }

    private async hash(rel: string): Promise<string | null> {
        try {
            return createHash("sha1")
                .update(await readFile(join(this.root, rel)))
                .digest("hex");
        } catch {
            return null;
        }
    }

    private async readGitIgnore(dir: string): Promise<GitIgnore | null> {
        try {
            const file = join(this.root, dir, ".gitignore");
            if ((await stat(file)).size > 256 * 1024) {
                return null;
            }
            const rules = new GitIgnore(await readFile(file, "utf8"));
            return rules.empty ? null : rules;
        } catch {
            return null;
        }
    }
}
