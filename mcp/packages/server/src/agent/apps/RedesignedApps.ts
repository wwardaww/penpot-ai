import { createHash } from "crypto";
import { basename, resolve } from "path";
import type { AppInfo, AppRedesignInfo } from "@penpot/mcp-common";
import { ProjectLinkRecord } from "../linked/ProjectLink";
import { RedesignBranch, type RedesignedAppEntry } from "../linked/RedesignBranch";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { AppFolders } from "./AppFolders";
import { LinkedAppStack } from "./LinkedAppStack";
import { ReadOnlyGit } from "./ReadOnlyGit";

/** Fields of a Re-Designed app that come from its project and Re-Design (no thumbnail, no status). */
export type RedesignedAppFields = Omit<
    AppInfo,
    "status" | "builtAt" | "commit" | "checkpoint" | "thumbnail" | "thumbnailPath" | "teamId" | "projectName"
> & { redesign: AppRedesignInfo };

/**
 * Apps of the Re-Designed Existing projects (W39), for the dashboard's catalog.
 *
 * Reads `.penforge/redesign.json` of a project linked as Existing project. A record written since
 * W39 names its apps (`apps`: Penpot file and app folder). An older record names only the branch:
 * the app folders are then found from the files the branch changed ({@link AppFolders}, git reads
 * only through {@link ReadOnlyGit}), and the Penpot file is the project's only file, if it has
 * one. Names come from the file names the tabs reported (`project.json` `fileNames`), else from
 * the app folder.
 *
 * Nothing here writes or runs anything: no git command that changes the folder, no install.
 */
export class RedesignedApps {
    /** separator between project id and app hash in an app id */
    private static readonly SEPARATOR = "~";
    private static readonly APP_ID = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})~([0-9a-f]{8})$/;
    private static readonly MAX_CACHE = 100;

    /** app folders found from changes, by linked folder, base and head commit */
    private readonly guesses = new Map<string, string[]>();

    /**
     * Gets the project of an app id of a Re-Designed app.
     *
     * @param appId - the app id
     * @returns the project id, or null when the id is not one of a Re-Designed app
     */
    public static projectOf(appId: string): string | null {
        return RedesignedApps.APP_ID.exec(appId)?.[1] ?? null;
    }

    /**
     * Gets the app id of a Re-Designed app: stable for a project, Penpot file and app folder.
     *
     * @param projectId - the project
     * @param fileId - the Penpot file, or null when unknown
     * @param appDir - the app folder relative to the linked folder
     */
    public static appId(projectId: string, fileId: string | null, appDir: string): string {
        const hash = createHash("sha1")
            .update(`${fileId ?? ""}\n${appDir}`)
            .digest("hex")
            .slice(0, 8);
        return `${projectId}${RedesignedApps.SEPARATOR}${hash}`;
    }

    /**
     * Lists the Re-Designed apps of a project.
     *
     * @param projectId - the project
     * @param projectRoot - its folder below `projects/`
     * @param project - its parsed `project.json`, or null
     * @param record - its parsed `redesign.json`, or null
     */
    public async list(
        projectId: string,
        projectRoot: string,
        project: Record<string, unknown> | null,
        record: unknown
    ): Promise<RedesignedAppFields[]> {
        const link = ProjectLinkRecord.read(project);
        const redesign = RedesignBranch.readRecord(record);
        if (link === null || link.kind !== "existing" || redesign === null || redesign.kind !== "existing") {
            return [];
        }
        if (!RedesignedApps.samePath(redesign.root, link.root)) {
            // a record of an earlier link
            return [];
        }
        const git = new ReadOnlyGit(link.root);
        const head = await git.branchHead(redesign.branch);
        if (head === null) {
            // the branch is gone (or the folder is no repository any more)
            return [];
        }
        const fileIds = Array.isArray(project?.fileIds)
            ? project.fileIds.filter((id): id is string => typeof id === "string")
            : [];
        const fileNames = RedesignedApps.fileNames(project?.fileNames);
        let entries: RedesignedAppEntry[];
        let source: AppRedesignInfo["source"];
        if (redesign.apps.length > 0) {
            entries = redesign.apps;
            source = "record";
        } else {
            const onlyFile = fileIds.length === 1 ? fileIds[0] : null;
            entries = (await this.guess(git, redesign.baseCommit, head)).map((appDir) => ({
                fileId: onlyFile,
                fileName: null,
                appDir,
            }));
            source = "changes";
        }
        const currentBranch = await git.currentBranch();
        const apps: RedesignedAppFields[] = [];
        for (const entry of entries) {
            const stack = await LinkedAppStack.inspect(link.root, entry.appDir);
            if (stack === null) {
                continue;
            }
            const fileName = (entry.fileId !== null ? fileNames.get(entry.fileId) : undefined) ?? entry.fileName;
            const folderName = entry.appDir === "" ? basename(link.root) : basename(entry.appDir);
            apps.push({
                appId: RedesignedApps.appId(projectId, entry.fileId, entry.appDir),
                projectId,
                name: fileName ?? folderName,
                fileName,
                fileId: entry.fileId,
                platform: stack.stack?.platform ?? "web",
                stack: { name: stack.stack?.name ?? "app", version: stack.version },
                expo: stack.expo,
                web: stack.web,
                path: projectRoot,
                appPath: stack.dir,
                redesign: {
                    branch: redesign.branch,
                    baseBranch: redesign.baseBranch,
                    currentBranch,
                    root: link.root,
                    appDir: entry.appDir,
                    installed: stack.installed,
                    runnable: stack.devArgv !== null,
                    source,
                    updatedAt: redesign.updatedAt,
                },
            });
        }
        RedesignedApps.disambiguate(apps);
        return apps;
    }

    /** App folders of the files a branch changed, cached by commits. */
    private async guess(git: ReadOnlyGit, base: string, head: string): Promise<string[]> {
        const key = `${git.root}\n${base}\n${head}`;
        const cached = this.guesses.get(key);
        if (cached) {
            return cached;
        }
        const dirs = await new AppFolders(git.root).fromChanges(await git.changedPaths(base, head));
        if (this.guesses.size >= RedesignedApps.MAX_CACHE) {
            this.guesses.clear();
        }
        this.guesses.set(key, dirs);
        return dirs;
    }

    /** Adds the folder to names that several apps of the project share. */
    private static disambiguate(apps: RedesignedAppFields[]): void {
        const counts = new Map<string, number>();
        for (const app of apps) {
            counts.set(app.name, (counts.get(app.name) ?? 0) + 1);
        }
        for (const app of apps) {
            if ((counts.get(app.name) ?? 0) > 1) {
                app.name = `${app.name} (${app.redesign.appDir === "" ? basename(app.redesign.root) : app.redesign.appDir})`;
            }
        }
    }

    private static fileNames(value: unknown): Map<string, string> {
        const names = new Map<string, string>();
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            for (const [id, name] of Object.entries(value)) {
                if (ProjectWorkspace.ID_PATTERN.test(id) && typeof name === "string" && name.trim().length > 0) {
                    names.set(id, name.trim());
                }
            }
        }
        return names;
    }

    private static samePath(a: string, b: string): boolean {
        const left = resolve(a);
        const right = resolve(b);
        return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    }
}
