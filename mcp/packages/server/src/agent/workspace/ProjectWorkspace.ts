import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import type { ProjectRepo, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { PathGuard } from "./pathGuard";

const execFileAsync = promisify(execFile);

/**
 * Folder of one Penpot project on disk (`<PENFORGE_HOME>/projects/<project-id>/`).
 *
 * Holds two git repositories, `design/` and `app-src/`, and the daemon's metadata folder
 * `.penforge/`. Every path handed out is checked by a {@link PathGuard} on the project root.
 */
export class ProjectWorkspace implements WorkflowWorkspaceApi {
    /** Pattern of acceptable project ids (Penpot uses UUIDs). */
    public static readonly ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

    /** Pattern of acceptable metadata file names below `.penforge/`. */
    private static readonly META_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

    public readonly root: string;
    public readonly designDir: string;
    public readonly appSrcDir: string;
    public readonly metaDir: string;
    public readonly guard: PathGuard;

    /**
     * Creates the workspace object; call {@link ensure} before use.
     *
     * @param projectsDir - folder holding all project folders
     * @param projectId - the Penpot project id
     */
    constructor(
        projectsDir: string,
        public readonly projectId: string
    ) {
        if (!ProjectWorkspace.ID_PATTERN.test(projectId)) {
            throw new Error(`Invalid project id ${JSON.stringify(projectId)}`);
        }
        this.root = join(projectsDir, projectId);
        this.designDir = join(this.root, "design");
        this.appSrcDir = join(this.root, "app-src");
        this.metaDir = join(this.root, ".penforge");
        this.guard = new PathGuard(this.root);
    }

    /**
     * Creates the folders and git repositories that do not exist yet.
     */
    public async ensure(): Promise<void> {
        await mkdir(join(this.metaDir, "chat"), { recursive: true });
        for (const repo of ["design", "app-src"] as ProjectRepo[]) {
            await this.ensureRepo(repo);
        }
    }

    public resolve(candidate: string): string {
        return this.guard.resolve(candidate);
    }

    /**
     * Gets the folder of a repository.
     *
     * @param repo - the repository
     */
    public repoDir(repo: ProjectRepo): string {
        switch (repo) {
            case "design":
                return this.designDir;
            case "app-src":
                return this.appSrcDir;
            default:
                throw new Error(`Unknown repo ${JSON.stringify(repo)}`);
        }
    }

    public async commitAll(repo: ProjectRepo, message: string): Promise<string | null> {
        const dir = this.repoDir(repo);
        await this.git(dir, ["add", "-A"]);
        const status = await this.git(dir, ["status", "--porcelain"]);
        if (status.trim().length === 0) {
            return null;
        }
        await this.git(dir, [...(await this.identityArgs(dir)), "commit", "-q", "-m", message]);
        return (await this.git(dir, ["rev-parse", "HEAD"])).trim();
    }

    public async readJson<T>(name: string, fallback: T): Promise<T> {
        const file = this.metaPath(name);
        let content: string;
        try {
            content = await readFile(file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return fallback;
            }
            throw error;
        }
        return JSON.parse(content) as T;
    }

    public async writeJson(name: string, value: unknown): Promise<void> {
        const file = this.metaPath(name);
        await mkdir(join(file, ".."), { recursive: true });
        // write to a sibling first, so readers never see a partial file
        const temp = `${file}.tmp-${randomUUID()}`;
        await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
        await rename(temp, file);
    }

    /**
     * Resolves a metadata file name below `.penforge/`.
     *
     * @param name - a relative name such as `project.json` or `chat/<id>.jsonl`
     */
    public metaPath(name: string): string {
        if (!ProjectWorkspace.META_NAME_PATTERN.test(name)) {
            throw new Error(`Invalid metadata file name ${JSON.stringify(name)}`);
        }
        return this.guard.resolve(join(this.metaDir, ...name.split("/")));
    }

    private async ensureRepo(repo: ProjectRepo): Promise<void> {
        const dir = this.repoDir(repo);
        await mkdir(dir, { recursive: true });
        const isRepo = await this.git(dir, ["rev-parse", "--show-toplevel"])
            .then((top) => this.guard.resolve(top.trim()) === this.guard.resolve(dir))
            .catch(() => false);
        if (isRepo) {
            return;
        }
        await this.git(dir, ["init", "-q", "-b", "main"]);
        await this.git(dir, [
            ...(await this.identityArgs(dir)),
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            `penforge(init): create ${repo} repository`,
        ]);
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
