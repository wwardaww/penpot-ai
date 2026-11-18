import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Commit of given files of one project repository (`design/` or `app-src/`), leaving every other
 * change of the working tree alone (`git commit --only` semantics through a pathspec). Paths are
 * literal (`--literal-pathspecs`), never globs.
 *
 * A sync commits only what it wrote: callers first ask {@link dirty} and leave out files that
 * already had uncommitted changes, so a user's pending edits never end up in a
 * `penforge(token-sync)` commit.
 */
export class PathCommit {
    private static readonly MAX_SUBJECT = 72;

    /**
     * @param dir - the repository folder, already checked against the project folder
     */
    constructor(private readonly dir: string) {}

    /** Tells whether the folder is a git repository. */
    public get isRepository(): boolean {
        return existsSync(join(this.dir, ".git"));
    }

    /**
     * Lists the files with uncommitted changes (staged or not, or untracked).
     *
     * @param files - paths relative to the repository, forward slashes
     */
    public async dirty(files: string[]): Promise<Set<string>> {
        if (files.length === 0 || !this.isRepository) {
            return new Set();
        }
        const out = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...files]);
        const dirty = new Set<string>();
        const entries = out.split("\0");
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (entry.length < 4) {
                continue;
            }
            dirty.add(entry.slice(3));
            if (entry[0] === "R" || entry[0] === "C") {
                // a rename or copy is followed by its source path
                index++;
            }
        }
        return dirty;
    }

    /**
     * Commits files when they changed.
     *
     * @param files - paths relative to the repository, forward slashes
     * @param subject - commit subject
     * @returns the commit hash, or null when nothing changed (or no repository)
     */
    public async commit(files: string[], subject: string): Promise<string | null> {
        const paths = [...new Set(files)];
        if (paths.length === 0 || !this.isRepository) {
            return null;
        }
        await this.git(["add", "-A", "--", ...paths]);
        const staged = await this.git(["diff", "--cached", "--name-only", "--", ...paths]);
        if (staged.trim().length === 0) {
            return null;
        }
        const message =
            subject.length > PathCommit.MAX_SUBJECT ? `${subject.slice(0, PathCommit.MAX_SUBJECT - 1)}…` : subject;
        await this.git([...(await this.identityArgs()), "commit", "-q", "-m", message, "--", ...paths]);
        return (await this.git(["rev-parse", "HEAD"])).trim();
    }

    private async identityArgs(): Promise<string[]> {
        const configured = await this.git(["config", "user.email"])
            .then((email) => email.trim().length > 0)
            .catch(() => false);
        return configured ? [] : ["-c", "user.name=Penforge", "-c", "user.email=penforge@localhost"];
    }

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", ["--literal-pathspecs", "-c", "core.quotepath=off", ...args], {
            cwd: this.dir,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    }
}
