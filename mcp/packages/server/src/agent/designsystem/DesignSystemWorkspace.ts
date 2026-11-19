import { join } from "path";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { DesignMdRepository } from "../designmd";

/** File id format accepted for a design system folder (Penpot uuids). */
const FILE_ID = /^[0-9a-fA-F-]{8,64}$/;

/** Folder of the design systems inside a project's `design/` repo. */
export const DESIGN_SYSTEMS_DIR = "systems";

/**
 * The project workspace as a design system file sees it: same project, but `designDir` is
 * `design/systems/<file-id>/`, so that W22's {@link DesignMdRepository} reads and commits that
 * file's DESIGN.md (several design systems share the "Design Systems" project). Git still runs in
 * the project's `design/` repository (a sub folder of it).
 *
 * @param workspace - the project workspace
 * @param fileId - the design system file
 */
export function designSystemWorkspace(workspace: WorkflowWorkspaceApi, fileId: string): WorkflowWorkspaceApi {
    if (!FILE_ID.test(fileId)) {
        throw new Error(`Invalid file id: ${fileId}`);
    }
    const designDir = workspace.resolve(join(workspace.designDir, DESIGN_SYSTEMS_DIR, fileId.toLowerCase()));
    return {
        projectId: workspace.projectId,
        root: workspace.root,
        designDir,
        appSrcDir: workspace.appSrcDir,
        metaDir: workspace.metaDir,
        resolve: (path: string) => workspace.resolve(path),
        commitAll: (repo, message) => workspace.commitAll(repo, message),
        readJson: (name, fallback) => workspace.readJson(name, fallback),
        writeJson: (name, value) => workspace.writeJson(name, value),
    };
}

/**
 * The DESIGN.md repository of a design system file (W30 reads a linked design system's
 * DESIGN.md through this).
 *
 * @param workspace - the workspace of the project that holds the design system file
 * @param fileId - the design system file
 */
export function designSystemDesignMd(workspace: WorkflowWorkspaceApi, fileId: string): DesignMdRepository {
    return new DesignMdRepository(designSystemWorkspace(workspace, fileId));
}
