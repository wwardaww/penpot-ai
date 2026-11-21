import type {
    FolderListMessage,
    FontsFilesMessage,
    ProjectLinkedMessage,
    ProjectLinkMessage,
    ProjectLinkStatusMessage,
} from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { AgentError, type AgentClient } from "../AgentClient";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import type { WorkspaceManager } from "../workspace/WorkspaceManager";
import type { LinkedFolders } from "./LinkedFolders";
import type { ProjectLink } from "./ProjectLink";
import { ProjectFonts, type ProjectFontsInfo } from "./ProjectFonts";

/**
 * Handler of the folder browser and project link messages (W38): `folder.list`, `project.link`,
 * `project.link.status`. They need no `context.set`; the dashboard's create dialog uses them
 * before the project's workspace was ever opened.
 */
export class LinkService {
    private readonly logger = createLogger("LinkService");

    /**
     * @param folders - folder checks and listings
     * @param workspaces - the project workspaces
     * @param disabledReason - why links are not available (server mode), or null
     */
    constructor(
        private readonly folders: LinkedFolders,
        private readonly workspaces: WorkspaceManager,
        private readonly disabledReason: string | null = null
    ) {}

    /** Handles `folder.list`. */
    public async list(client: AgentClient, message: FolderListMessage): Promise<void> {
        this.checkEnabled();
        client.send(await this.folders.list(message.rid, message.path));
    }

    /** Handles `project.link`: checks the folder, then stores the link in `project.json`. */
    public async link(client: AgentClient, message: ProjectLinkMessage): Promise<void> {
        this.checkEnabled();
        LinkService.checkProjectId(message.projectId);
        const { root, facts } = await this.folders.accept(message.kind, message.path);
        const link: ProjectLink = {
            kind: message.kind,
            root,
            engine: message.kind === "game" ? facts.engine : null,
            stack: message.kind === "existing" ? facts.stack : null,
            linkedAt: new Date().toISOString(),
        };
        await this.workspaces.setLink(message.projectId, link);
        this.logger.info("Project %s linked to %s (%s)", message.projectId, root, message.kind);
        client.send(LinkService.reply(message.rid, message.projectId, link));
    }

    /** Handles `project.link.status`. */
    public async status(client: AgentClient, message: ProjectLinkStatusMessage): Promise<void> {
        this.checkEnabled();
        LinkService.checkProjectId(message.projectId);
        const workspace = await this.workspaces.get(message.projectId);
        // a folder that went away (or came back) since the workspace was opened
        workspace.setLink(workspace.linked);
        const link = workspace.linkedRoot !== null ? workspace.linked : null;
        client.send(LinkService.reply(message.rid, message.projectId, link));
    }

    /** Handles `fonts.files`: the font files of the linked folder, for the import into the team's fonts. */
    public async fonts(client: AgentClient, message: FontsFilesMessage): Promise<void> {
        this.checkEnabled();
        LinkService.checkProjectId(message.projectId);
        const workspace = await this.workspaces.get(message.projectId);
        const info = await workspace.readJson<ProjectFontsInfo | null>(ProjectFonts.FILE, null);
        const root = workspace.linkedRoot;
        const files = info !== null && root !== null ? await ProjectFonts.filesToSend(root, info) : [];
        client.send({
            type: "fonts.files",
            rid: message.rid,
            projectId: message.projectId,
            files,
            google: info?.google ?? [],
        });
    }

    private checkEnabled(): void {
        if (this.disabledReason !== null) {
            throw new AgentError("not-configured", this.disabledReason);
        }
    }

    private static checkProjectId(projectId: string): void {
        if (!ProjectWorkspace.ID_PATTERN.test(projectId)) {
            throw new AgentError("bad-request", "Invalid project id");
        }
    }

    private static reply(rid: string, projectId: string, link: ProjectLink | null): ProjectLinkedMessage {
        if (link === null) {
            return { type: "project.linked", rid, projectId, linked: false };
        }
        return {
            type: "project.linked",
            rid,
            projectId,
            linked: true,
            kind: link.kind,
            linkedRoot: link.root,
            engine: link.engine,
            stack: link.stack,
        };
    }
}
