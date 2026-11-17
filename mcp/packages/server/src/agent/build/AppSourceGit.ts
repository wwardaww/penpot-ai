import { execFile } from "child_process";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Git view of the generated app (`app-src/`) used to see which files a build step touched.
 *
 * A snapshot is the tree hash of the whole working folder (`git add -A` + `git write-tree`), so
 * comparing two snapshots lists every file created, changed or deleted in between, without making
 * commits. Ignored files (dependencies, build output) never count.
 */
export class AppSourceGit {
    /** Lines every generated app ignores, whatever its stack. */
    private static readonly IGNORED = [
        "node_modules/",
        "dist/",
        "build/",
        ".next/",
        ".expo/",
        ".turbo/",
        ".cache/",
        "coverage/",
        "*.log",
        ".env",
        ".env.*",
    ];

    constructor(private readonly dir: string) {}

    /**
     * Adds the standard ignore lines to `.gitignore` when missing, so dependencies never reach git.
     */
    public async ensureIgnores(): Promise<void> {
        const file = join(this.dir, ".gitignore");
        const current = existsSync(file) ? await readFile(file, "utf8") : "";
        const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
        const missing = AppSourceGit.IGNORED.filter((line) => !present.has(line));
        if (missing.length === 0) {
            return;
        }
        const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
        await writeFile(file, `${prefix}${missing.join("\n")}\n`, "utf8");
    }

    /** Takes a snapshot of the working folder; returns its tree hash. */
    public async snapshot(): Promise<string> {
        await this.git(["add", "-A"]);
        return (await this.git(["write-tree"])).trim();
    }

    /**
     * Lists files that differ between two snapshots.
     *
     * @returns paths relative to `app-src/`, forward slashes
     */
    public async changedFiles(from: string, to: string): Promise<string[]> {
        if (from === to) {
            return [];
        }
        const out = await this.git(["diff", "--name-only", "--no-renames", from, to]);
        return out
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
    }

    /**
     * Puts files back to their content in a snapshot; files the snapshot lacks are deleted.
     *
     * @param snapshot - tree hash from {@link snapshot}
     * @param files - paths relative to `app-src/`
     */
    public async restore(snapshot: string, files: string[]): Promise<void> {
        if (files.length === 0) {
            return;
        }
        const listed = await this.git(["ls-tree", "-r", "--name-only", snapshot, "--", ...files]);
        const present = new Set(listed.split("\n").filter((line) => line.length > 0));
        const kept = files.filter((file) => present.has(file));
        const removed = files.filter((file) => !present.has(file));
        if (kept.length > 0) {
            await this.git(["checkout", snapshot, "--", ...kept]);
        }
        if (removed.length > 0) {
            await this.git(["rm", "-q", "-f", "--ignore-unmatch", "--", ...removed]);
        }
    }

    /** Tells whether a file exists in the working folder. */
    public exists(file: string): boolean {
        return existsSync(join(this.dir, file));
    }

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, {
            cwd: this.dir,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    }
}
