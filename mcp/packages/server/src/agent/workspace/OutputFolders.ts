import { lstatSync, readdirSync } from "fs";
import { mkdir, readdir, readFile } from "fs/promises";
import path from "path";
import type { OutputPurpose, OutputRefusalReason, OutputTarget } from "@penpot/mcp-common";
import { AgentError } from "../AgentClient";
import { SpecFolder } from "../instruct/SpecFolder";
import type { LinkedFolders } from "../linked/LinkedFolders";
import { ProjectLinkRecord } from "../linked/ProjectLink";
import { AppFolder } from "./AppFolder";
import { FolderPaths } from "./FolderPaths";
import { PathGuard } from "./pathGuard";
import { type ProjectOutput, ProjectOutputRecord } from "./ProjectOutput";

/** A refused output folder: `error {code:"bad-request", reason}` for the client. */
export class OutputRefusal extends AgentError {
    constructor(
        public readonly refusal: OutputRefusalReason,
        message: string
    ) {
        super("bad-request", message, refusal);
        this.name = "OutputRefusal";
    }
}

/** A folder pick to check. */
export interface OutputRequest {
    projectId: string;
    purpose: OutputPurpose;
    /** absolute path of the folder the user picked */
    picked: string;
    /** project name, for the sub-folder */
    name: string;
    /** the project's output folder so far */
    current: ProjectOutput | null;
}

/** Folder another project uses. */
interface Claim {
    projectId: string;
    path: string;
    kind: "app" | "output" | "linked";
}

/**
 * Folders of this computer Build and Instruct may write to (W41).
 *
 * A picked folder that is empty, or that Penforge made for the same project, is used as it is.
 * Every other folder gets a new sub-folder named after the project, so nothing is ever written
 * next to the user's files. Refused: drive and file system roots, the home folder, system folders,
 * the Penforge home, the app or linked folder of another project, a folder inside an app folder,
 * and, for Build (which creates a git repository), a folder inside a repository of the user.
 */
export class OutputFolders {
    /** sub-folder names tried for a free one */
    private static readonly MAX_NAMES = 500;
    private static readonly MAX_NAME_CHARS = 60;
    /** folder names whose content belongs to a tool */
    private static readonly TOOL_FOLDERS = new Set([".git", "node_modules"]);

    private readonly paths: FolderPaths;

    /**
     * @param folders - checks of folders of this computer (W38)
     * @param projectsDir - folder holding the project folders
     */
    constructor(
        private readonly folders: LinkedFolders,
        private readonly projectsDir: string
    ) {
        this.paths = new FolderPaths();
    }

    /**
     * Tells which folder a pick gives; creates nothing.
     *
     * @param request - the pick
     * @throws AgentError with a reason when the folder cannot be used
     */
    public async target(request: OutputRequest): Promise<OutputTarget> {
        const listing = await this.folders.list("", request.picked.trim().length > 0 ? request.picked : undefined);
        const picked = listing.path;
        if (picked === null || (process.platform === "win32" && PathGuard.isSpecialWindowsPath(picked))) {
            throw new OutputRefusal("bad-path", "Enter the full path of a folder on this computer");
        }
        if (this.folders.isRefusedRoot(picked) || this.isToolFolder(picked)) {
            throw new OutputRefusal(
                "folder-refused",
                "This folder cannot be used: pick a folder of your own, not a drive, your home folder, a system " +
                    "folder or the Penforge folder"
            );
        }
        const claims = await this.claims(request.projectId);
        this.checkNotTaken(picked, request.projectId, claims);

        const reusable = this.reusable(request, picked, claims);
        const target: OutputTarget = reusable
            ? { picked, path: reusable.path, subFolder: reusable.path !== picked, existing: reusable.existing }
            : { picked, path: this.freeSubFolder(picked, request, claims), subFolder: true, existing: false };
        if (request.purpose === "build") {
            this.checkNoRepository(target.path, request.projectId);
        }
        return target;
    }

