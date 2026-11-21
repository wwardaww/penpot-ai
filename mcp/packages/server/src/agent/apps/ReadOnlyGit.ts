import { execFile } from "child_process";
import { promisify } from "util";
import { LinkedGit } from "../linked/LinkedGit";

const execFileAsync = promisify(execFile);

/**
 * Git reads of a linked folder for the dashboard (W39): the checked-out branch, a branch head and
 * the files a Re-Design branch changed.
 *
 * Runs only commands that change nothing (`rev-parse`, `symbolic-ref`, `diff` between two commits),
 * with optional locks off (`GIT_OPTIONAL_LOCKS=0`), so it never touches the index or another
 * process's git work. Never switches branches.
 */
export class ReadOnlyGit {
    private static readonly COMMIT = /^[0-9a-f]{7,64}$/;
    private static readonly BRANCH = /^[A-Za-z0-9/_.-]+$/;
    private static readonly MAX_PATHS = 5000;

    /**
     * @param root - the linked folder
     */
    constructor(public readonly root: string) {}

    /** Gets the checked-out branch, or null when detached or not a repository. */
    public async currentBranch(): Promise<string | null> {
        return this.git(["symbolic-ref", "--short", "-q", "HEAD"])
            .then((out) => out.trim() || null)
            .catch(() => null);
    }

    /**
     * Gets the head commit of a Penforge branch.
     *
     * @param branch - the branch name (must start with {@link LinkedGit.BRANCH_PREFIX})
     * @returns the commit hash, or null when the branch does not exist
     */
    public async branchHead(branch: string): Promise<string | null> {
        if (!ReadOnlyGit.isPenforgeBranch(branch)) {
            return null;
        }
        return this.git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`])
            .then((out) => out.trim() || null)
            .catch(() => null);
    }

    /**
     * Lists the files changed between two commits inside the folder (at most 5000), relative to
     * the folder and `/`-separated. Files outside it (the folder may sit inside a bigger
     * repository) are left out.
     *
     * @param base - the base commit hash
     * @param head - the head commit hash
     */
    public async changedPaths(base: string, head: string): Promise<string[]> {
        if (!ReadOnlyGit.COMMIT.test(base) || !ReadOnlyGit.COMMIT.test(head)) {
            return [];
        }
        // git names the files relative to the repository root; the prefix ends with "/"
        const prefix = await this.git(["rev-parse", "--show-prefix"])
            .then((out) => out.trim())
            .catch(() => "");
        const out = await this.git(["diff", "--name-only", "--no-renames", "-z", `${base}..${head}`]).catch(() => "");
        return out
            .split("\0")
            .filter((path) => path.length > prefix.length && path.startsWith(prefix))
            .map((path) => path.slice(prefix.length))
            .slice(0, ReadOnlyGit.MAX_PATHS);
    }

    /**
     * Tells whether a name is a branch Penforge creates.
     *
     * @param branch - the name
     */
    public static isPenforgeBranch(branch: unknown): branch is string {
        return (
            typeof branch === "string" &&
            branch.startsWith(LinkedGit.BRANCH_PREFIX) &&
            ReadOnlyGit.BRANCH.test(branch) &&
            !branch.includes("..")
        );
    }

    /**
     * Tells whether a value is a full or abbreviated commit hash.
     *
     * @param value - the value
     */
    public static isCommit(value: unknown): value is string {
        return typeof value === "string" && ReadOnlyGit.COMMIT.test(value);
    }

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, {
            cwd: this.root,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        });
        return stdout;
    }
}
