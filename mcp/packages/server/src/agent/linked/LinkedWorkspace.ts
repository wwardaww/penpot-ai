import type { WorkflowContext, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import type { ProjectLink } from "./ProjectLink";

/** Workspace of a project that may be linked to a folder (the daemon's `ProjectWorkspace`). */
export interface LinkableWorkspace extends WorkflowWorkspaceApi {
    readonly linked: ProjectLink | null;
    readonly linkedRoot: string | null;
    setLink(link: ProjectLink | null): void;
}

/** State of a workflow's linked folder. */
export type LinkedFolderState =
    | { state: "linked"; workspace: LinkableWorkspace; link: ProjectLink; root: string }
    | { state: "not-linked"; reason: "none" | "missing"; link: ProjectLink | null };

/** Access to the linked folder of a workflow's project (W38). */
export class LinkedWorkspace {
    /**
     * Gets the linked folder of the run's project, checking again that it still exists.
     *
     * @param ctx - the workflow context
     */
    public static of(ctx: Pick<WorkflowContext, "workspace">): LinkedFolderState {
        const workspace = ctx.workspace as Partial<LinkableWorkspace>;
        if (typeof workspace.setLink !== "function" || workspace.linked === undefined) {
            return { state: "not-linked", reason: "none", link: null };
        }
        const linkable = workspace as LinkableWorkspace;
        const link = linkable.linked;
        if (link === null) {
            return { state: "not-linked", reason: "none", link: null };
        }
        linkable.setLink(link);
        const root = linkable.linkedRoot;
        if (root === null) {
            return { state: "not-linked", reason: "missing", link };
        }
        return { state: "linked", workspace: linkable, link, root };
    }
}
