import { lstatSync, realpathSync } from "fs";
import path from "path";

/**
 * Error thrown when a path resolves outside the guarded root.
 */
export class PathOutsideRootError extends Error {
    constructor(
        public readonly candidate: string,
        public readonly root: string
    ) {
        super(`Path ${JSON.stringify(candidate)} is outside the project folder`);
        this.name = "PathOutsideRootError";
    }
}

/**
 * Guard that confines file system paths to one root folder.
 *
 * A path is accepted only if, after resolving it against the root, following symbolic links and
 * junctions of its existing part, it lies inside the root. On Windows, the comparison ignores case,
 * and UNC, device and drive-relative paths are rejected outright, as are reserved device names
 * (`NUL`, `CON`, `COM1.txt`, …), which open a device instead of a file in any folder, and
 * alternate data streams (`file.txt:stream`).
 */
export class PathGuard {
    /** the guarded root folder (resolved, not followed through links) */
    public readonly root: string;
    private readonly platformPath: typeof path.posix;
    private readonly isWindows: boolean;

    /**
     * Creates a guard for the given root.
     *
     * @param root - the root folder; it must exist when paths are checked
     * @param platform - the platform whose path rules apply (defaults to the current one)
     */
    constructor(root: string, platform: NodeJS.Platform = process.platform) {
        this.isWindows = platform === "win32";
        this.platformPath = this.isWindows ? path.win32 : path.posix;
        this.root = this.platformPath.resolve(root);
    }

