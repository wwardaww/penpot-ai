import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { AppCheckpointInfo, AppInfo, AppRunStatus, Platform } from "@penpot/mcp-common";
import { ProjectOutputRecord } from "../workspace/ProjectOutput";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { AppThumbnail } from "./AppThumbnail";
import { RedesignedApps } from "./RedesignedApps";

/** App as found on disk, without its run status. */
export type AppRecord = Omit<AppInfo, "status">;

/**
 * Catalog of the apps below `<PENFORGE_HOME>/projects/`: built apps (W33) and Re-Designed
 * Existing projects (W39, {@link RedesignedApps}).
 *
 * A project counts as built when `.penforge/map.json` (written by every successful build) and
 * `.penforge/stack.json` exist; its app id is the project id. A project linked as Existing project
 * with a `.penforge/redesign.json` gives one app per Penpot file and app folder of the Re-Design.
 * The catalog only reads: it never creates project folders or repositories. Broken or missing
 * optional files (`project.json`, `checkpoints.json`, `app-src/package.json`) leave their fields
 * empty.
 */
export class AppCatalog {
    private readonly thumbnails = new AppThumbnail();
    private readonly redesigned = new RedesignedApps();

    /**
     * @param projectsDir - folder holding the project folders
     */
    constructor(private readonly projectsDir: string) {}

    /**
     * Lists the apps, newest build or Re-Design first.
     *
     * @param teamId - only apps of this Penpot team
     */
    public async list(teamId?: string): Promise<AppRecord[]> {
        const entries = await readdir(this.projectsDir, { withFileTypes: true }).catch(() => []);
        const ids = entries
            .filter((entry) => entry.isDirectory() && ProjectWorkspace.ID_PATTERN.test(entry.name))
            .map((entry) => entry.name);
        const records = (await Promise.all(ids.map((id) => this.projectApps(id)))).flatMap((apps) =>
            apps.filter((record) => teamId === undefined || record.teamId === teamId)
        );
        return records.sort((a, b) => AppCatalog.time(b).localeCompare(AppCatalog.time(a)));
    }

    /**
     * Reads the built app of a project.
     *
     * @param projectId - the Penpot project id
     * @returns the app, or null when the project has no built app (or the id is not valid)
     */
    public async find(projectId: string): Promise<AppRecord | null> {
        if (!ProjectWorkspace.ID_PATTERN.test(projectId)) {
            return null;
        }
        return (await this.projectApps(projectId, true)).find((app) => app.redesign === null) ?? null;
    }

    /**
     * Reads one app.
     *
     * @param appId - the app id: a project id (built app) or a Re-Designed app's id
     * @returns the app, or null when there is none with this id
     */
    public async findApp(appId: string): Promise<AppRecord | null> {
        if (ProjectWorkspace.ID_PATTERN.test(appId)) {
            return this.find(appId);
        }
        const projectId = RedesignedApps.projectOf(appId);
        if (projectId === null) {
            return null;
        }
        return (await this.projectApps(projectId)).find((app) => app.appId === appId) ?? null;
    }

    /** The apps of one project: its built app, then its Re-Designed apps. */
    private async projectApps(projectId: string, builtOnly = false): Promise<AppRecord[]> {
        const root = join(this.projectsDir, projectId);
        const metaDir = join(root, ".penforge");
        const project = AppCatalog.object(await AppCatalog.readJson(join(metaDir, "project.json")));
        const built = await this.built(projectId, root, project);
        const redesigned = builtOnly
            ? []
            : await this.redesigned
                  .list(projectId, root, project, await AppCatalog.readJson(join(metaDir, "redesign.json")))
                  .catch(() => []);
        if (built === null && redesigned.length === 0) {
            return [];
        }
        const thumbnail = await AppThumbnail.locate(root);
        const shared = {
            teamId: AppCatalog.text(project?.teamId),
            projectName: AppCatalog.text(project?.projectName),
            checkpoint: AppCatalog.lastCheckpoint(await AppCatalog.readJson(join(metaDir, "checkpoints.json"))),
            thumbnail: thumbnail ? await this.thumbnails.dataUrl(thumbnail) : null,
            thumbnailPath: thumbnail?.relativePath ?? null,
        };
        return [
            ...(built ? [{ ...built, ...shared }] : []),
            ...redesigned.map((app) => ({ ...app, ...shared, builtAt: null, commit: null })),
        ];
    }

