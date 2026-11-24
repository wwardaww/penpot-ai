import { lstatSync, realpathSync } from "fs";
import path from "path";

/**
 * Comparisons of absolute folder paths with the rules of a platform (Windows ignores case).
 */
export class FolderPaths {
    private readonly platformPath: typeof path.posix;
    private readonly isWindows: boolean;

    /**
     * @param platform - the platform whose path rules apply
     */
    constructor(platform: NodeJS.Platform = process.platform) {
        this.isWindows = platform === "win32";
        this.platformPath = this.isWindows ? path.win32 : path.posix;
    }

    /** Tells whether two paths name the same folder (lexically). */
    public same(a: string, b: string): boolean {
        return this.normalize(a) === this.normalize(b);
    }

    /**
     * Tells whether a path is a folder or lies inside it (lexically).
     *
     * @param root - the folder
     * @param target - the path
     */
    public inside(root: string, target: string): boolean {
        const rel = this.platformPath.relative(this.normalize(root), this.normalize(target));
        return rel === "" || (rel.split(this.platformPath.sep)[0] !== ".." && !this.platformPath.isAbsolute(rel));
    }

    /** The folder and its parents, nearest first. */
    public selfAndParents(folder: string): string[] {
        const chain: string[] = [];
        let current = this.platformPath.resolve(folder);
        for (;;) {
            chain.push(current);
            const parent = this.platformPath.dirname(current);
            if (parent === current) {
                return chain;
            }
            current = parent;
        }
    }

    /**
     * Tells whether a path is an existing folder reached without following any link, so that a
     * link put in its place later is noticed.
     */
    public isRealFolder(folder: string): boolean {
        try {
            return lstatSync(folder).isDirectory() && this.same(realpathSync.native(folder), folder);
        } catch {
            return false;
        }
    }

    private normalize(value: string): string {
        const resolved = this.platformPath.resolve(value);
        return this.isWindows ? resolved.toLowerCase() : resolved;
    }
}
