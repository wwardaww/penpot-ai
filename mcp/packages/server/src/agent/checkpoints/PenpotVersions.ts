import type { WorkflowToolsApi } from "@penpot/mcp-common";
import type { CheckpointFileVersion, DesignRestoreStatus } from "./types";

/** Reply of the restore code run in the plugin. */
interface RestoreReply {
    status: "restoring" | "missing" | "wrong-file";
    fileId?: string | null;
}

/**
 * Penpot file versions ("Version history") of the open file, driven through the MCP plugin with
 * the `execute_code` tool and the Plugin API (`File.saveVersion`, `File.findVersions`,
 * `FileVersion.restore`) — the same backend snapshots Penpot's history panel uses.
 */
export class PenpotVersions {
    /** Longest version label written to Penpot. */
    public static readonly MAX_LABEL_LENGTH = 120;

    /** Turns a JS value of the plugin's `createdAt` into an ISO string (runs in the plugin). */
    private static readonly TO_ISO = `const toIso = (value) => {
    try {
        const date = value instanceof Date ? value : new Date(String(value));
        return isNaN(date.getTime()) ? null : date.toISOString();
    } catch (error) {
        return null;
    }
};`;

    constructor(private readonly tools: WorkflowToolsApi) {}

    /**
     * Builds the Penpot label of a checkpoint's version.
     *
     * @param n - the checkpoint number
     * @param label - the checkpoint label
     */
    public static versionLabel(n: number, label: string): string {
        const text = `AI checkpoint #${n} · ${label.replace(/\s+/g, " ").trim()}`;
        return text.length > PenpotVersions.MAX_LABEL_LENGTH
            ? text.slice(0, PenpotVersions.MAX_LABEL_LENGTH - 1) + "…"
            : text;
    }

    /**
     * Saves the open file as a new version.
     *
     * @param label - the version label
     * @returns the saved version
     * @throws Error if the plugin is not reachable or Penpot refused the version
     */
    public async save(label: string): Promise<CheckpointFileVersion> {
        const reply = await this.run<{ fileId: string; fileName?: string; label: string; createdAt: string | null }>(
            `${PenpotVersions.TO_ISO}
const file = penpot.currentFile;
if (!file) {
    throw new Error("No file is open");
}
const version = await file.saveVersion(${JSON.stringify(label)});
return { fileId: file.id, fileName: file.name, label: version.label, createdAt: toIso(version.createdAt) };`
        );
        if (typeof reply?.fileId !== "string" || typeof reply.label !== "string") {
            throw new Error("Penpot did not report the saved version");
        }
        return {
            fileId: reply.fileId,
            fileName: typeof reply.fileName === "string" ? reply.fileName : undefined,
            label: reply.label,
            createdAt: typeof reply.createdAt === "string" ? reply.createdAt : null,
        };
    }

    /**
     * Starts restoring a version of the open file. The workspace reloads the file and closes the
     * plugin, so the call does not wait for the restore to finish.
     *
     * @param version - the version saved by {@link save}
     * @returns `restoring`, or `missing` when the version is gone (deleted or renamed in Penpot)
     * @throws Error if another file is open or the plugin is not reachable
     */
    public async restore(version: CheckpointFileVersion): Promise<Exclude<DesignRestoreStatus, "skipped">> {
        const reply = await this.run<RestoreReply>(
            `${PenpotVersions.TO_ISO}
const file = penpot.currentFile;
if (!file || file.id !== ${JSON.stringify(version.fileId)}) {
    return { status: "wrong-file", fileId: file ? file.id : null };
}
const label = ${JSON.stringify(version.label)};
const createdAt = ${JSON.stringify(version.createdAt)};
const versions = await file.findVersions();
const version =
    versions.find((candidate) => candidate.label === label) ||
    (createdAt ? versions.find((candidate) => !candidate.isAutosave && toIso(candidate.createdAt) === createdAt) : undefined);
if (!version) {
    return { status: "missing" };
}
const restoring = version.restore();
if (restoring && typeof restoring.catch === "function") {
    restoring.catch(() => undefined);
}
return { status: "restoring" };`
        );
        switch (reply?.status) {
            case "restoring":
            case "missing":
                return reply.status;
            case "wrong-file":
                throw new Error("The checkpoint belongs to another Penpot file; open that file to restore it");
            default:
                throw new Error("Penpot did not report the restore");
        }
    }

    private async run<T>(code: string): Promise<T> {
        const result = await this.tools.call("execute_code", { code });
        if (result.isError) {
            throw new Error(result.text || "The Penpot plugin could not run the code");
        }
        try {
            return JSON.parse(result.text) as T;
        } catch {
            throw new Error(result.text || "The Penpot plugin returned no data");
        }
    }
}
