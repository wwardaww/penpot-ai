import { execFile } from "child_process";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
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

/**
 * DESIGN.md (and its `tokens.json` export) in the project's `design/` git repository.
 *
 * Reads and writes the files, lists the commits that touched DESIGN.md and reads old versions.
 * Commits go through the workspace (`commitAll`), with messages `penforge(design-md): …`.
 */
export class DesignMdRepository {
    /** file name of the design system description */
    public static readonly FILE_NAME = "DESIGN.md";

    /** file name of the W3C design tokens export */
    public static readonly TOKENS_FILE_NAME = "tokens.json";

    /** commit message prefix */
    public static readonly COMMIT_PREFIX = "penforge(design-md): ";

    private static readonly COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
    private static readonly MAX_SUBJECT = 72;

    /**
     * @param workspace - the project workspace
     */
    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /** Absolute path of DESIGN.md. */
    public get path(): string {
        return this.workspace.resolve(join(this.workspace.designDir, DesignMdRepository.FILE_NAME));
    }

    /**
     * Reads DESIGN.md.
     *
     * @returns the text, or null if the file does not exist
     */
    public async read(): Promise<string | null> {
        try {
            return await readFile(this.path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw error;
        }
    }

    /**
     * Writes DESIGN.md and, when given, `tokens.json`.
     *
     * @param text - the DESIGN.md text
     * @param tokensJson - the tokens export, or undefined to leave it as it is
     */
    public async write(text: string, tokensJson?: unknown): Promise<void> {
        await mkdir(this.workspace.designDir, { recursive: true });
        await DesignMdRepository.writeAtomic(this.path, text);
        if (tokensJson !== undefined) {
            const tokensPath = this.workspace.resolve(
                join(this.workspace.designDir, DesignMdRepository.TOKENS_FILE_NAME)
            );
            await DesignMdRepository.writeAtomic(tokensPath, JSON.stringify(tokensJson, null, 2) + "\n");
        }
    }

    /**
     * Commits the design repository.
     *
     * @param summary - what changed, without the prefix
     * @returns the commit hash, or null when nothing changed
     */
    public commit(summary: string): Promise<string | null> {
        const oneLine = summary.replace(/\s+/g, " ").trim();
        const subject =
            oneLine.length > DesignMdRepository.MAX_SUBJECT
                ? `${oneLine.slice(0, DesignMdRepository.MAX_SUBJECT - 1)}…`
                : oneLine;
        return this.workspace.commitAll("design", `${DesignMdRepository.COMMIT_PREFIX}${subject || "update"}`);
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
            return await this.git(["show", `${commit}:${DesignMdRepository.FILE_NAME}`]);
        } catch {
            return null;
        }
    }

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, {
            cwd: this.workspace.designDir,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    }

    private static async writeAtomic(path: string, content: string): Promise<void> {
        const temp = `${path}.tmp-${randomUUID()}`;
        await writeFile(temp, content, "utf8");
        await rename(temp, path);
    }
}
