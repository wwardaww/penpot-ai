import type { CommandPolicy } from "./CommandPolicy";
import type { StackConfig } from "./StackConfig";

/**
 * Something a dev server runs for, other than a project's generated app (W39: an app folder of a
 * Re-Designed Existing project, listed on the dashboard).
 *
 * The {@link DevServerManager} keeps one server per {@link projectId}; for these targets it is the
 * dashboard app id, which never equals a project id, so they never share a server with the
 * workspace preview of a project.
 */
export interface DevServerTarget {
    /** key of the dev server (a dashboard app id) */
    readonly projectId: string;

    /**
     * Reads the dev server settings.
     *
     * @param policy - rules for the dev command
     * @throws AgentError when the target cannot run
     */
    devStack(policy: CommandPolicy): Promise<StackConfig>;
}
