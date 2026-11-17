import { join } from "path";
import { AgentError } from "../AgentClient";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";

/** Content of `.penforge/stack.json` as far as the dev server is concerned (see `wiki/architecture.md` §4). */
interface StackFile {
    name?: unknown;
    dev?: unknown;
    devCommand?: unknown;
    portEnv?: unknown;
    cwd?: unknown;
    readyPath?: unknown;
    readyTimeoutS?: unknown;
}

/**
 * Dev server settings of a project's generated app, read from `.penforge/stack.json`.
 *
 * The build pipeline (W08) writes the file. The dev command is a shell command run in `app-src/`
 * (or in `cwd` below it); `{port}` in it is replaced by the assigned port, which is also passed in
 * the environment variable `portEnv` (default `PORT`).
 */
export class StackConfig {
    /** Name of the metadata file below `.penforge/`. */
    public static readonly FILE = "stack.json";

    private static readonly ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
    private static readonly PORT_PLACEHOLDER = /\{port\}/g;
    private static readonly DEFAULT_READY_TIMEOUT_S = 120;
    private static readonly MAX_READY_TIMEOUT_S = 900;

    /**
     * @param name - stack name, for logs
     * @param devCommand - shell command that starts the dev server
     * @param portEnv - environment variable receiving the port
     * @param cwd - absolute folder to run the command in
     * @param readyPath - path probed over HTTP to detect readiness
     * @param readyTimeoutMs - time the server has to answer the probe
     */
    constructor(
        public readonly name: string,
        public readonly devCommand: string,
        public readonly portEnv: string,
        public readonly cwd: string,
        public readonly readyPath: string,
        public readonly readyTimeoutMs: number
    ) {}

    /**
     * Reads the stack settings of a project.
     *
     * @param workspace - the project workspace
     * @throws AgentError `not-configured` when no app was generated yet, `bad-request` when the file is invalid
     */
    public static async load(workspace: ProjectWorkspace): Promise<StackConfig> {
        const file = await workspace
            .readJson<StackFile | null>(StackConfig.FILE, null)
            .catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") {
                    // the project folder itself is missing
                    return null;
                }
                throw new AgentError("bad-request", `Cannot read ${StackConfig.FILE}: ${error.message}`);
            });
        if (file === null) {
            throw new AgentError("not-configured", "There is no generated app for this project yet");
        }
        return StackConfig.parse(file, workspace);
    }

    /**
     * Validates the content of a stack file.
     *
     * @param file - the parsed JSON
     * @param workspace - the project workspace (resolves `cwd`)
     */
    public static parse(file: StackFile, workspace: Pick<ProjectWorkspace, "appSrcDir" | "resolve">): StackConfig {
        if (typeof file !== "object" || file === null || Array.isArray(file)) {
            throw new AgentError("bad-request", `${StackConfig.FILE} must hold an object`);
        }
        const command = file.dev ?? file.devCommand;
        if (typeof command !== "string" || command.trim().length === 0) {
            throw new AgentError("bad-request", `${StackConfig.FILE} has no dev command ("dev")`);
        }
        const portEnv = file.portEnv ?? "PORT";
        if (typeof portEnv !== "string" || !StackConfig.ENV_NAME.test(portEnv)) {
            throw new AgentError("bad-request", `${StackConfig.FILE}: invalid portEnv`);
        }
        const relativeCwd = file.cwd ?? ".";
        if (typeof relativeCwd !== "string") {
            throw new AgentError("bad-request", `${StackConfig.FILE}: invalid cwd`);
        }
        let cwd: string;
        try {
            cwd = workspace.resolve(join(workspace.appSrcDir, relativeCwd));
        } catch {
            throw new AgentError("bad-request", `${StackConfig.FILE}: cwd is outside the project`);
        }
        const readyPath = file.readyPath ?? "/";
        if (typeof readyPath !== "string" || !readyPath.startsWith("/")) {
            throw new AgentError("bad-request", `${StackConfig.FILE}: readyPath must start with /`);
        }
        const timeout = file.readyTimeoutS ?? StackConfig.DEFAULT_READY_TIMEOUT_S;
        if (typeof timeout !== "number" || !(timeout > 0)) {
            throw new AgentError("bad-request", `${StackConfig.FILE}: invalid readyTimeoutS`);
        }
        const name = typeof file.name === "string" ? file.name : "app";
        return new StackConfig(
            name,
            command,
            portEnv,
            cwd,
            readyPath,
            Math.min(timeout, StackConfig.MAX_READY_TIMEOUT_S) * 1000
        );
    }

    /**
     * Gets the dev command for a port.
     *
     * @param port - the assigned port
     */
    public commandFor(port: number): string {
        return this.devCommand.replace(StackConfig.PORT_PLACEHOLDER, String(port));
    }
}
