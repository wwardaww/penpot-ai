import { execFile } from "child_process";
import { appendFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** One changed file between two commits. */
export interface ChangedFile {
    path: string;
    /** git status letter: A added, M modified, D deleted, R renamed, … */
    status: string;
}

/** Git state of a linked folder. */
export interface LinkedGitState {
    git: boolean;
    /** current branch, null when detached or no repository */
    branch: string | null;
    head: string | null;
    dirty: boolean;
}

/**
 * Git operations of the W38 Re-Design workflows in a linked folder (the user's own repository).
 *
 * Never pushes, never changes remotes or config, never commits to a branch it did not create
 * (except the very first commit of a repository it created on the user's yes). Runs `git` with
 * an argument vector, no shell; commits fall back to a Penforge identity when none is configured.
 */
export class LinkedGit {
    /** prefix of the branches Penforge creates */
    public static readonly BRANCH_PREFIX = "penforge/redesign-";

    /** folders kept out of a repository Penforge creates (`.git/info/exclude`, the user's files untouched) */
    private static readonly EXCLUDES = [
        "node_modules/",
        "vendor/",
        "Pods/",
        ".gradle/",
        "build/",
        "dist/",
        ".next/",
        "target/",
        ".venv/",
        "venv/",
        "__pycache__/",
        "coverage/",
        "Library/",
        "Temp/",
        "Logs/",
        "obj/",
        "Builds/",
        "UserSettings/",
        "Binaries/",
        "Intermediate/",
        "Saved/",
        "DerivedDataCache/",
        "*.log",
    ];

    /**
     * @param root - the linked folder
     */
    constructor(public readonly root: string) {}

    /**
     * Gets the branch name for a new Re-Design run, from the local time.
     *
     * @param now - the time
     */
    public static branchName(now: Date = new Date()): string {
        const pad = (value: number) => String(value).padStart(2, "0");
        return (
            `${LinkedGit.BRANCH_PREFIX}${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
            `-${pad(now.getHours())}${pad(now.getMinutes())}`
        );
    }

    /** Reads whether the folder is in a repository, its branch, head and uncommitted changes. */
    public async state(): Promise<LinkedGitState> {
        const inside = await this.git(["rev-parse", "--is-inside-work-tree"])
            .then((out) => out.trim() === "true")
            .catch(() => false);
        if (!inside) {
            return { git: false, branch: null, head: null, dirty: false };
        }
        const branch = await this.git(["symbolic-ref", "--short", "-q", "HEAD"])
            .then((out) => out.trim() || null)
            .catch(() => null);
        const head = await this.git(["rev-parse", "--verify", "-q", "HEAD"])
            .then((out) => out.trim() || null)
            .catch(() => null);
        const status = await this.git(["status", "--porcelain", "--untracked-files=normal"]);
        return { git: true, branch, head, dirty: status.trim().length > 0 };
    }

    /** Tells whether a local branch exists. */
    public async branchExists(name: string): Promise<boolean> {
        LinkedGit.checkBranch(name);
        return this.git(["rev-parse", "--verify", "-q", `refs/heads/${name}`])
            .then(() => true)
            .catch(() => false);
    }

    /**
     * Creates a repository, keeps dependency and engine folders out of it through
     * `.git/info/exclude`, and records the current files in a first commit (an empty one with
     * `empty`), so the Re-Design branch has a base.
     *
     * @param empty - commit nothing (Game UI: only `PenforgeUI/` is added later)
     */
    public async init(empty: boolean): Promise<void> {
        await this.git(["init", "-q"]);
        const infoDir = join(this.root, ".git", "info");
        await mkdir(infoDir, { recursive: true });
        const exclude = join(infoDir, "exclude");
        const current = await readFile(exclude, "utf8").catch(() => "");
        await appendFile(
            exclude,
            `${current.endsWith("\n") || current === "" ? "" : "\n"}# Penforge\n${LinkedGit.EXCLUDES.join("\n")}\n`
        );
        if (!empty) {
            await this.git(["add", "-A"]);
        }
        await this.commit("penforge(redesign): snapshot before Re-Design", true);
    }

    /** Stashes uncommitted changes, untracked files included. */
    public async stash(): Promise<void> {
        await this.git(["stash", "push", "-u", "-m", "penforge: before Re-Design"]);
    }

    /**
     * Creates a branch at the current commit and switches to it; uncommitted changes go along.
     *
     * @param name - the branch name (must start with {@link BRANCH_PREFIX})
     */
    public async createBranch(name: string): Promise<void> {
        LinkedGit.checkBranch(name);
        await this.git(["switch", "-c", name]);
    }

    /** Switches to an existing Penforge branch. */
    public async switchTo(name: string): Promise<void> {
        LinkedGit.checkBranch(name);
        await this.git(["switch", name]);
    }

    /**
     * Stages and commits changes on the current branch, which must be a Penforge branch (or the
     * first commit of a repository Penforge created).
     *
     * @param message - the commit message
     * @param allowEmpty - commit even without a change
     * @param paths - only these paths (pathspecs relative to the folder); all changes when omitted
     * @returns the commit hash, or null when there was nothing to commit
     */
    public async commit(message: string, allowEmpty = false, paths?: string[]): Promise<string | null> {
        const branch = await this.git(["symbolic-ref", "--short", "-q", "HEAD"])
            .then((out) => out.trim())
            .catch(() => "");
        const hasHead = await this.git(["rev-parse", "--verify", "-q", "HEAD"])
            .then(() => true)
            .catch(() => false);
        if (hasHead && !branch.startsWith(LinkedGit.BRANCH_PREFIX)) {
            throw new Error(`Refusing to commit to ${branch || "a detached HEAD"}: not a Penforge branch`);
        }
        await this.git(paths ? ["add", "-A", "--", ...paths] : ["add", "-A"]);
        const staged = await this.git(["diff", "--cached", "--name-only"]);
        if (staged.trim().length === 0 && !allowEmpty) {
            return null;
        }
        await this.git([
            ...(await this.identityArgs()),
            "commit",
            "-q",
            ...(allowEmpty ? ["--allow-empty"] : []),
            "-m",
            message,
        ]);
        return (await this.git(["rev-parse", "HEAD"])).trim();
    }

    /**
     * Lists the files changed between a commit and the current head.
     *
     * @param base - the base commit
     */
    public async changedFiles(base: string): Promise<ChangedFile[]> {
        const out = await this.git(["diff", "--name-status", "--no-renames", "-z", `${base}..HEAD`]);
        const parts = out.split("\0").filter((part) => part.length > 0);
        const files: ChangedFile[] = [];
        for (let i = 0; i + 1 < parts.length; i += 2) {
            files.push({ status: parts[i], path: parts[i + 1] });
        }
        return files;
    }

    /**
     * Gets the lines a file gained between a commit and the head (at most 200 KB of diff).
     *
     * @param base - the base commit
     * @param path - the file
     */
    public async addedLines(base: string, path: string): Promise<string[]> {
        const diff = await this.git(["diff", "--no-color", "-U0", `${base}..HEAD`, "--", path]);
        return diff
            .slice(0, 200 * 1024)
            .split("\n")
            .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
            .map((line) => line.slice(1));
    }

    /**
     * Puts files back to their state at a commit (deletes the ones it did not have) and commits.
     *
     * @param base - the base commit
     * @param paths - files relative to the folder
     * @returns the commit hash, or null when nothing changed
     */
    public async revert(base: string, paths: string[]): Promise<string | null> {
        for (const path of paths) {
            const existed = await this.git(["cat-file", "-e", `${base}:${path}`])
                .then(() => true)
                .catch(() => false);
            if (existed) {
                await this.git(["checkout", base, "--", path]);
            } else {
                await this.git(["rm", "-q", "-f", "--ignore-unmatch", "--", path]);
            }
        }
        return this.commit(`penforge(redesign): revert ${paths.length} change(s) outside the look`, false, paths);
    }

    private static checkBranch(name: string): void {
        if (!name.startsWith(LinkedGit.BRANCH_PREFIX) || !/^[A-Za-z0-9/_.-]+$/.test(name) || name.includes("..")) {
            throw new Error(`Not a Penforge branch name: ${name}`);
        }
    }

    private async identityArgs(): Promise<string[]> {
        const configured = await this.git(["config", "user.email"])
            .then((email) => email.trim().length > 0)
            .catch(() => false);
        return configured ? [] : ["-c", "user.name=Penforge", "-c", "user.email=penforge@localhost"];
    }

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, {
            cwd: this.root,
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        return stdout;
    }
}
