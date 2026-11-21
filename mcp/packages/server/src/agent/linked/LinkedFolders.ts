import { realpathSync } from "fs";
import { access, readdir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";
import type {
    FolderFacts,
    FolderListReplyMessage,
    FolderRoot,
    LinkedProjectKind,
    LinkRefusalReason,
} from "@penpot/mcp-common";
import { AgentError } from "../AgentClient";
import { PathGuard } from "../workspace/pathGuard";
import { FolderInspector } from "./FolderInspector";

/** A refused folder: `error {code:"bad-request", reason}` for the client. */
export class LinkRefusal extends AgentError {
    constructor(
        public readonly refusal: LinkRefusalReason,
        message: string
    ) {
        super("bad-request", message, refusal);
        this.name = "LinkRefusal";
    }
}

/** A folder accepted for a link. */
export interface AcceptedFolder {
    /** real path */
    root: string;
    facts: FolderFacts;
}

/**
 * Folders of this computer as the folder browser and project links (W38) see them.
 *
 * Browsing is read-only and returns folder names only. A link needs an existing, readable folder
 * that is not a drive or file system root, not the home folder itself, not a system folder, and
 * neither inside the Penforge home nor holding it (so a linked folder never opens other projects,
 * settings or tokens). Game UI needs a Unity or Unreal project; Existing project a non-empty folder.
 */
export class LinkedFolders {
    /** sub-folders listed at most */
    public static readonly MAX_ENTRIES = 1000;
    /** folder names never listed (system and trash folders) */
    private static readonly HIDDEN_NAMES = new Set([
        "system volume information",
        "$recycle.bin",
        "recycler",
        "lost+found",
        "config.msi",
    ]);

    private readonly platformPath: typeof path.posix;
    private readonly isWindows: boolean;
    private readonly inspector = new FolderInspector();

    /**
     * @param penforgeHome - the Penforge home (`~/Penforge`), never linkable
     * @param home - the user's home folder
     * @param platform - the platform whose path rules apply
     * @param env - environment with the Windows system folders
     */
    constructor(
        private readonly penforgeHome: string,
        private readonly home: string = homedir(),
        private readonly platform: NodeJS.Platform = process.platform,
        private readonly env: NodeJS.ProcessEnv = process.env
    ) {
        this.isWindows = platform === "win32";
        this.platformPath = this.isWindows ? path.win32 : path.posix;
    }

    /**
     * Lists the roots (no path) or the sub-folders of a folder.
     *
     * @param rid - the request id
     * @param requested - an absolute folder path, or undefined/empty for the roots
     * @throws LinkRefusal for a bad, missing or unreadable folder
     */
    public async list(rid: string, requested: string | undefined): Promise<FolderListReplyMessage> {
        if (requested === undefined || requested.trim().length === 0) {
            return {
                type: "folder.list",
                rid,
                path: null,
                parent: null,
                roots: await this.roots(),
                entries: [],
                truncated: false,
                facts: null,
            };
        }
        const folder = await this.realFolder(requested);
        let dirents;
        try {
            dirents = await readdir(folder, { withFileTypes: true });
        } catch {
            throw new LinkRefusal("folder-unreadable", "The folder cannot be read");
        }
        const names = dirents
            .filter((entry) => entry.isDirectory() && !this.isHiddenName(entry.name))
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
        const parent = this.platformPath.dirname(folder);
        return {
            type: "folder.list",
            rid,
            path: folder,
            parent: parent === folder ? null : parent,
            roots: [],
            entries: names
                .slice(0, LinkedFolders.MAX_ENTRIES)
                .map((name) => ({ name, path: this.platformPath.join(folder, name) })),
            truncated: names.length > LinkedFolders.MAX_ENTRIES,
            facts: await this.inspector.facts(folder).catch(() => null),
        };
    }

    /**
     * Checks a folder for a link.
     *
     * @param kind - the project type
     * @param requested - the absolute folder path the user chose
     * @returns the real path and facts of the folder
     * @throws LinkRefusal when the folder cannot be linked
     */
    public async accept(kind: LinkedProjectKind, requested: string): Promise<AcceptedFolder> {
        const root = await this.realFolder(requested);
        if (this.isRefusedRoot(root)) {
            throw new LinkRefusal(
                "folder-refused",
                "This folder cannot be linked: pick the folder of the game or app itself, not a drive, " +
                    "your home folder, a system folder or the Penforge folder"
            );
        }
        let facts: FolderFacts;
        try {
            facts = await this.inspector.facts(root);
        } catch {
            throw new LinkRefusal("folder-unreadable", "The folder cannot be read");
        }
        if (kind === "game" && facts.engine === null) {
            throw new LinkRefusal(
                "not-a-game",
                "This is not a Unity or Unreal Engine project: a Unity project has Assets and ProjectSettings " +
                    "folders, an Unreal project a .uproject file"
            );
        }
        if (kind === "existing" && facts.empty) {
            throw new LinkRefusal("empty-folder", "The folder is empty");
        }
        return { root, facts };
    }

    /**
     * Tells whether a folder may never be linked: a root, the home folder, a system folder, or a
     * folder inside or around the Penforge home.
     *
     * @param folder - a real absolute path
     */
    public isRefusedRoot(folder: string): boolean {
        const p = this.platformPath;
        if (p.dirname(folder) === folder) {
            return true;
        }
        if (this.same(folder, this.home)) {
            return true;
        }
        for (const penforgeHome of this.penforgeHomes()) {
            if (this.inside(folder, penforgeHome) || this.inside(penforgeHome, folder)) {
                return true;
            }
        }
        return this.systemFolders().some((system) => this.inside(system, folder));
    }

    /**
     * Resolves a requested folder to its real path.
     *
     * @throws LinkRefusal for a relative or special path, a missing folder or a file
     */
    private async realFolder(requested: string): Promise<string> {
        if (
            typeof requested !== "string" ||
            requested.length > 4096 ||
            requested.includes("\0") ||
            !this.platformPath.isAbsolute(requested) ||
            (this.isWindows && PathGuard.isSpecialWindowsPath(requested))
        ) {
            throw new LinkRefusal("bad-path", "Enter the full path of a folder");
        }
        const lexical = this.platformPath.resolve(requested);
        let info;
        try {
            info = await stat(lexical);
        } catch {
            throw new LinkRefusal("folder-missing", "The folder does not exist");
        }
        if (!info.isDirectory()) {
            throw new LinkRefusal("not-a-folder", "This is a file, not a folder");
        }
        try {
            return await realpath(lexical);
        } catch {
            throw new LinkRefusal("folder-unreadable", "The folder cannot be read");
        }
    }

    private async roots(): Promise<FolderRoot[]> {
        const roots: FolderRoot[] = [
            { name: this.platformPath.basename(this.home) || this.home, path: this.home, kind: "home" },
        ];
        if (!this.isWindows) {
            return [...roots, { name: "/", path: "/", kind: "drive" }];
        }
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
        const found = await Promise.all(
            letters.map((letter) =>
                access(`${letter}:\\`)
                    .then(() => letter)
                    .catch(() => null)
            )
        );
        return [
            ...roots,
            ...found
                .filter((letter): letter is string => letter !== null)
                .map((letter) => ({ name: `${letter}:`, path: `${letter}:\\`, kind: "drive" as const })),
        ];
    }

    /** The Penforge home as configured and as its real path (it may sit behind a link). */
    private penforgeHomes(): string[] {
        try {
            return [this.penforgeHome, realpathSync.native(this.penforgeHome)];
        } catch {
            return [this.penforgeHome];
        }
    }

    private isHiddenName(name: string): boolean {
        return name.startsWith(".") || name.startsWith("$") || LinkedFolders.HIDDEN_NAMES.has(name.toLowerCase());
    }

    private systemFolders(): string[] {
        if (!this.isWindows) {
            return [
                "/bin",
                "/boot",
                "/dev",
                "/etc",
                "/lib",
                "/proc",
                "/sbin",
                "/sys",
                "/usr",
                "/var",
                "/System",
                "/Library",
                "/Applications",
                "/private",
            ];
        }
        const drive = (this.env.SystemDrive ?? "C:").replace(/[\\/]+$/, "");
        return [
            this.env.SystemRoot ?? this.env.windir ?? `${drive}\\Windows`,
            this.env.ProgramFiles ?? `${drive}\\Program Files`,
            this.env["ProgramFiles(x86)"] ?? `${drive}\\Program Files (x86)`,
            this.env.ProgramData ?? `${drive}\\ProgramData`,
        ];
    }

    private same(a: string, b: string): boolean {
        const rel = this.platformPath.relative(this.norm(b), this.norm(a));
        return rel === "";
    }

    /** Tells whether `target` is `root` or lies inside it. */
    private inside(root: string, target: string): boolean {
        const rel = this.platformPath.relative(this.norm(root), this.norm(target));
        return rel === "" || (rel.split(this.platformPath.sep)[0] !== ".." && !this.platformPath.isAbsolute(rel));
    }

    private norm(value: string): string {
        const resolved = this.platformPath.resolve(value);
        return this.isWindows ? resolved.toLowerCase() : resolved;
    }
}
