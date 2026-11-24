import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { statSync } from "fs";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import type { ProjectRepo, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import type { ProjectLink, ProjectLinkFields } from "../linked/ProjectLink";
import { ProjectLinkRecord } from "../linked/ProjectLink";
import { AppFolder } from "./AppFolder";
import { ProjectPathGuard } from "./pathGuard";
import { type ProjectOutput, type ProjectOutputFields, ProjectOutputRecord } from "./ProjectOutput";
import { renameWithRetry } from "./renameWithRetry";

const execFileAsync = promisify(execFile);

/**
 * Folder of one Penpot project on disk (`<PENFORGE_HOME>/projects/<project-id>/`).
 *
 * Holds two git repositories, `design/` and `app-src/`, and the daemon's metadata folder
 * `.penforge/`. The app of a web or mobile project may be in a folder the user picked instead of
 * `app-src/` (W41, {@link appSrcDir}). Every path handed out is checked by a
 * {@link ProjectPathGuard} on the project root, that app folder and, for a Game UI or Existing
 * project (W38), the linked folder of this computer.
 */
export class ProjectWorkspace implements WorkflowWorkspaceApi {
    /** Pattern of acceptable project ids (Penpot uses UUIDs). */
    public static readonly ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

    /** Pattern of acceptable metadata file names below `.penforge/`. */
    private static readonly META_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

    public readonly root: string;
    public readonly designDir: string;
    /** `app-src/` in the project folder; the app's folder for projects built there */
    public readonly internalAppDir: string;
    public readonly metaDir: string;
    public readonly guard: ProjectPathGuard;
    /** link to a folder of this computer (W38), from `project.json` */
    private link: ProjectLink | null = null;
    /** output folder the user picked (W41), from `project.json` */
    private output: ProjectOutput | null = null;
    /** Pending atomic writes per metadata file, so writes to one file never overlap. */
    private readonly writeQueues = new Map<string, Promise<void>>();

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
        this.internalAppDir = join(this.root, "app-src");
        this.metaDir = join(this.root, ".penforge");
        this.guard = new ProjectPathGuard(this.root);
    }

    /**
     * Creates the folders and git repositories that do not exist yet.
     */
    public async ensure(): Promise<void> {
        await mkdir(join(this.metaDir, "chat"), { recursive: true });
        const info = await this.readJson<(ProjectLinkFields & ProjectOutputFields) | null>("project.json", null);
        this.setOutput(ProjectOutputRecord.read(info));
        await this.ensureRepo(this.designDir, "design");
        // the app folder the user picked is created by the pick only, never here
        if (this.appSrcDir === this.internalAppDir) {
            await this.ensureRepo(this.internalAppDir, "app-src");
        }
        this.setLink(ProjectLinkRecord.read(info));
    }

    /**
     * Folder of the generated app: the folder the user picked (W41), else `app-src/` in the project
     * folder. A picked folder that went away stays the answer, so nothing is written elsewhere.
     */
    public get appSrcDir(): string {
        return this.output?.appRoot ?? this.internalAppDir;
    }

    /** The output folder the user picked (W41), or null. */
    public get outputFolder(): ProjectOutput | null {
        return this.output;
    }

    /** The app folder outside the project folder while it is the one Penforge made, else null. */
    public get appRoot(): string | null {
        return this.guard.appRoot;
    }

    /**
     * Sets the project's output folder. The guard accepts the app folder only while it is the one
     * Penforge made for this project ({@link AppFolder.isOwn}); call again to check a folder that
     * came back or went away.
     *
     * @param output - the output folder, or null for none
     */
    public setOutput(output: ProjectOutput | null): void {
        this.output = output;
        const appRoot = output?.appRoot ?? null;
        if (appRoot !== null) {
            AppFolder.protectParents(appRoot);
        }
        this.guard.setAppRoot(appRoot !== null && AppFolder.isOwn(appRoot, this.projectId) ? appRoot : null);
    }

    /** The project's link to a folder of this computer (W38), or null. */
    public get linked(): ProjectLink | null {
        return this.link;
    }

    /** The linked folder when it exists on this computer, else null. */
    public get linkedRoot(): string | null {
        return this.guard.linkedRoot;
    }

    /**
     * Sets the project's link. The guard accepts the linked folder only while it exists as a
     * folder; call again to check a folder that came back or went away.
     *
     * @param link - the link, or null to remove it
     */
    public setLink(link: ProjectLink | null): void {
        this.link = link;
        this.guard.setLinkedRoot(link !== null && ProjectWorkspace.isDirectory(link.root) ? link.root : null);
    }

    /**
     * Resolves a path inside the linked folder; a relative path is taken relative to it.
     *
     * @param candidate - the path
     * @throws if the project has no linked folder or the path is outside it
     */
    public resolveLinked(candidate: string): string {
        return this.guard.resolveLinked(candidate);
    }

    private static isDirectory(path: string): boolean {
        try {
            return statSync(path).isDirectory();
        } catch {
            return false;
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
        if (dir === this.output?.appRoot && !AppFolder.isOwn(dir, this.projectId)) {
            throw new Error(`The app folder ${JSON.stringify(dir)} is missing or not the one Penforge made`);
        }
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

    /**
     * Writes a metadata file atomically. Writes to the same file run one after the other (two
     * browser tabs on one project write `project.json` at the same moment), and the final rename
     * is retried while Windows reports the target as locked.
     */
    public async writeJson(name: string, value: unknown): Promise<void> {
        const file = this.metaPath(name);
        const previous = this.writeQueues.get(file) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(() => this.writeJsonNow(file, value));
        this.writeQueues.set(file, next);
        const forget = () => {
            if (this.writeQueues.get(file) === next) {
                this.writeQueues.delete(file);
            }
        };
        next.then(forget, forget);
        return next;
    }

    private async writeJsonNow(file: string, value: unknown): Promise<void> {
        await mkdir(join(file, ".."), { recursive: true });
        // write to a sibling first, so readers never see a partial file
        const temp = `${file}.tmp-${randomUUID()}`;
        await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
        try {
            await renameWithRetry(temp, file);
        } catch (error) {
            await unlink(temp).catch(() => undefined);
            throw error;
        }
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

    private async ensureRepo(dir: string, repo: ProjectRepo): Promise<void> {
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
