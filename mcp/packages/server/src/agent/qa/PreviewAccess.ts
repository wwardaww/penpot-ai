import type { AbortSignalLike } from "@penpot/mcp-common";
import type { DevServerManager } from "../process/DevServerManager";
import type { LogLine, PreviewStatus } from "../process/DevServer";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";

/** Running app of a project, held open while a QA run uses it. */
export interface PreviewLease {
    /** loopback URL of the dev server */
    readonly url: string;
    /** Lets the dev server go back to its normal idle rules. */
    release(): void;
}

/** Access of the QA to the projects' dev servers. */
export interface PreviewAccess {
    /**
     * Starts the project's dev server (or reuses the running one) and waits until it answers.
     *
     * @throws PreviewUnavailableError when the project has no app or the server does not come up
     */
    acquire(projectId: string, signal?: AbortSignalLike): Promise<PreviewLease>;
}

/** Error when the app cannot be previewed; `code` tells the client why. */
export class PreviewUnavailableError extends Error {
    constructor(
        message: string,
        public readonly code: "not-built" | "no-preview"
    ) {
        super(message);
        this.name = "PreviewUnavailableError";
    }
}

/**
 * {@link PreviewAccess} through the daemon's dev server manager (W09), using only its public API:
 * `start`, `status` and `watch`. The QA watches the server while it runs, so the server does not
 * stop for being idle in the middle of a run.
 */
export class DevServerPreviewAccess implements PreviewAccess {
    /**
     * @param manager - the daemon's dev server manager
     * @param workspaces - gets a project's workspace (the manager needs it to start a server)
     */
    constructor(
        private readonly manager: DevServerManager,
        private readonly workspaces: { get(projectId: string): Promise<ProjectWorkspace> }
    ) {}

    public async acquire(projectId: string, signal?: AbortSignalLike): Promise<PreviewLease> {
        const workspace = await this.workspaces.get(projectId);
        let settle: (status: PreviewStatus) => void = () => {};
        const settled = new Promise<PreviewStatus>((resolve) => {
            settle = resolve;
        });
        const watch = this.manager.watch(workspace.projectId, {
            onStatus: (status) => {
                if (status.state === "ready" || status.state === "failed" || status.state === "stopped") {
                    settle(status);
                }
            },
            onLog: (_line: LogLine) => {},
        });
        const onAbort = () => settle({ state: "stopped", reason: "stopped", restarts: 0 });
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            let status: PreviewStatus;
            try {
                status = await this.manager.start(workspace);
            } catch (error) {
                throw new PreviewUnavailableError(
                    `The app has no dev server yet: ${error instanceof Error ? error.message : String(error)}`,
                    "not-built"
                );
            }
            if (status.state !== "ready") {
                status = await settled;
            }
            if (signal?.aborted) {
                throw new Error("cancelled");
            }
            if (status.state !== "ready" || !status.url) {
                throw new PreviewUnavailableError(
                    `The app preview did not start (${status.reason ?? status.state})${status.message ? `: ${status.message}` : ""}`,
                    "no-preview"
                );
            }
            const url = status.url;
            return { url, release: () => watch.dispose() };
        } catch (error) {
            watch.dispose();
            throw error;
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    }
}
