import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";

const execFileAsync = promisify(execFile);

/** One commit that changed DESIGN.md. */
export interface DesignMdHistoryEntry {
    commit: string;
    /** ISO 8601 author date */
    date: string;
    subject: string;
}

/** State of DESIGN.md on disk right before a workflow writes it. */
export interface DesignMdWriteCheck {
    /** the file differs from the version the caller based its change on */
    conflict: boolean;
    /** the file on disk (line endings normalized), or null if there is none */
    current: string | null;
    /** hash of `current`, or null */
    currentHash: string | null;
    /** commit that recorded edits made outside Penforge, or null */
    externalCommit: string | null;
}

/**
 * DESIGN.md (and its `tokens.json` export) in the project's `design/` git repository.
 *
 * Reads and writes the two files, commits only them (other workflows own other files of the
 * repository), records edits made outside Penforge before overwriting them, detects that the file
 * changed since a caller read it, lists the commits that touched DESIGN.md and reads old versions.
 * Commit messages are `penforge(design-md): …`.
 */
export class DesignMdRepository {
    /** file name of the design system description */
    public static readonly FILE_NAME = "DESIGN.md";

    /** file name of the W3C design tokens export */
    public static readonly TOKENS_FILE_NAME = "tokens.json";

    /** commit message prefix */
    public static readonly COMMIT_PREFIX = "penforge(design-md): ";

    /** commit summary for edits found on disk that Penforge did not make */
    public static readonly EXTERNAL_EDIT_SUMMARY = "keep edit made outside Penforge";

    private static readonly COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
    private static readonly MAX_SUBJECT = 72;
    private static readonly RENAME_ATTEMPTS = 8;
    private static readonly RENAME_DELAY_MS = 40;

    /**
     * @param workspace - the project workspace
     */
    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /**
     * Hashes DESIGN.md text (line endings normalized), so that callers can tell versions apart.
     */
    public static hash(text: string): string {
        return createHash("sha256").update(DesignMdRepository.normalize(text), "utf8").digest("hex");
    }

    /** Normalizes line endings to `\n`. */
    public static normalize(text: string): string {
        return text.replace(/\r\n?/g, "\n");
    }

    /** Absolute path of DESIGN.md. */
    public get path(): string {
        return this.filePath(DesignMdRepository.FILE_NAME);
    }

