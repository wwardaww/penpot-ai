import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, lstatSync, readFileSync } from "fs";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { delimiter, dirname, join } from "path";
import { promisify } from "util";
import { FolderPaths } from "./FolderPaths";

const execFileAsync = promisify(execFile);

/** Content of the marker file of an app folder. */
interface AppMarker {
    generator: string;
    projectId: string;
    createdAt: string;
}

/**
 * Folder outside the Penforge home that holds the generated app of one project (W41).
 *
 * Penforge recognizes the folder by two signs it left there itself: the marker file
 * `.penforge-app.json` with the project id, and a git repository whose configuration names the
 * project (`penforge.project`). A folder with only one of them, a repository the user made, or a
 * link in place of the folder is not an app folder. Nothing here deletes or overwrites a file.
 */
export class AppFolder {
    /** marker file name */
    public static readonly MARKER = ".penforge-app.json";
    /** folder Instruct writes to, next to the app */
    public static readonly SPEC_FOLDER = "PenforgeUI";

    private static readonly GENERATOR = "penforge-app";
    private static readonly MAX_MARKER_BYTES = 64 * 1024;
    private static readonly MAX_CONFIG_BYTES = 1024 * 1024;
    private static readonly paths = new FolderPaths();

    /**
     * Reads the project id of a folder's marker file.
     *
     * @param dir - the folder
     * @returns the project id, or null without a valid marker
     */
    public static markerProject(dir: string): string | null {
        const text = AppFolder.readSmallFile(join(dir, AppFolder.MARKER), AppFolder.MAX_MARKER_BYTES);
        if (text === null) {
            return null;
        }
        try {
            const marker = JSON.parse(text) as Partial<AppMarker> | null;
            return marker !== null &&
                typeof marker === "object" &&
                marker.generator === AppFolder.GENERATOR &&
                typeof marker.projectId === "string"
                ? marker.projectId
                : null;
        } catch {
            return null;
        }
    }

    /**
     * Tells whether a folder is the app folder Penforge made for a project: a real folder (no
     * link) with the project's marker and the repository Penforge created in it.
     *
     * @param dir - the folder
     * @param projectId - the project
     */
    public static isOwn(dir: string, projectId: string): boolean {
        return (
            AppFolder.paths.isRealFolder(dir) &&
            AppFolder.markerProject(dir) === projectId &&
            AppFolder.ownsRepository(dir, projectId)
        );
    }