    /** The built app of a project, without the fields its Re-Designed apps share. */
    private async built(
        projectId: string,
        root: string,
        project: Record<string, unknown> | null
    ): Promise<Omit<AppRecord, "teamId" | "projectName" | "checkpoint" | "thumbnail" | "thumbnailPath"> | null> {
        const metaDir = join(root, ".penforge");
        const map = AppCatalog.object(await AppCatalog.readJson(join(metaDir, "map.json")));
        const stack = AppCatalog.object(await AppCatalog.readJson(join(metaDir, "stack.json")));
        if (!map || !stack) {
            return null;
        }
        // W41: the folder the user picked, else `app-src/` in the project folder
        const appSrcDir = ProjectOutputRecord.read(project)?.appRoot ?? join(root, "app-src");
        const devArgv = AppCatalog.devArgv(stack);
        const expo = devArgv.includes("expo") && devArgv.includes("start");
        const platform = AppCatalog.platform(stack.platform) ?? AppCatalog.platform(project?.platform) ?? "web";
        return {
            appId: projectId,
            projectId,
            name: AppCatalog.text(project?.projectName) ?? AppCatalog.text(stack.name) ?? projectId,
            fileName: null,
            fileId: AppCatalog.text(map.fileId) ?? AppCatalog.firstText(project?.fileIds),
            platform,
            stack: { name: AppCatalog.text(stack.name) ?? "app", version: AppCatalog.text(stack.version) ?? "" },
            expo,
            // any other dev server is a web server the browser can show
            web: expo ? await AppCatalog.hasWebRenderer(appSrcDir) : true,
            builtAt: AppCatalog.text(map.builtAt),
            commit: AppCatalog.text(map.commit),
            path: root,
            appPath: appSrcDir,
            redesign: null,
        };
    }

    /** Time an app is sorted by: its build, else its last Re-Design. */
    private static time(app: AppRecord): string {
        return app.builtAt ?? app.redesign?.updatedAt ?? "";
    }

    /**
     * Combines a record with a run status.
     *
     * @param record - the app
     * @param status - its dev server status
     */
    public static withStatus(record: AppRecord, status: AppRunStatus): AppInfo {
        return { ...record, status };
    }

    /** Expo apps show in a browser only with react-native-web (Expo serves web on the dev port). */
    private static async hasWebRenderer(appSrcDir: string): Promise<boolean> {
        const pkg = AppCatalog.object(await AppCatalog.readJson(join(appSrcDir, "package.json")));
        if (!pkg) {
            return false;
        }
        return ["dependencies", "devDependencies"].some((key) => {
            const deps = AppCatalog.object(pkg[key]);
            return deps !== null && "react-native-web" in deps;
        });
    }

    private static devArgv(stack: Record<string, unknown>): string[] {
        const commands = AppCatalog.object(stack.commands);
        const dev = commands?.dev ?? stack.dev;
        if (Array.isArray(dev)) {
            return dev.filter((arg): arg is string => typeof arg === "string");
        }
        return typeof dev === "string" ? dev.split(/\s+/).filter((arg) => arg.length > 0) : [];
    }

    private static lastCheckpoint(file: unknown): AppCheckpointInfo | null {
        const list = AppCatalog.object(file)?.checkpoints;
        if (!Array.isArray(list)) {
            return null;
        }
        let last: AppCheckpointInfo | null = null;
        for (const entry of list) {
            const checkpoint = AppCatalog.object(entry);
            const n = checkpoint?.n;
            if (typeof n === "number" && (last === null || n > last.n)) {
                last = {
                    n,
                    label: AppCatalog.text(checkpoint?.label) ?? "",
                    at: AppCatalog.text(checkpoint?.at) ?? "",
                };
            }
        }
        return last;
    }

    private static platform(value: unknown): Platform | null {
        return value === "web" || value === "mobile" ? value : null;
    }

    private static text(value: unknown): string | null {
        return typeof value === "string" && value.length > 0 ? value : null;
    }

    private static firstText(value: unknown): string | null {
        return Array.isArray(value) ? AppCatalog.text(value[0]) : null;
    }

    private static object(value: unknown): Record<string, unknown> | null {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    }

    private static async readJson(file: string): Promise<unknown> {
        try {
            return JSON.parse(await readFile(file, "utf8"));
        } catch {
            return null;
        }
    }
}
