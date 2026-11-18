import { join } from "path";
import type { AgentContext } from "@penpot/mcp-common";
import { AgentError } from "../AgentClient";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { WorkspaceManager } from "../workspace/WorkspaceManager";

/**
 * Project workspaces of server mode, one folder tree per team:
 * `<teams-dir>/<team-id>/projects/<project-id>/`.
 *
 * The team id of a context must already be the one the Penpot backend reported for the project
 * (see `ServerGate.authorize`), never the browser's claim.
 */
export class TeamWorkspaces extends WorkspaceManager {
    private static readonly TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    private readonly teams = new Map<string, WorkspaceManager>();
    /** team of every project opened so far, for lookups by project id only */
    private readonly projectTeams = new Map<string, string>();

    /**
     * @param teamsDir - folder holding the team folders
     */
    constructor(private readonly teamsDir: string) {
        super(join(teamsDir, "_unused"));
    }

    /**
     * Opens the workspace of a checked context's project.
     *
     * @param context - the client context, with the backend's team id
     */
    public override async open(context: AgentContext): Promise<ProjectWorkspace> {
        const workspace = await this.team(context.teamId).open(context);
        this.projectTeams.set(context.projectId, context.teamId);
        return workspace;
    }

    /**
     * Gets the workspace of a project opened before (its team is known).
     *
     * @param projectId - the Penpot project id
     */
    public override get(projectId: string): Promise<ProjectWorkspace> {
        const teamId = this.projectTeams.get(projectId);
        if (!teamId) {
            return Promise.reject(new AgentError("no-context", "The project was not opened on this server"));
        }
        return this.team(teamId).get(projectId);
    }

    /**
     * Folder of a team.
     *
     * @param teamId - the team id
     */
    public teamDir(teamId: string): string {
        TeamWorkspaces.checkTeam(teamId);
        return join(this.teamsDir, teamId);
    }

    private team(teamId: string): WorkspaceManager {
        TeamWorkspaces.checkTeam(teamId);
        let manager = this.teams.get(teamId);
        if (!manager) {
            manager = new WorkspaceManager(join(this.teamsDir, teamId, "projects"));
            this.teams.set(teamId, manager);
        }
        return manager;
    }

    private static checkTeam(teamId: string): void {
        if (!TeamWorkspaces.TEAM_ID.test(teamId)) {
            throw new AgentError("bad-request", "Invalid team id");
        }
    }
}
