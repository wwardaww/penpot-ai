import { resolve } from "path";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { ProjectWorkspace } from "../../workspace/ProjectWorkspace";

/** The design system a project uses: `designSystem` in `.penforge/project.json` (W30). */
export interface DesignSystemBinding {
    /** the design system file (a Penpot shared library) */
    fileId: string;
    name: string;
    /** the team project that holds it ("Design Systems") */
    projectId: string;
    /** what the client knew of the library when it was linked (Penpot `revn`), or null */
    version: string | null;
    /** ISO 8601 */
    linkedAt: string;
    /** the design system used before a switch */
    previous: { fileId: string; name: string; projectId: string } | null;
    /** the user chose to re-design later ("Apply design system" in the AI menu) */
    redesignPending: boolean;
    /** files of the project linked to the library so far */
    linkedFiles: string[];
}

/** Id format of Penpot files and projects. */
const ID = /^[0-9a-fA-F-]{8,64}$/;

/**
 * Reads and writes the binding in `.penforge/project.json`, keeping the other keys of the file
 * (W01's `WorkspaceManager` writes them on every `context.set`).
 */
export class BindingStore {
    public static readonly KEY = "designSystem";
    private static readonly FILE = "project.json";

    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    public async read(): Promise<DesignSystemBinding | null> {
        const info = await this.workspace.readJson<Record<string, unknown> | null>(BindingStore.FILE, null);
        return BindingStore.parse(info?.[BindingStore.KEY]);
    }

    public async write(binding: DesignSystemBinding): Promise<void> {
        const info = (await this.workspace.readJson<Record<string, unknown> | null>(BindingStore.FILE, null)) ?? {};
        await this.workspace.writeJson(BindingStore.FILE, { ...info, [BindingStore.KEY]: binding });
    }

    public async clear(): Promise<void> {
        const info = (await this.workspace.readJson<Record<string, unknown> | null>(BindingStore.FILE, null)) ?? {};
        delete info[BindingStore.KEY];
        await this.workspace.writeJson(BindingStore.FILE, info);
    }

    /** A stored binding, or null when it is missing or malformed. */
    public static parse(value: unknown): DesignSystemBinding | null {
        if (!value || typeof value !== "object") {
            return null;
        }
        const v = value as Partial<DesignSystemBinding>;
        if (
            typeof v.fileId !== "string" ||
            !ID.test(v.fileId) ||
            typeof v.projectId !== "string" ||
            !ID.test(v.projectId)
        ) {
            return null;
        }
        const previous =
            v.previous && typeof v.previous === "object" && typeof v.previous.fileId === "string" ? v.previous : null;
        return {
            fileId: v.fileId,
            name: typeof v.name === "string" ? v.name : "",
            projectId: v.projectId,
            version: typeof v.version === "string" ? v.version : null,
            linkedAt: typeof v.linkedAt === "string" ? v.linkedAt : "",
            previous,
            redesignPending: v.redesignPending === true,
            linkedFiles: Array.isArray(v.linkedFiles) ? v.linkedFiles.filter((id) => typeof id === "string") : [],
        };
    }
}

/**
 * The workspace of another Penforge project next to this one (the "Design Systems" project of
 * the team), read through the same path guard rules.
 *
 * @param workspace - the open project's workspace (`<home>/projects/<id>`)
 * @param projectId - the other project
 */
export function siblingWorkspace(workspace: WorkflowWorkspaceApi, projectId: string): ProjectWorkspace {
    if (projectId === workspace.projectId && workspace instanceof ProjectWorkspace) {
        return workspace;
    }
    return new ProjectWorkspace(resolve(workspace.root, ".."), projectId);
}
