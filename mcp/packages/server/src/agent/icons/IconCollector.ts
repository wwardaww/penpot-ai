import type { ArchiveEntry } from "./ArchiveReader";
import type { IconLimits } from "./IconLimits";
import { sanitizeSvg, type SvgRejectReason } from "./SvgSanitizer";

/** One icon ready for Penpot. */
export interface CollectedIcon {
    /** stable id: `<group path>/<name>` (shared plugin data `penforge/icon` of the component) */
    id: string;
    /** component name */
    name: string;
    /** component path, `Icons` or `Icons / <sub folder>` */
    path: string;
    /** sanitized SVG */
    svg: string;
}

/** An icon that was left out, and why. */
export interface SkippedIcon {
    name: string;
    reason: SvgRejectReason | "file-too-large" | "duplicate" | "limit";
}

/** License found next to the icons. */
export interface FoundLicense {
    /** SPDX id when recognized, else null */
    spdx: string | null;
    /** path of the license file inside the source */
    file: string;
    /** first lines of the license text */
    excerpt: string;
}

/** Icons of one source. */
export interface IconCollection {
    icons: CollectedIcon[];
    skipped: SkippedIcon[];
    license: FoundLicense | null;
    /** true when more icons were found than {@link IconLimits.maxIcons} */
    truncated: boolean;
    /** how many SVG files were found */
    found: number;
}

/** Component path root of every icon. */
export const ICON_ROOT = "Icons";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown|rst))?$/i;
const EXCERPT_CHARS = 600;

/**
 * Collects the icons of a source: keeps the `.svg` files inside the chosen folder, sanitizes
 * them, names them after their file and sub folder, drops duplicates and stops at the icon limit.
 * Also picks the license file (the folder's, else the repository's).
 */
export class IconCollector {
    private readonly icons: CollectedIcon[] = [];
    private readonly skipped: SkippedIcon[] = [];
    private readonly ids = new Set<string>();
    private licenses: { depth: number; license: FoundLicense }[] = [];
    private found = 0;
    private truncated = false;

    /**
     * @param folder - folder of the source the icons come from, `/`-separated, "" = all
     * @param limits - import limits
     * @param stripRoot - drop the first path segment (GitHub archives wrap everything in
     *   `<repo>-<ref>/`)
     */
    constructor(
        private readonly folder: string,
        private readonly limits: IconLimits,
        private readonly stripRoot: boolean
    ) {}

    /** Path of an archive entry relative to the repository root. */
    public relative(path: string): string {
        const parts = path.split("/").filter((part) => part.length > 0);
        return (this.stripRoot ? parts.slice(1) : parts).join("/");
    }

    /** Whether an archive entry is worth reading. */
    public wanted(path: string): boolean {
        const relative = this.relative(path);
        const base = relative.split("/").at(-1) ?? "";
        if (LICENSE_FILE.test(base)) {
            return this.licenseDepth(relative) !== null;
        }
        return /\.svg$/i.test(base) && this.inFolder(relative);
    }

    /** Size limit of an archive entry. */
    public maxEntryBytes(path: string): number {
        return /\.svg$/i.test(path) ? this.limits.maxFileBytes : this.limits.maxLicenseBytes;
    }

    /** Whether the icon limit is reached (the caller may stop reading). */
    public get full(): boolean {
        return this.truncated;
    }

    /** Adds one archive entry. */
    public add(entry: ArchiveEntry): void {
        const relative = this.relative(entry.path);
        const base = relative.split("/").at(-1) ?? "";
        if (LICENSE_FILE.test(base)) {
            const depth = this.licenseDepth(relative);
            if (depth !== null && entry.data) {
                const text = entry.data.toString("utf8");
                this.licenses.push({
                    depth,
                    license: { spdx: detectLicense(text), file: relative, excerpt: excerpt(text) },
                });
            }
            return;
        }
        if (!/\.svg$/i.test(base) || !this.inFolder(relative)) {
            return;
        }
        this.found++;
        const inner = this.folder ? relative.slice(this.folder.length).replace(/^\//, "") : relative;
        const segments = inner.split("/");
        const name = cleanName(segments.at(-1)!.replace(/\.svg$/i, ""));
        const groups = segments
            .slice(0, -1)
            .map(cleanName)
            .filter((part) => part.length > 0);
        const path = [ICON_ROOT, ...groups].join(" / ");
        const id = [...groups, name].join("/");
        if (this.icons.length >= this.limits.maxIcons) {
            this.truncated = true;
            return;
        }
        if (!entry.data) {
            this.skipped.push({ name: id, reason: "file-too-large" });
            return;
        }
        if (this.ids.has(id)) {
            this.skipped.push({ name: id, reason: "duplicate" });
            return;
        }
        const result = sanitizeSvg(entry.data.toString("utf8"));
        if (!result.ok) {
            this.skipped.push({ name: id, reason: result.reason });
            return;
        }
        this.ids.add(id);
        this.icons.push({ id, name, path, svg: result.svg });
    }

    /** The collection so far. */
    public result(): IconCollection {
        const license =
            this.licenses.length === 0
                ? null
                : [...this.licenses].sort(
                      (a, b) => b.depth - a.depth || a.license.file.localeCompare(b.license.file)
                  )[0].license;
        return {
            icons: [...this.icons].sort((a, b) => a.id.localeCompare(b.id)),
            skipped: this.skipped,
            license,
            truncated: this.truncated,
            found: this.found,
        };
    }

    private inFolder(relative: string): boolean {
        return this.folder === "" || relative.startsWith(`${this.folder}/`);
    }

    /** Depth of a license file on the way to the folder (root = 0), or null when off that way. */
    private licenseDepth(relative: string): number | null {
        const dir = relative.split("/").slice(0, -1).join("/");
        if (dir === "") {
            return 0;
        }
        if (this.folder === dir || this.folder.startsWith(`${dir}/`)) {
            return dir.split("/").length;
        }
        return null;
    }
}

/** Recognizes common icon set licenses by their text. */
export function detectLicense(text: string): string | null {
    const t = text.replace(/\s+/g, " ");
    const checks: [RegExp, string][] = [
        [/Apache License,? Version 2\.0/i, "Apache-2.0"],
        [/Mozilla Public License,? (Version|v\.?) ?2\.0/i, "MPL-2.0"],
        [/SIL OPEN FONT LICENSE/i, "OFL-1.1"],
        [/GNU GENERAL PUBLIC LICENSE/i, "GPL"],
        [/Creative Commons Attribution 4\.0|CC BY 4\.0|creativecommons\.org\/licenses\/by\/4\.0/i, "CC-BY-4.0"],
        [/CC0 1\.0|creativecommons\.org\/publicdomain\/zero/i, "CC0-1.0"],
        [/Permission to use, copy, modify, and\/or distribute this software for any purpose/i, "ISC"],
        [/Permission is hereby granted, free of charge, to any person obtaining a copy/i, "MIT"],
        [
            /Redistribution and use in source and binary forms/i,
            /Neither the name/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause",
        ],
        [/This is free and unencumbered software released into the public domain/i, "Unlicense"],
    ];
    for (const [pattern, id] of checks) {
        if (pattern.test(t)) {
            return id;
        }
    }
    return null;
}

function excerpt(text: string): string {
    const clean = text.replace(/\r\n?/g, "\n").trim();
    return clean.length > EXCERPT_CHARS ? `${clean.slice(0, EXCERPT_CHARS)}…` : clean;
}

function cleanName(name: string): string {
    return name
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[\/\\]/g, "-")
        .trim()
        .slice(0, 100);
}
