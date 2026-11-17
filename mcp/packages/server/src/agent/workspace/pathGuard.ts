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
 * and UNC, device and drive-relative paths are rejected outright.
 */
export class PathGuard {
    private readonly root: string;
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
     * (`C:foo`) paths.
     */
    private static isSpecialWindowsPath(candidate: string): boolean {
        return /^[\\/]{2}/.test(candidate) || /^[a-zA-Z]:(?![\\/])/.test(candidate);
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
