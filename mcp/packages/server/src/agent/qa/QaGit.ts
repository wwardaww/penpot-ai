import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Git operations of the visual QA on `app-src/` that touch only the files the QA changed, so
 * edits the user made by hand never end up in a `penforge(qa)` commit.
 */
export class QaGit {
    constructor(private readonly dir: string) {}

    /** Files with uncommitted changes (tracked or new), relative to `app-src/`. */
    public async dirtyFiles(): Promise<string[]> {
        const out = await this.git([
            "-c",
            "core.quotepath=off",
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
        ]);
        const files: string[] = [];
        const entries = out.split("\0");
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.length < 4) {
                continue;
            }
            files.push(entry.slice(3));
            // a rename lists its source path as the next entry
            if (entry[0] === "R" || entry[0] === "C") {
                i++;
            }
        }
        return files;
    }

    /**
     * Commits exactly the given files (new, changed or deleted) and nothing else.
     *
     * @returns the commit hash, or null when none of them changed
     */
    public async commitFiles(files: string[], message: string): Promise<string | null> {
        if (files.length === 0) {
            return null;
        }
        await this.git(["add", "-A", "--", ...files]);
        const staged = await this.git(["diff", "--cached", "--name-only", "-z", "--", ...files]);
        if (staged.replace(/\0/g, "").length === 0) {
            return null;
        }
        await this.git([...(await this.identity()), "commit", "-q", "--only", "-m", message, "--", ...files]);
        return (await this.git(["rev-parse", "HEAD"])).trim();
    }

    private async identity(): Promise<string[]> {
        const configured = await this.git(["config", "user.email"])
            .then((email) => email.trim().length > 0)
            .catch(() => false);
        return configured ? [] : ["-c", "user.name=Penforge", "-c", "user.email=penforge@localhost"];
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
