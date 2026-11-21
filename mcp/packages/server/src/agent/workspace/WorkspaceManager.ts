import type { AgentContext, Platform } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { type ProjectLink, type ProjectLinkFields, ProjectLinkRecord } from "../linked/ProjectLink";
import { ProjectWorkspace } from "./ProjectWorkspace";

/** Content of `.penforge/project.json` (with the W38 link fields of a linked project). */
export interface ProjectInfo extends ProjectLinkFields {
    projectId: string;
    projectName?: string;
    teamId: string;
    /** the project type as chosen in Penpot */
    platform: Platform;
    /** persona of the last user who opened the project */
    persona: AgentContext["persona"];
    fileIds: string[];
    /** Penpot file names by file id, as the tabs last reported them (W39; absent before) */
    fileNames?: Record<string, string>;
    createdAt: string;
    updatedAt: string;
    /** keys other features keep in the file (e.g. W32 `aiAnimations`) */
    [key: string]: unknown;
}

/**
 * Manager of the project folders below `<PENFORGE_HOME>/projects/`.
 *
 * Creates a project's folders and repositories the first time a client sets a context for it, and
 * keeps one {@link ProjectWorkspace} per project.
 */
export class WorkspaceManager {
    private static readonly MAX_FILE_NAME = 250;

    private readonly logger = createLogger("WorkspaceManager");
    private readonly workspaces = new Map<string, Promise<ProjectWorkspace>>();
    /** Pending `project.json` updates per project, so updates from two tabs never overlap. */
    private readonly records = new Map<string, Promise<void>>();

    /**
     * @param projectsDir - folder holding the project folders
     */
    constructor(private readonly projectsDir: string) {}

    /**
     * Opens the workspace of a context's project, creating it on first use, and records the context
     * in `.penforge/project.json`.
     *
     * @param context - the client context
     */
    public async open(context: AgentContext): Promise<ProjectWorkspace> {
        const workspace = await this.get(context.projectId);
        await this.record(workspace, context);
        return workspace;
    }

    /**
     * Gets the workspace of a project, creating its folders and repositories on first use.
     *
     * @param projectId - the Penpot project id
     */
    public get(projectId: string): Promise<ProjectWorkspace> {
        let workspace = this.workspaces.get(projectId);
        if (!workspace) {
            workspace = this.create(projectId);
            this.workspaces.set(projectId, workspace);
            // forget failed attempts, so that a later call retries
            workspace.catch(() => this.workspaces.delete(projectId));
        }
        return workspace;
    }

    private async create(projectId: string): Promise<ProjectWorkspace> {
        const workspace = new ProjectWorkspace(this.projectsDir, projectId);
        await workspace.ensure();
        this.logger.info("Project workspace ready: %s", workspace.root);
        return workspace;
    }

    /**
     * Stores or removes a project's link to a folder of this computer (W38) in `project.json`,
     * in turn with the context updates, and applies it to the open workspace.
     *
     * @param projectId - the Penpot project id
     * @param link - the link, or null to remove it
     * @throws when `project.json` cannot be written
     */
    public async setLink(projectId: string, link: ProjectLink | null): Promise<ProjectWorkspace> {
        const workspace = await this.get(projectId);
        await this.queue(workspace, async () => {
            const previous = await workspace.readJson<Partial<ProjectInfo> | null>("project.json", null);
            const {
                linkedRoot: _root,
                linkedKind: _kind,
                engine: _engine,
                stack: _stack,
                linkedAt: _at,
                ...rest
            } = previous ?? {};
            const now = new Date().toISOString();
            await workspace.writeJson("project.json", {
                projectId,
                createdAt: now,
                ...rest,
                ...(link ? ProjectLinkRecord.fields(link) : {}),
                updatedAt: now,
            });
            workspace.setLink(link);
        });
        return workspace;
    }

    /**
     * Records the context in `project.json`, one update at a time per project. The file is
     * metadata only: a failed write is logged and never fails the client's session.
     */
    private record(workspace: ProjectWorkspace, context: AgentContext): Promise<void> {
        const key = workspace.projectId;
        return this.queue(workspace, () => this.recordContext(workspace, context)).catch((error: unknown) => {
            this.logger.warn("Could not update project.json of %s: %s", key, String(error));
        });
    }

    /** Runs an update of `project.json` after the pending ones of the same project. */
    private queue(workspace: ProjectWorkspace, update: () => Promise<void>): Promise<void> {
        const key = workspace.projectId;
        const previous = this.records.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(update);
        this.records.set(key, next);
        const forget = () => {
            if (this.records.get(key) === next) {
                this.records.delete(key);
            }
        };
        next.then(forget, forget);
        return next;
    }

    /** The valid entries of a stored `fileNames` object. */
    private static fileNames(value: unknown): Record<string, string> {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return {};
        }
        return Object.fromEntries(
            Object.entries(value).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0
            )
        );
    }

    private async recordContext(workspace: ProjectWorkspace, context: AgentContext): Promise<void> {
        const now = new Date().toISOString();
        const previous = await workspace.readJson<ProjectInfo | null>("project.json", null);
        const fileIds = new Set(previous?.fileIds ?? []);
        fileIds.add(context.fileId);
        // W39: the dashboard names Re-Designed apps after their file
        const fileNames = { ...WorkspaceManager.fileNames(previous?.fileNames) };
        const fileName = typeof context.fileName === "string" ? context.fileName.trim() : "";
        if (fileName.length > 0) {
            fileNames[context.fileId] = fileName.slice(0, WorkspaceManager.MAX_FILE_NAME);
        }
        const info: ProjectInfo = {
            // keeps the link (W38), `designSystem` (W30) and other fields written by
            // other features
            ...previous,
            projectId: context.projectId,
            projectName: context.projectName ?? previous?.projectName,
            teamId: context.teamId,
            platform: context.projectType ?? context.platform,
            persona: context.persona,
            fileIds: [...fileIds],
            fileNames,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        };
        await workspace.writeJson("project.json", info);
    }
}