    /**
     * Creates the folder a pick gives.
     *
     * @param request - the pick
     * @returns the folder, which exists now
     * @throws AgentError with a reason when the folder cannot be used
     */
    public async create(request: OutputRequest): Promise<OutputTarget> {
        // a second try takes the next free name when the first one appeared in the meantime
        for (let attempt = 0; ; attempt++) {
            const target = await this.target(request);
            if (!target.subFolder || target.existing) {
                return target;
            }
            try {
                // not recursive: fails for a folder that exists instead of sharing it
                await mkdir(target.path);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST" && attempt < 3) {
                    continue;
                }
                throw new OutputRefusal("not-writable", "The folder cannot be created here");
            }
            if (!this.paths.isRealFolder(target.path)) {
                throw new OutputRefusal("folder-refused", "The folder cannot be used");
            }
            return target;
        }
    }

    /**
     * Folder name of a project: lower-case ASCII words joined with dashes.
     *
     * @param name - the project name
     */
    public static folderName(name: string): string {
        const slug = name
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/ı/g, "i")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, OutputFolders.MAX_NAME_CHARS)
            .replace(/-+$/, "");
        // device names (`con`, `nul`, …) open a device instead of a folder on Windows
        return slug.length === 0 || PathGuard.isSpecialWindowsPath(slug) ? `${slug || "penforge"}-app` : slug;
    }

    /** The folder Penforge already uses for this pick, or the picked folder itself when it is empty. */
    private reusable(
        request: OutputRequest,
        picked: string,
        claims: readonly Claim[]
    ): { path: string; existing: boolean } | null {
        const { projectId, purpose, current } = request;
        if (this.isOwnFolder(picked, projectId, purpose)) {
            return { path: picked, existing: true };
        }
        const free = (folder: string) => !claims.some((claim) => this.paths.same(claim.path, folder));
        if (OutputFolders.isEmpty(picked) && free(picked)) {
            return { path: picked, existing: current !== null && this.paths.same(current.outputRoot, picked) };
        }
        // the sub-folder an earlier pick of the same folder made
        for (const earlier of [current?.appRoot, current?.outputRoot]) {
            if (
                earlier &&
                this.paths.same(path.dirname(earlier), picked) &&
                this.paths.isRealFolder(earlier) &&
                (this.isOwnFolder(earlier, projectId, purpose) || (OutputFolders.isEmpty(earlier) && free(earlier)))
            ) {
                return { path: earlier, existing: true };
            }
        }
        const named = path.join(picked, OutputFolders.folderName(request.name));
        return this.isOwnFolder(named, projectId, purpose) ? { path: named, existing: true } : null;
    }

    /**
     * Tells whether Penforge made a folder for the project and may write to it again: the app
     * folder; for Instruct also a folder whose `PenforgeUI` is the project's; for Build also a
     * folder that holds nothing but Penforge's own parts.
     */
    private isOwnFolder(folder: string, projectId: string, purpose: OutputPurpose): boolean {
        if (!this.paths.isRealFolder(folder)) {
            return false;
        }
        const spec = path.join(folder, AppFolder.SPEC_FOLDER);
        const ownSpec = SpecFolder.isOwn(spec, projectId);
        if (purpose === "instruct") {
            return ownSpec || (AppFolder.isOwn(folder, projectId) && !OutputFolders.exists(spec));
        }
        if (AppFolder.isOwn(folder, projectId)) {
            return true;
        }
        const own = new Set<string>();
        if (AppFolder.markerProject(folder) === projectId) {
            own.add(AppFolder.MARKER);
        }
        if (ownSpec) {
            own.add(AppFolder.SPEC_FOLDER);
        }
        const names = OutputFolders.names(folder);
        return own.size > 0 && names !== null && names.every((name) => own.has(name));
    }

    private freeSubFolder(picked: string, request: OutputRequest, claims: readonly Claim[]): string {
        const base = OutputFolders.folderName(request.name);
        for (let n = 1; n <= OutputFolders.MAX_NAMES; n++) {
            const candidate = path.join(picked, n === 1 ? base : `${base}-${n}`);
            if (!OutputFolders.exists(candidate) && !claims.some((claim) => this.paths.same(claim.path, candidate))) {
                return candidate;
            }
        }
        throw new OutputRefusal("not-writable", "No free folder name is left here");
    }

    /** Refuses a folder that is, or lies in, an app or linked folder. */
    private checkNotTaken(picked: string, projectId: string, claims: readonly Claim[]): void {
        const refuse = () => {
            throw new OutputRefusal(
                "folder-taken",
                "This folder belongs to an app Penforge already works on; pick another one"
            );
        };
        if (
            claims.some((claim) =>
                claim.kind === "output" ? this.paths.same(claim.path, picked) : this.paths.inside(claim.path, picked)
            )
        ) {
            refuse();
        }
        for (const folder of this.paths.selfAndParents(picked)) {
            const marker = AppFolder.markerProject(folder);
            const ownApp = marker === projectId && folder === picked;
            if ((marker !== null && !ownApp) || SpecFolder.isSpec(folder)) {
                refuse();
            }
        }
    }

    /** Refuses a folder in a git repository, except the one Penforge made in the folder itself. */
    private checkNoRepository(target: string, projectId: string): void {
        const own = AppFolder.isOwn(target, projectId);
        const found = this.paths
            .selfAndParents(target)
            .some((folder) => AppFolder.hasGit(folder) && !(own && folder === target));
        if (found) {
            throw new OutputRefusal(
                "inside-git",
                "This folder is inside a git repository; Build needs a folder outside your repositories"
            );
        }
    }

    private isToolFolder(folder: string): boolean {
        return folder.split(/[\\/]/).some((segment) => OutputFolders.TOOL_FOLDERS.has(segment.toLowerCase()));
    }

    /** The folders other projects of this computer use. */
    private async claims(projectId: string): Promise<Claim[]> {
        const entries = await readdir(this.projectsDir, { withFileTypes: true }).catch(() => []);
        const claims = await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && entry.name !== projectId)
                .map((entry) => this.claimsOf(entry.name))
        );
        return claims.flat();
    }

    private async claimsOf(projectId: string): Promise<Claim[]> {
        let info;
        try {
            info = JSON.parse(
                await readFile(path.join(this.projectsDir, projectId, ".penforge", "project.json"), "utf8")
            );
        } catch {
            return [];
        }
        const output = ProjectOutputRecord.read(info);
        const link = ProjectLinkRecord.read(info);
        return [
            ...(output?.appRoot ? [{ projectId, path: output.appRoot, kind: "app" as const }] : []),
            ...(output ? [{ projectId, path: output.outputRoot, kind: "output" as const }] : []),
            ...(link ? [{ projectId, path: link.root, kind: "linked" as const }] : []),
        ];
    }

    private static isEmpty(folder: string): boolean {
        return OutputFolders.names(folder)?.length === 0;
    }

    private static names(folder: string): string[] | null {
        try {
            return readdirSync(folder);
        } catch {
            return null;
        }
    }

    private static exists(target: string): boolean {
        try {
            lstatSync(target);
            return true;
        } catch (error) {
            // a name that cannot be read counts as taken
            return (error as NodeJS.ErrnoException).code !== "ENOENT";
        }
    }
}
