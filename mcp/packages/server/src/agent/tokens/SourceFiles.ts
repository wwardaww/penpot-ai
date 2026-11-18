import { lstat, readdir, readFile } from "fs/promises";
import { extname, join, relative } from "path";

/** Source file of the app: path relative to `app-src/` (forward slashes) and text. */
export interface SourceFile {
    file: string;
    text: string;
}

/**
 * Reader of the generated app's source files: no dependencies, build output, git data or
 * hidden folders, never through symbolic links (a link could leave `app-src/` or loop), and with
 * limits so a large app cannot slow a sync down.
 */
export class SourceFiles {
    private static readonly SKIPPED_DIRS = new Set([
        "node_modules",
        "dist",
        "build",
        "coverage",
        "android",
        "ios",
        "public",
    ]);
    private static readonly MAX_FILES = 2000;
    private static readonly MAX_FILE_BYTES = 512 * 1024;
    private static readonly MAX_DEPTH = 12;

    private constructor() {}

    /**
     * Lists the source files with one of the extensions.
     *
     * @param appSrcDir - the `app-src/` folder
     * @param extensions - lower-case extensions with the dot, e.g. `.css`
     */
    public static async list(appSrcDir: string, extensions: ReadonlySet<string>): Promise<SourceFile[]> {
        const files: SourceFile[] = [];
        const pending: { dir: string; depth: number }[] = [{ dir: appSrcDir, depth: 0 }];
        while (pending.length > 0 && files.length < SourceFiles.MAX_FILES) {
            const { dir, depth } = pending.shift()!;
            let names: string[];
            try {
                names = await readdir(dir);
            } catch {
                continue;
            }
            for (const name of names.sort()) {
                if (files.length >= SourceFiles.MAX_FILES) {
                    break;
                }
                const path = join(dir, name);
                let info;
                try {
                    info = await lstat(path);
                } catch {
                    continue;
                }
                if (info.isSymbolicLink()) {
                    continue;
                }
                if (info.isDirectory()) {
                    if (!SourceFiles.SKIPPED_DIRS.has(name) && !name.startsWith(".") && depth < SourceFiles.MAX_DEPTH) {
                        pending.push({ dir: path, depth: depth + 1 });
                    }
                } else if (
                    info.isFile() &&
                    extensions.has(extname(name).toLowerCase()) &&
                    info.size <= SourceFiles.MAX_FILE_BYTES
                ) {
                    try {
                        files.push({
                            file: relative(appSrcDir, path).replace(/\\/g, "/"),
                            text: await readFile(path, "utf8"),
                        });
                    } catch {
                        // unreadable file: skip
                    }
                }
            }
        }
        return files;
    }
}
