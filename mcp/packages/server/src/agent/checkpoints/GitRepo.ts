import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Diff of a repository against a checkpoint commit. */
export interface RepoDiff {
    /** `git diff --stat` output */
    stat: string;
    /** unified diff, cut at {@link GitRepo.MAX_PATCH_CHARS} */
    patch: string;
    /** true when the patch was cut */
    truncated: boolean;
    /** files git does not track yet (not part of the patch) */
    untracked: string[];
}

/**
 * The few git commands checkpoints need, on one repository of a project (`design/`, `app-src/`).
 */
export class GitRepo {
    /** Longest patch handed to clients. */
    public static readonly MAX_PATCH_CHARS = 200_000;

    private static readonly SHA_PATTERN = /^[0-9a-f]{40}$/;
    private static readonly TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

    /**
     * @param dir - the repository folder, already checked against the project folder
     */
    constructor(public readonly dir: string) {}

    /** Gets the commit of `HEAD`. */
    public async head(): Promise<string> {
        return (await this.git(["rev-parse", "HEAD"])).trim();
    }

    /**
     * Points a lightweight tag at a commit, replacing a tag of the same name.
     *
     * @param name - the tag name
     * @param sha - the commit
     */
    public async tag(name: string, sha: string): Promise<void> {
        if (!GitRepo.TAG_PATTERN.test(name)) {
            throw new Error(`Invalid tag name ${JSON.stringify(name)}`);
        }
        await this.git(["tag", "-f", name, GitRepo.checkSha(sha)]);
    }

    /**
     * Tells whether the repository holds a commit.
     *
     * @param sha - the commit
     */
    public async hasCommit(sha: string): Promise<boolean> {
        if (!GitRepo.SHA_PATTERN.test(sha)) {
            return false;
        }
        return this.git(["cat-file", "-e", `${sha}^{commit}`])
            .then(() => true)
            .catch(() => false);
    }

    /**
     * Moves the current branch to a commit and makes the files match it (`git reset --hard`).
     * Files git ignores stay as they are.
     *
     * @param sha - the commit
     */
    public async resetHard(sha: string): Promise<void> {
        await this.git(["reset", "-q", "--hard", GitRepo.checkSha(sha)]);
    }

    /**
     * Diffs the working tree against a commit.
     *
     * @param sha - the commit
     */
    public async diff(sha: string): Promise<RepoDiff> {
        const base = GitRepo.checkSha(sha);
        const stat = await this.git(["diff", "--stat", base, "--"]);
        const patch = await this.git(["diff", base, "--"]);
        const untracked = (await this.git(["ls-files", "--others", "--exclude-standard"]))
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        const truncated = patch.length > GitRepo.MAX_PATCH_CHARS;
        return {
            stat: stat.trimEnd(),
            patch: truncated ? patch.slice(0, GitRepo.MAX_PATCH_CHARS) : patch,
            truncated,
            untracked,
        };
    }

    private static checkSha(sha: string): string {
        if (!GitRepo.SHA_PATTERN.test(sha)) {
            throw new Error(`Invalid commit ${JSON.stringify(sha)}`);
        }
        return sha;
    }

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, {
            cwd: this.dir,
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024,
        });
        return stdout;
    }
}
