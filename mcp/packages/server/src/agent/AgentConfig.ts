import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Version of the Penforge daemon, reported in `auth.ok` and `/health`. */
export const PENFORGE_DAEMON_VERSION = "0.1.0";

/**
 * Kind of Claude runner.
 *
 * `local-cli` drives the user's local Claude Code login through the Claude Agent SDK, `local-cli-spawn`
 * spawns `claude -p` directly (no interactive permissions), `api-key` is the product runner (not configured
 * yet) and `fake` replies with canned text (for frontend work without Claude).
 */
export type RunnerKind = "local-cli" | "local-cli-spawn" | "api-key" | "fake";

const RUNNER_KINDS: RunnerKind[] = ["local-cli", "local-cli-spawn", "api-key", "fake"];

/** Settings read from `<PENFORGE_HOME>/config.json`; environment variables take precedence. */
interface ConfigFile {
    host?: string;
    port?: number;
    allowedOrigins?: string[];
    publicUri?: string;
    runner?: RunnerKind;
    claudePath?: string;
    model?: string;
    requirePairing?: boolean;
}

/**
 * Settings of the Penforge daemon.
 *
 * Built from environment variables, then `<PENFORGE_HOME>/config.json`, then defaults. Nothing that
 * depends on the host machine is hard-coded, so the daemon runs as a desktop child process or as a
 * standalone server.
 */
export class AgentConfig {
    /** Penforge data folder (`PENFORGE_HOME`, default `~/Penforge`). */
    public readonly home: string;
    /** Interface the agent endpoint binds to (`PENFORGE_AGENT_HOST`, default `127.0.0.1`). */
    public readonly host: string;
    /** Port of the agent endpoint (`PENFORGE_AGENT_PORT`, default 4410). */
    public readonly port: number;
    /** Browser origins allowed to connect (`PENFORGE_ALLOWED_ORIGINS`, comma separated). */
    public readonly allowedOrigins: string[];
    /** Public URI of the Penpot frontend, used for the pairing URL (`PENFORGE_PUBLIC_URI`). */
    public readonly publicUri: string;
    /** Claude runner kind (`PENFORGE_RUNNER`). */
    public readonly runner: RunnerKind;
    /** Path of the `claude` executable (`PENFORGE_CLAUDE_PATH`); the SDK's bundled one when unset. */
    public readonly claudePath?: string;
    /** Claude model override (`PENFORGE_CLAUDE_MODEL`). */
    public readonly model?: string;
    /** Fixed pairing token (`PENFORGE_TOKEN`), for development only; random per start when unset. */
    public readonly fixedToken?: string;
    /** URL of the Penpot MCP endpoint the runner connects Claude to. */
    public readonly mcpUrl: string;
    /**
     * Whether browser sessions must present the pairing token (`PENFORGE_REQUIRE_PAIRING=1`).
     *
     * Off by default: the WebSocket upgrade already requires an allowed `Origin`, which web pages
     * cannot forge, so a page of the Penforge frontend connects without a manual pairing step.
     * Penpot plugins share that origin but get no WebSocket in their sandbox, and the token is
     * never handed to a page. Turn it on when the daemon is reachable by other people (hosting).
     */
    public readonly requirePairing: boolean;

    constructor(values: {
        home: string;
        host: string;
        port: number;
        allowedOrigins: string[];
        publicUri: string;
        runner: RunnerKind;
        claudePath?: string;
        model?: string;
        fixedToken?: string;
        mcpUrl: string;
        requirePairing?: boolean;
    }) {
        this.home = values.home;
        this.host = values.host;
        this.port = values.port;
        this.allowedOrigins = values.allowedOrigins.map((origin) => AgentConfig.normalizeOrigin(origin));
        this.publicUri = values.publicUri.replace(/\/+$/, "");
        this.runner = values.runner;
        this.claudePath = values.claudePath;
        this.model = values.model;
        this.fixedToken = values.fixedToken;
        this.mcpUrl = values.mcpUrl;
        this.requirePairing = values.requirePairing ?? false;
    }

    /**
     * Builds the configuration from environment variables and the optional config file.
     *
     * @param env - the environment
     * @param mcpUrl - URL of the Penpot MCP endpoint of this process
     */
    public static load(env: Record<string, string | undefined>, mcpUrl: string): AgentConfig {
        const home = AgentConfig.nonBlank(env.PENFORGE_HOME) ?? join(homedir(), "Penforge");
        const file = AgentConfig.readConfigFile(join(home, "config.json"));
        const allowedOrigins = AgentConfig.nonBlank(env.PENFORGE_ALLOWED_ORIGINS)
            ?.split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0) ??
            file.allowedOrigins ?? ["https://localhost:3449"];
        const runner = (AgentConfig.nonBlank(env.PENFORGE_RUNNER) ?? file.runner ?? "local-cli") as RunnerKind;
        if (!RUNNER_KINDS.includes(runner)) {
            throw new Error(`Unknown PENFORGE_RUNNER ${JSON.stringify(runner)}; use one of ${RUNNER_KINDS.join(", ")}`);
        }
        return new AgentConfig({
            home,
            host: AgentConfig.nonBlank(env.PENFORGE_AGENT_HOST) ?? file.host ?? "127.0.0.1",
            port: parseInt(AgentConfig.nonBlank(env.PENFORGE_AGENT_PORT) ?? String(file.port ?? 4410), 10),
            allowedOrigins,
            publicUri: AgentConfig.nonBlank(env.PENFORGE_PUBLIC_URI) ?? file.publicUri ?? allowedOrigins[0],
            runner,
            claudePath: AgentConfig.nonBlank(env.PENFORGE_CLAUDE_PATH) ?? file.claudePath,
            model: AgentConfig.nonBlank(env.PENFORGE_CLAUDE_MODEL) ?? file.model,
            fixedToken: AgentConfig.nonBlank(env.PENFORGE_TOKEN),
            mcpUrl,
            requirePairing: AgentConfig.flag(env.PENFORGE_REQUIRE_PAIRING) ?? file.requirePairing ?? false,
        });
    }

    /**
     * Normalizes an origin for comparison: lower case, no trailing slash.
     *
     * @param origin - an origin such as `https://localhost:3449`
     */
    public static normalizeOrigin(origin: string): string {
        return origin.trim().replace(/\/+$/, "").toLowerCase();
    }

    /** Folder holding the per-project folders. */
    public get projectsDir(): string {
        return join(this.home, "projects");
    }

    private static flag(value: string | undefined): boolean | undefined {
        const v = AgentConfig.nonBlank(value)?.toLowerCase();
        return v === undefined ? undefined : ["1", "true", "yes", "on"].includes(v);
    }

    private static nonBlank(value: string | undefined): string | undefined {
        const trimmed = value?.trim();
        return trimmed ? trimmed : undefined;
    }

    private static readConfigFile(path: string): ConfigFile {
        if (!existsSync(path)) {
            return {};
        }
        try {
            return JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
        } catch (error) {
            throw new Error(`Invalid Penforge config file ${path}: ${String(error)}`);
        }
    }
}