    /**
     * Reads DESIGN.md with normalized line endings.
     *
     * @returns the text, or null if the file does not exist
     */
    public async read(): Promise<string | null> {
        try {
            return DesignMdRepository.normalize(await readFile(this.path, "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw error;
        }
    }

    /**
     * Prepares a write: commits edits made outside Penforge, then compares the file with the
     * version the caller based its change on.
     *
     * @param base - hash of the version the caller read (`null`: the caller saw no file;
     *   `undefined`: do not check)
     */
    public async prepareWrite(base?: string | null): Promise<DesignMdWriteCheck> {
        const externalCommit = await this.commitExternalEdits();
        const current = await this.read();
        const currentHash = current === null ? null : DesignMdRepository.hash(current);
        const conflict = base !== undefined && base !== currentHash;
        return { conflict, current, currentHash, externalCommit };
    }

    /**
     * Writes DESIGN.md and, when given, `tokens.json`.
     *
     * @param text - the DESIGN.md text
     * @param tokensJson - the tokens export, or undefined to leave it as it is
     */
    public async write(text: string, tokensJson?: unknown): Promise<void> {
        await mkdir(this.workspace.designDir, { recursive: true });
        await this.writeAtomic(this.path, DesignMdRepository.normalize(text));
        if (tokensJson !== undefined) {
            await this.writeAtomic(
                this.filePath(DesignMdRepository.TOKENS_FILE_NAME),
                JSON.stringify(tokensJson, null, 2) + "\n"
            );
        }
    }

    /**
     * Commits DESIGN.md and `tokens.json` (and nothing else of the repository).
     *
     * @param summary - what changed, without the prefix
     * @returns the commit hash, or null when nothing changed
     */
    public async commit(summary: string): Promise<string | null> {
        const oneLine = summary.replace(/\s+/g, " ").trim();
        const subject =
            oneLine.length > DesignMdRepository.MAX_SUBJECT
                ? `${oneLine.slice(0, DesignMdRepository.MAX_SUBJECT - 1)}…`
                : oneLine;
        const files = await this.ownFiles();
        if (files.length === 0) {
            return null;
        }
        await this.git(["add", "-A", "--", ...files]);
        const staged = await this.git(["diff", "--cached", "--name-only", "--", ...files]);
        if (staged.trim().length === 0) {
            return null;
        }
        await this.git([
            ...(await this.identityArgs()),
            "commit",
            "-q",
            "-m",
            `${DesignMdRepository.COMMIT_PREFIX}${subject || "update"}`,
            "--",
            ...files,
        ]);
        return (await this.git(["rev-parse", "HEAD"])).trim();
    }

    /**
     * Commits DESIGN.md / `tokens.json` edits found on disk (an IDE, another tool), so that a
     * following write never loses them.
     *
     * @returns the commit hash, or null when the files were clean
     */
    public async commitExternalEdits(): Promise<string | null> {
        const files = await this.ownFiles();
        if (files.length === 0) {
            return null;
        }
        const status = await this.git(["status", "--porcelain", "--", ...files]);
        return status.trim().length === 0 ? null : this.commit(DesignMdRepository.EXTERNAL_EDIT_SUMMARY);
    }

    /**
     * Lists the commits that changed DESIGN.md, newest first.
     *
     * @param limit - maximum number of entries
     */
    public async history(limit: number = 50): Promise<DesignMdHistoryEntry[]> {
        let output: string;
        try {
            output = await this.git([
                "log",
                `--max-count=${Math.max(1, Math.floor(limit))}`,
                "--format=%H%x1f%aI%x1f%s",
                "--",
                DesignMdRepository.FILE_NAME,
            ]);
        } catch {
            // no commits yet, or not a repository
            return [];
        }
        return output
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => {
                const [commit, date, subject] = line.split("\x1f");
                return { commit, date, subject: subject ?? "" };
            });
    }

    /**
     * Reads DESIGN.md as it was in a commit.
     *
     * @param commit - a commit hash (7 to 40 hex digits)
     * @returns the text, or null if the commit has no DESIGN.md
     */
    public async readAt(commit: string): Promise<string | null> {
        if (!DesignMdRepository.COMMIT_PATTERN.test(commit)) {
            throw new Error("Invalid commit");
        }
        try {
            return DesignMdRepository.normalize(await this.git(["show", `${commit}:${DesignMdRepository.FILE_NAME}`]));
        } catch {
            return null;
        }
    }

    private filePath(name: string): string {
        return this.workspace.resolve(join(this.workspace.designDir, name));
    }

    /** Own files that exist on disk or are tracked (so deletions get committed too). */
    private async ownFiles(): Promise<string[]> {
        const names = [DesignMdRepository.FILE_NAME, DesignMdRepository.TOKENS_FILE_NAME];
        const tracked = await this.git(["ls-files", "--", ...names]).catch(() => "");
        const trackedNames = new Set(tracked.split("\n").map((line) => line.trim()));
        return names.filter((name) => trackedNames.has(name) || existsSync(this.filePath(name)));
    }

    /**
     * Writes a file through a temporary file outside the repository (`.penforge/tmp/`), so that
     * readers never see a partial file and git never sees temporary files. Retries the rename
     * while Windows reports the target as locked.
     */
    private async writeAtomic(path: string, content: string): Promise<void> {
        const tempDir = this.workspace.resolve(join(this.workspace.metaDir, "tmp"));
        await mkdir(tempDir, { recursive: true });
        const temp = join(tempDir, `design-md-${randomUUID()}.tmp`);
        await writeFile(temp, content, "utf8");
        try {
            for (let attempt = 1; ; attempt++) {
                try {
                    await rename(temp, path);
                    return;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    const locked = code === "EPERM" || code === "EACCES" || code === "EBUSY";
                    if (!locked || attempt >= DesignMdRepository.RENAME_ATTEMPTS) {
                        throw error;
                    }
                    await new Promise((resolve) => setTimeout(resolve, DesignMdRepository.RENAME_DELAY_MS * attempt));
                }
            }
        } catch (error) {
            await unlink(temp).catch(() => {});
            throw error;
        }
    }

    /** Git arguments that supply a committer identity when none is configured. */
    private async identityArgs(): Promise<string[]> {
        const configured = await this.git(["config", "user.email"])
            .then((email) => email.trim().length > 0)
            .catch(() => false);
        return configured ? [] : ["-c", "user.name=Penforge", "-c", "user.email=penforge@localhost"];
    }

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, {
            cwd: this.workspace.designDir,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    }
}