    /**
     * Resolves a path inside the root.
     *
     * @param candidate - an absolute path, or a path relative to the root
     * @returns the resolved real path (symbolic links of the existing part followed)
     * @throws PathOutsideRootError if the path is outside the root or not acceptable
     */
    public resolve(candidate: string): string {
        if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
            throw new PathOutsideRootError(String(candidate), this.root);
        }
        if (this.isWindows && PathGuard.isSpecialWindowsPath(candidate)) {
            throw new PathOutsideRootError(candidate, this.root);
        }
        const lexical = this.platformPath.resolve(this.root, candidate);
        if (!this.isInside(this.root, lexical)) {
            throw new PathOutsideRootError(candidate, this.root);
        }
        const realRoot = this.realPath(this.root);
        const real = this.realPathOfNearestExisting(lexical);
        if (!this.isInside(realRoot, real)) {
            throw new PathOutsideRootError(candidate, this.root);
        }
        return real;
    }

    /**
     * Checks whether a path resolves inside the root.
     *
     * @param candidate - an absolute path, or a path relative to the root
     */
    public contains(candidate: string): boolean {
        try {
            this.resolve(candidate);
            return true;
        } catch (error) {
            if (error instanceof PathOutsideRootError) {
                return false;
            }
            throw error;
        }
    }

    /**
     * Checks for UNC (`\\server\share`, `//server/share`), device (`\\?\`, `\\.\`) and drive-relative
     * (`C:foo`) paths, alternate data streams (`file.txt:stream`) and reserved device names.
     */
    public static isSpecialWindowsPath(candidate: string): boolean {
        if (/^[\\/]{2}/.test(candidate) || /^[a-zA-Z]:(?![\\/])/.test(candidate)) {
            return true;
        }
        if (candidate.replace(/^[a-zA-Z]:/, "").includes(":")) {
            return true;
        }
        return candidate.split(/[\\/]/).some((segment) => PathGuard.isReservedWindowsName(segment));
    }

    /**
     * Checks for a device name (`NUL`, `con.txt`, `COM1 .log`); Windows opens the device whatever
     * the folder, extension or trailing dots and spaces.
     */
    private static isReservedWindowsName(segment: string): boolean {
        const stem = segment
            .split(".")[0]
            .replace(/[ .]+$/, "")
            .toLowerCase();
        return /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/.test(stem);
    }

    private isInside(root: string, target: string): boolean {
        const normalize = (value: string) => (this.isWindows ? value.toLowerCase() : value);
        const relative = this.platformPath.relative(normalize(root), normalize(target));
        if (relative === "") {
            return true;
        }
        const firstSegment = relative.split(this.platformPath.sep)[0];
        return firstSegment !== ".." && !this.platformPath.isAbsolute(relative);
    }

    private realPath(target: string): string {
        return realpathSync.native(target);
    }

    /**
     * Resolves the real path of the longest existing prefix of a path and appends the rest.
     *
     * A dangling link counts as existing, so its real path cannot be resolved and the path is
     * rejected: writing through it would create a file wherever the link points.
     */
    private realPathOfNearestExisting(target: string): string {
        const missing: string[] = [];
        let current = target;
        while (!PathGuard.entryExists(current)) {
            const parent = this.platformPath.dirname(current);
            if (parent === current) {
                return target;
            }
            missing.unshift(this.platformPath.basename(current));
            current = parent;
        }
        let real: string;
        try {
            real = this.realPath(current);
        } catch {
            throw new PathOutsideRootError(target, this.root);
        }
        return this.platformPath.join(real, ...missing);
    }

    /** Checks whether a directory entry exists, without following a final link. */
    private static entryExists(target: string): boolean {
        try {
            lstatSync(target);
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Guard of one project: its own folder (`<PENFORGE_HOME>/projects/<id>/`), plus the folder of this
 * computer the project is linked to (W38 Game UI / Existing project) and the app folder the user
 * picked for a web or mobile project (W41), when there is one.
 *
 * Relative paths resolve against the project folder only. An absolute path is accepted when it
 * lies inside one of the roots, with the same rules for each root (links followed, `..`, UNC,
 * device names and alternate data streams refused). The linked root and the app root belong to
 * this guard alone: other projects' guards never see them.
 */
export class ProjectPathGuard extends PathGuard {
    private linked: PathGuard | null = null;
    private app: PathGuard | null = null;

    /**
     * Creates a guard for a project folder.
     *
     * @param root - the project folder; it must exist when paths are checked
     * @param platform - the platform whose path rules apply (defaults to the current one)
     */
    constructor(
        root: string,
        private readonly platform: NodeJS.Platform = process.platform
    ) {
        super(root, platform);
    }

    /** The linked folder, or null when the project has none. */
    public get linkedRoot(): string | null {
        return this.linked?.root ?? null;
    }

    /**
     * Sets or clears the linked folder.
     *
     * @param root - an absolute folder path (it must exist when paths are checked), or null
     */
    public setLinkedRoot(root: string | null): void {
        this.linked = this.rootGuard(root);
    }

    /** The app folder outside the project folder (W41), or null. */
    public get appRoot(): string | null {
        return this.app?.root ?? null;
    }

    /**
     * Sets or clears the app folder outside the project folder (W41). The caller checked that it is
     * the folder Penforge made for this project.
     *
     * @param root - an absolute folder path, or null
     */
    public setAppRoot(root: string | null): void {
        this.app = this.rootGuard(root);
    }

    /**
     * Resolves a path inside the project folder, or an absolute path inside the linked folder or
     * the app folder.
     *
     * @param candidate - an absolute path, or a path relative to the project folder
     * @returns the resolved real path
     * @throws PathOutsideRootError if the path is in none of the roots or not acceptable
     */
    public override resolve(candidate: string): string {
        try {
            return super.resolve(candidate);
        } catch (error) {
            if (!(error instanceof PathOutsideRootError) || !this.isAbsolutePath(candidate)) {
                throw error;
            }
            return this.resolveOutside(candidate, error);
        }
    }

    /**
     * Resolves a path inside the linked folder; a relative path is taken relative to it.
     *
     * @param candidate - an absolute path, or a path relative to the linked folder
     * @throws PathOutsideRootError if the project has no linked folder or the path is outside it
     */
    public resolveLinked(candidate: string): string {
        if (this.linked === null) {
            throw new PathOutsideRootError(String(candidate), this.root);
        }
        return this.linked.resolve(candidate);
    }

    /** Resolves an absolute path outside the project folder in the app folder or the linked folder. */
    private resolveOutside(candidate: string, outside: PathOutsideRootError): string {
        if (this.app !== null) {
            try {
                return this.app.resolve(candidate);
            } catch {
                // not in the app folder, or the folder went away
            }
        }
        if (this.linked === null) {
            throw outside;
        }
        return this.linked.resolve(candidate);
    }

    private rootGuard(root: string | null): PathGuard | null {
        if (root === null) {
            return null;
        }
        const platformPath = this.platform === "win32" ? path.win32 : path.posix;
        if (!platformPath.isAbsolute(root)) {
            throw new PathOutsideRootError(root, this.root);
        }
        return new PathGuard(root, this.platform);
    }

    private isAbsolutePath(candidate: string): boolean {
        return (
            typeof candidate === "string" && (this.platform === "win32" ? path.win32 : path.posix).isAbsolute(candidate)
        );
    }
}
