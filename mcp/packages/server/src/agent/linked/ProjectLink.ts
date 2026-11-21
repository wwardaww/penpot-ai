import type { DetectedStack, GameEngine, LinkedProjectKind } from "@penpot/mcp-common";

/**
 * Link of a project to a folder of this computer (W38), as kept in `.penforge/project.json`
 * (`linkedRoot`, `linkedKind`, `engine`, `stack`, `linkedAt`). Machine-local: never sent to the
 * Penpot backend.
 */
export interface ProjectLink {
    kind: LinkedProjectKind;
    /** real path of the linked folder */
    root: string;
    engine: GameEngine | null;
    stack: DetectedStack | null;
    /** ISO time of the link */
    linkedAt: string;
}

/** Fields of `project.json` that hold a {@link ProjectLink}. */
export interface ProjectLinkFields {
    linkedRoot?: string;
    linkedKind?: LinkedProjectKind;
    engine?: GameEngine | null;
    stack?: DetectedStack | null;
    linkedAt?: string;
}

/** Conversion between {@link ProjectLink} and the `project.json` fields. */
export class ProjectLinkRecord {
    /**
     * Reads the link from `project.json` fields.
     *
     * @param fields - the parsed `project.json` (or null)
     * @returns the link, or null when the fields hold none or are malformed
     */
    public static read(fields: ProjectLinkFields | null | undefined): ProjectLink | null {
        if (!fields || typeof fields.linkedRoot !== "string" || fields.linkedRoot.length === 0) {
            return null;
        }
        if (fields.linkedKind !== "game" && fields.linkedKind !== "existing") {
            return null;
        }
        const engine = fields.engine === "unity" || fields.engine === "unreal" ? fields.engine : null;
        const stack =
            fields.stack &&
            (fields.stack.platform === "web" || fields.stack.platform === "mobile") &&
            typeof fields.stack.name === "string"
                ? { platform: fields.stack.platform, name: fields.stack.name }
                : null;
        return {
            kind: fields.linkedKind,
            root: fields.linkedRoot,
            engine,
            stack,
            linkedAt: typeof fields.linkedAt === "string" ? fields.linkedAt : "",
        };
    }

    /**
     * Gets the `project.json` fields of a link.
     *
     * @param link - the link
     */
    public static fields(link: ProjectLink): Required<ProjectLinkFields> {
        return {
            linkedRoot: link.root,
            linkedKind: link.kind,
            engine: link.engine,
            stack: link.stack,
            linkedAt: link.linkedAt,
        };
    }
}
