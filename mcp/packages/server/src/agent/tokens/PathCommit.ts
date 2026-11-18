import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Commit of given files of one project repository (`design/` or `app-src/`), leaving every other
 * change of the working tree alone (`git commit --only` semantics through a pathspec).
 *
 * A sync commits only what it wrote, so edits the user or another workflow has pending in the
 * same repository are never swept into a `penforge(token-sync)` commit.
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
        const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=off", ...args], {
            cwd: this.dir,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    }
}
