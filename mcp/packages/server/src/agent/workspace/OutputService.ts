import { existsSync } from "fs";
import { join } from "path";
import type {
    OutputTarget,
    ProjectOutputMessage,
    ProjectOutputPreviewMessage,
    ProjectOutputSetMessage,
    ProjectOutputStatusMessage,
} from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { AgentError, type AgentClient } from "../AgentClient";
import { BuildLock } from "../build/BuildLock";
import { AppFolder } from "./AppFolder";
import { FolderPaths } from "./FolderPaths";
import { type OutputFolders, OutputRefusal, type OutputRequest } from "./OutputFolders";
import type { ProjectOutput } from "./ProjectOutput";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type { ProjectInfo, WorkspaceManager } from "./WorkspaceManager";

/**
 * Handler of the output folder messages (W41): `project.output.status`, `project.output.preview`
 * and `project.output.set`. They need no `context.set`; the dashboard's "Change folder" dialog
 * uses them too.
 */
export class OutputService {
    private readonly logger = createLogger("OutputService");
    private readonly paths = new FolderPaths();

    /**
     * @param folders - folder checks
     * @param workspaces - the project workspaces
     * @param disabledReason - why output folders are not available (server mode), or null
     */
    constructor(
        private readonly folders: OutputFolders,
        private readonly workspaces: WorkspaceManager,
        private readonly disabledReason: string | null = null
    ) {}

    /** Handles `project.output.status`. */
    public async status(client: AgentClient, message: ProjectOutputStatusMessage): Promise<void> {
        const workspace = await this.workspace(message.projectId);
        client.send(await this.reply(message.rid, workspace));
    }

    /** Handles `project.output.preview`: the folder a pick would give. */
    public async preview(client: AgentClient, message: ProjectOutputPreviewMessage): Promise<void> {
        const workspace = await this.workspace(message.projectId);
        const target = await this.folders.target(await this.request(workspace, message));
        client.send(await this.reply(message.rid, workspace, target));
    }

    /** Handles `project.output.set`: uses a picked folder and remembers it. */
    public async set(client: AgentClient, message: ProjectOutputSetMessage): Promise<void> {
        const workspace = await this.workspace(message.projectId);
        const release = message.purpose === "build" ? BuildLock.tryAcquire(workspace.root) : () => undefined;
        if (release === null) {
            throw new OutputRefusal("build-running", "A build of this project is running");
        }
        try {
            const target = await this.folders.create(await this.request(workspace, message));
            let appRoot = workspace.outputFolder?.appRoot ?? null;
            if (message.purpose === "build") {
                try {
                    await AppFolder.prepare(target.path, workspace.projectId, workspace.appSrcDir);
                } catch (error) {
                    this.logger.warn("Could not prepare %s: %s", target.path, String(error));
                    throw new OutputRefusal("not-writable", "Penforge cannot write to this folder");
                }
                appRoot = target.path;
            }
            const output: ProjectOutput = {
                outputRoot: target.path,
                appRoot,
                outputAt: new Date().toISOString(),
            };
            await this.workspaces.setOutput(workspace.projectId, output);
            this.logger.info("Project %s writes to %s (%s)", workspace.projectId, target.path, message.purpose);
            client.send(await this.reply(message.rid, workspace));
        } finally {
            release();
        }
    }

    private async workspace(projectId: string): Promise<ProjectWorkspace> {
        if (this.disabledReason !== null) {
            throw new AgentError("not-configured", this.disabledReason);
        }
        if (!ProjectWorkspace.ID_PATTERN.test(projectId)) {
            throw new AgentError("bad-request", "Invalid project id");
        }
        const workspace = await this.workspaces.get(projectId);
        // a folder that went away (or came back) since the workspace was opened
        workspace.setOutput(workspace.outputFolder);
        return workspace;
    }

    private async request(
        workspace: ProjectWorkspace,
        message: ProjectOutputPreviewMessage | ProjectOutputSetMessage
    ): Promise<OutputRequest> {
        const info = await workspace.readJson<Partial<ProjectInfo> | null>("project.json", null);
        if (info?.platform === "game" || info?.platform === "existing") {
            throw new AgentError("bad-request", "This project works on its linked folder");
        }
        return {
            projectId: workspace.projectId,
            purpose: message.purpose,
            picked: message.path,
            name: message.name ?? info?.projectName ?? "",
            current: workspace.outputFolder,
        };
    }

    private async reply(
        rid: string,
        workspace: ProjectWorkspace,
        target?: OutputTarget
    ): Promise<ProjectOutputMessage> {
        const hasApp = existsSync(join(workspace.appSrcDir, "package.json"));
        const [map, stack] = await Promise.all(
            ["map.json", "stack.json"].map((name) => workspace.readJson<unknown>(name, null).catch(() => null))
        );
        const output = workspace.outputFolder;
        const picked = output?.appRoot ?? null;
        const built = hasApp && map !== null && stack !== null;
        return {
            type: "project.output",
            rid,
            projectId: workspace.projectId,
            app:
                picked !== null
                    ? { state: workspace.appRoot !== null ? "ready" : "missing", path: picked, built }
                    : hasApp || map !== null
                      ? { state: "internal", path: workspace.internalAppDir, built }
                      : { state: "none", path: null, built: false },
            output:
                output === null
                    ? { state: "none", path: null }
                    : {
                          state: this.paths.isRealFolder(output.outputRoot) ? "ready" : "missing",
                          path: output.outputRoot,
                      },
            ...(target ? { target } : {}),
        };
    }
}