    /**
     * Tells whether a folder has a git entry of its own (a repository, or a worktree's file).
     *
     * @param dir - the folder
     */
    public static hasGit(dir: string): boolean {
        try {
            lstatSync(join(dir, ".git"));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Makes a folder the app folder of a project: writes the marker and creates the repository,
     * unless Penforge did so before. The folder must be empty, hold only Penforge's own parts, or
     * carry the project's marker (the caller checked that).
     *
     * @param dir - the folder (a real path)
     * @param projectId - the project
     * @param previous - repository the project's app code was in so far; its commits stay
     *     reachable, so that checkpoints made before can still be restored
     * @throws Error when the folder holds a repository Penforge did not make, or cannot be written
     */
    public static async prepare(dir: string, projectId: string, previous: string | null): Promise<void> {
        const marker = AppFolder.markerProject(dir);
        if (marker !== null && marker !== projectId) {
            throw new Error("The folder belongs to another Penforge project");
        }
        if (AppFolder.hasGit(dir) && !AppFolder.ownsRepository(dir, projectId)) {
            throw new Error("The folder already holds a git repository");
        }
        AppFolder.protectParents(dir);
        if (marker === null) {
            const content: AppMarker = {
                generator: AppFolder.GENERATOR,
                projectId,
                createdAt: new Date().toISOString(),
            };
            // `wx`: never replaces a file that appeared in the meantime
            await writeFile(join(dir, AppFolder.MARKER), `${JSON.stringify(content, null, 2)}\n`, { flag: "wx" });
        }
        if (AppFolder.hasGit(dir)) {
            return;
        }
        await AppFolder.git(dir, ["init", "-q", "-b", "main"]);
        await AppFolder.git(dir, ["config", "penforge.project", projectId]);
        await AppFolder.exclude(dir);
        await AppFolder.git(dir, [
            ...(await AppFolder.identityArgs(dir)),
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "penforge(init): create app-src repository",
        ]);
        if (previous !== null && AppFolder.hasGit(previous) && !AppFolder.paths.same(previous, dir)) {
            await AppFolder.keepHistory(dir, previous);
        }
    }

    /**
     * Keeps git commands that run in an app folder from ever reaching a repository above it: when
     * the app's own `.git` goes away, git stops at the folder instead of taking the parent's
     * repository, which is the user's. Holds for every child process of the daemon.
     *
     * @param dir - the app folder
     */
    public static protectParents(dir: string): void {
        const parent = dirname(dir);
        const current = (process.env.GIT_CEILING_DIRECTORIES ?? "").split(delimiter).filter((entry) => entry !== "");
        if (!current.includes(parent)) {
            process.env.GIT_CEILING_DIRECTORIES = [...current, parent].join(delimiter);
        }
    }

    /** Tells whether the folder's repository is the one {@link prepare} created for the project. */
    private static ownsRepository(dir: string, projectId: string): boolean {
        try {
            if (!lstatSync(join(dir, ".git")).isDirectory()) {
                return false;
            }
        } catch {
            return false;
        }
        const config = AppFolder.readSmallFile(join(dir, ".git", "config"), AppFolder.MAX_CONFIG_BYTES);
        const section = config === null ? null : /^\[penforge\]([^[]*)/m.exec(config);
        const value = section === null ? null : /^\s*project\s*=\s*(\S+)\s*$/m.exec(section[1]);
        return value !== null && value[1] === projectId;
    }

    /** Keeps the marker and Instruct's folder out of the app's commits. */
    private static async exclude(dir: string): Promise<void> {
        const info = join(dir, ".git", "info");
        await mkdir(info, { recursive: true });
        const file = join(info, "exclude");
        const current = existsSync(file) ? await readFile(file, "utf8") : "";
        const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
        await appendFile(file, `${prefix}/${AppFolder.MARKER}\n/${AppFolder.SPEC_FOLDER}/\n`, "utf8");
    }

    /** Fetches the commits of the app's earlier repository below `refs/penforge/`. */
    private static async keepHistory(dir: string, previous: string): Promise<void> {
        const ref = `refs/penforge/previous/${randomUUID().slice(0, 8)}`;
        // without the history only older checkpoints lose their code part
        await AppFolder.git(dir, [
            "fetch",
            "-q",
            "--no-tags",
            previous,
            `+refs/heads/*:${ref}/heads/*`,
            `+refs/tags/*:${ref}/tags/*`,
            "+refs/penforge/previous/*:refs/penforge/previous/*",
        ]).catch(() => undefined);
    }

    private static async identityArgs(dir: string): Promise<string[]> {
        const configured = await AppFolder.git(dir, ["config", "user.email"])
            .then((email) => email.trim().length > 0)
            .catch(() => false);
        return configured ? [] : ["-c", "user.name=Penforge", "-c", "user.email=penforge@localhost"];
    }

    private static readSmallFile(file: string, maxBytes: number): string | null {
        try {
            const info = lstatSync(file);
            return info.isFile() && info.size <= maxBytes ? readFileSync(file, "utf8") : null;
        } catch {
            return null;
        }
    }

    /** Runs git in a folder, without variables that would point it at another repository. */
    private static async git(cwd: string, args: string[]): Promise<string> {
        const env = Object.fromEntries(
            Object.entries(process.env).filter(
                ([name]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE)$/i.test(name)
            )
        );
        const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, env });
        return stdout;
    }
}
