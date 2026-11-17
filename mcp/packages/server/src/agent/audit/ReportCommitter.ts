import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Commits one file of a git repository, leaving every other change (staged or not) alone.
 *
 * Used for audit reports, so the user's own uncommitted work in `design/` (DESIGN.md edits,
 * temporary files) never ends up in a `penforge(audit)` commit.
 */
export class ReportCommitter {
    /**
     * Stages and commits a single file.
     *
     * @param repoDir - the repository folder
     * @param file - path of the file relative to `repoDir`
     * @param message - the commit message
     * @returns the commit hash, or null when the file has no change to commit
     * @throws Error when `repoDir` is not a git repository or git fails
     */
    public async commitFile(repoDir: string, file: string, message: string): Promise<string | null> {
        await this.git(repoDir, ["add", "--", file]);
        const status = await this.git(repoDir, ["status", "--porcelain", "--", file]);
        if (status.trim().length === 0) {
            return null;
        }
        // --only: commit this path only, even if the user staged other changes
        await this.git(repoDir, [
            ...(await this.identityArgs(repoDir)),
            "commit",
            "-q",
            "--only",
            "-m",
            message,
            "--",
            file,
        ]);
        return (await this.git(repoDir, ["rev-parse", "HEAD"])).trim();
    }

    /**
     * Gets git arguments that supply a committer identity when none is configured.
     */
    private async identityArgs(dir: string): Promise<string[]> {
        const configured = await this.git(dir, ["config", "user.email"])
            .then((email) => email.trim().length > 0)
            .catch(() => false);
        return configured ? [] : ["-c", "user.name=Penforge", "-c", "user.email=penforge@localhost"];
    }

    private async git(cwd: string, args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        return stdout;
    }
}
