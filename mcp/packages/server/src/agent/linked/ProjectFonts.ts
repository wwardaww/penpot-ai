import { readFile, stat } from "fs/promises";
import { basename, extname, join } from "path";
import type { SourceIndex } from "./SourceInventory";

/** A font file of the linked project. */
export interface ProjectFontFile {
    /** path relative to the linked folder */
    path: string;
    /** family guessed from the file name (the import reads the real one from the file) */
    family: string;
}

/** Fonts of a linked project (`.penforge/project-fonts.json`). */
export interface ProjectFontsInfo {
    /** Google Fonts families the code loads (next/font/google, Google Fonts links, Fontsource) */
    google: string[];
    /** font files the project ships */
    files: ProjectFontFile[];
}

/** A font file sent to the tab for the import into the team's fonts. */
export interface ProjectFontData {
    name: string;
    /** base64 of the file */
    data: string;
}

/**
 * Finds the fonts of a linked project, so the AI designs with them: Google Fonts families its code
 * loads, which Penpot has in its catalog, and font files it ships, which the tab imports into the
 * team's fonts (`fonts.files`).
 */
export class ProjectFonts {
    /** file name below `.penforge/` */
    public static readonly FILE = "project-fonts.json";
    /** code files scanned for Google Fonts at most */
    private static readonly MAX_SCANNED_FILES = 600;
    private static readonly MAX_SCANNED_BYTES = 400_000;
    /** font bytes sent to the tab at most */
    public static readonly MAX_SEND_BYTES = 40 * 1024 * 1024;
    private static readonly MAX_FONT_BYTES = 10 * 1024 * 1024;
    private static readonly SCANNED = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|html?|css|scss|sass|less|json)$/i;
    /** best format first: Penpot reads TTF, OTF and WOFF; WOFF2 only when nothing else exists */
    private static readonly FORMAT_ORDER = [".ttf", ".otf", ".woff", ".woff2"];
    private static readonly STYLE_WORDS =
        /[-_ ]?(thin|hairline|extralight|ultralight|light|regular|normal|book|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique|variable|variablefont|wght|ital|opsz|wdth|\d{3})$/i;

    /**
     * Collects the fonts from an inventory of the linked folder.
     *
     * @param root - the linked folder
     * @param index - its inventory
     */
    public static async collect(root: string, index: SourceIndex): Promise<ProjectFontsInfo> {
        const google = new Set<string>();
        const scanned = index.files
            .filter((file) => file.hash !== null && ProjectFonts.SCANNED.test(file.path))
            .slice(0, ProjectFonts.MAX_SCANNED_FILES);
        for (const file of scanned) {
            if (file.size > ProjectFonts.MAX_SCANNED_BYTES) {
                continue;
            }
            const text = await readFile(join(root, file.path), "utf8").catch(() => null);
            if (text !== null) {
                for (const family of ProjectFonts.googleFamilies(text)) {
                    google.add(family);
                }
            }
        }
        const files = (index.fonts ?? []).map((path) => ({ path, family: ProjectFonts.familyOf(path) }));
        return { google: [...google].sort(), files };
    }

    /**
     * Google Fonts families named in a source text.
     *
     * @param text - a code, style or package file
     */
    public static googleFamilies(text: string): string[] {
        const families = new Set<string>();
        // import { Archivo_Black, Inter } from "next/font/google"
        for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/g)) {
            for (const part of match[1].split(",")) {
                const name = part
                    .trim()
                    .split(/\s+as\s+/)[0]
                    .trim();
                if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) {
                    families.add(name.replace(/_/g, " "));
                }
            }
        }
        // https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Space+Mono
        for (const match of text.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'`\s)]+)/g)) {
            for (const param of match[1].replace(/&amp;/g, "&").split("&")) {
                if (param.startsWith("family=")) {
                    for (const entry of param.slice("family=".length).split("|")) {
                        const name = ProjectFonts.decode(entry.split(":")[0]).replace(/\+/g, " ").trim();
                        if (name) {
                            families.add(name);
                        }
                    }
                }
            }
        }
        // @fontsource/space-mono, @fontsource-variable/inter, @expo-google-fonts/inter
        for (const match of text.matchAll(/@(?:fontsource(?:-variable)?|expo-google-fonts)\/([a-z0-9-]+)/g)) {
            if (match[1] !== "dev") {
                families.add(
                    match[1]
                        .split("-")
                        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                        .join(" ")
                );
            }
        }
        return [...families];
    }

    /**
     * Family guessed from a font file name: `fonts/Inter-SemiBold.ttf` gives `Inter`.
     *
     * @param path - the file path
     */
    public static familyOf(path: string): string {
        let name = basename(path, extname(path));
        for (let i = 0; i < 4; i++) {
            const stripped = name.replace(ProjectFonts.STYLE_WORDS, "");
            if (stripped === name || stripped.length === 0) {
                break;
            }
            name = stripped;
        }
        return name
            .replace(/[-_]+/g, " ")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .trim();
    }

    /**
     * Font files to import, best format of each file name, within {@link MAX_SEND_BYTES}.
     *
     * @param root - the linked folder
     * @param info - the collected fonts
     */
    public static async filesToSend(root: string, info: ProjectFontsInfo): Promise<ProjectFontData[]> {
        const best = new Map<string, string>();
        const rank = (path: string) => ProjectFonts.FORMAT_ORDER.indexOf(extname(path).toLowerCase());
        for (const { path } of info.files) {
            const key = path.slice(0, path.length - extname(path).length).toLowerCase();
            const kept = best.get(key);
            if (rank(path) >= 0 && (kept === undefined || rank(path) < rank(kept))) {
                best.set(key, path);
            }
        }
        const result: ProjectFontData[] = [];
        let total = 0;
        for (const path of best.values()) {
            const size = await stat(join(root, path))
                .then((info) => info.size)
                .catch(() => -1);
            if (size <= 0 || size > ProjectFonts.MAX_FONT_BYTES || total + size > ProjectFonts.MAX_SEND_BYTES) {
                continue;
            }
            const data = await readFile(join(root, path)).catch(() => null);
            if (data !== null) {
                total += size;
                result.push({ name: basename(path), data: data.toString("base64") });
            }
        }
        return result;
    }

    /**
     * Prompt lines about the project's fonts; empty when it has none.
     *
     * @param info - the collected fonts, or null
     */
    public static promptLines(info: ProjectFontsInfo | null): string[] {
        if (info === null || (info.google.length === 0 && info.files.length === 0)) {
            return [];
        }
        const lines = ["### The project's fonts"];
        if (info.google.length > 0) {
            lines.push(`- Google Fonts the code loads: ${info.google.join(", ")} (in Penpot's font catalog).`);
        }
        const families = [...new Set(info.files.map((file) => file.family))];
        if (families.length > 0) {
            lines.push(
                `- Font files the project ships: ${families.slice(0, 20).join(", ")} (imported into the team's fonts ` +
                    "when the file opens)."
            );
        }
        lines.push("Design with these fonts unless the user asks for others.");
        return lines;
    }

    private static decode(value: string): string {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }
}
