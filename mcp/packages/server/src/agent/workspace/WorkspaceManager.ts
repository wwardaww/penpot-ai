import type { AgentContext } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { ProjectWorkspace } from "./ProjectWorkspace";

/** Content of `.penforge/project.json`. */
export interface ProjectInfo {
    projectId: string;
    projectName?: string;
    teamId: string;
    platform: AgentContext["platform"];
    /** persona of the last user who opened the project */
    persona: AgentContext["persona"];
    fileIds: string[];
    createdAt: string;
    updatedAt: string;
}

/**
 * Manager of the project folders below `<PENFORGE_HOME>/projects/`.
 *
 * Creates a project's folders and repositories the first time a client sets a context for it, and
 * keeps one {@link ProjectWorkspace} per project.
 */
export class WorkspaceManager {
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
     * Records the context in `project.json`, one update at a time per project. The file is
     * metadata only: a failed write is logged and never fails the client's session.
     */
    private record(workspace: ProjectWorkspace, context: AgentContext): Promise<void> {
        const key = workspace.projectId;
        const previous = this.records.get(key) ?? Promise.resolve();
        const next = previous
            .then(() => this.recordContext(workspace, context))
            .catch((error: unknown) => {
                this.logger.warn("Could not update project.json of %s: %s", key, String(error));
            });
        this.records.set(key, next);
        void next.then(() => {
            if (this.records.get(key) === next) {
                this.records.delete(key);
            }
        });
        return next;
    }

    private async recordContext(workspace: ProjectWorkspace, context: AgentContext): Promise<void> {
        const now = new Date().toISOString();
        const previous = await workspace.readJson<ProjectInfo | null>("project.json", null);
        const fileIds = new Set(previous?.fileIds ?? []);
        fileIds.add(context.fileId);
        const info: ProjectInfo = {
            projectId: context.projectId,
            projectName: context.projectName ?? previous?.projectName,
            teamId: context.teamId,
            platform: context.platform,
            persona: context.persona,
            fileIds: [...fileIds],
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        };
        await workspace.writeJson("project.json", info);
    }
}
