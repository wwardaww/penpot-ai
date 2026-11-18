import type { ClaudeRunner, RunnerConversation, RunnerEvent, RunnerInput, RunnerOptions } from "./ClaudeRunner";
import { RunnerNotConfiguredError } from "./ClaudeRunner";
import { ClaudeEnvironment } from "./ClaudeEnvironment";
import { LocalCliRunner, type LocalRunnerSettings } from "./LocalCliRunner";

/**
 * Settings of one Claude turn run with an API key: the Claude process environment (API base
 * URL and credentials) and the headers of its MCP connection.
 */
export interface ApiKeyTurn {
    /** complete environment of the Claude process */
    env: Record<string, string>;
    /** headers Claude sends to the Penpot MCP endpoint (multi-user token) */
    mcpHeaders?: Record<string, string>;
    /** model override of the turn */
    model?: string;
    /** ends the turn: revokes its credentials, frees its limit slot */
    end(): void;
}

/**
 * Source of {@link ApiKeyTurn}s (server mode: limits, credential proxy, per-team folders).
 */
export interface ApiKeyTurns {
    /**
     * Prepares a turn for the user of the running request.
     *
     * @throws RunnerNotConfiguredError when no API key is configured
     * @throws AgentError `rate-limited` when a limit is reached
     */
    begin(): Promise<ApiKeyTurn>;
}

/**
 * Turns with the API key of the daemon's own environment (`ANTHROPIC_API_KEY`), for a local
 * install whose user brings a key instead of a `claude` login.
 */
export class EnvironmentApiKeyTurns implements ApiKeyTurns {
    private constructor(private readonly env: NodeJS.ProcessEnv) {}

    /**
     * Gets turns for the environment's key.
     *
     * @param env - the daemon's environment
     * @returns the turns, or null when no key is set
     */
    public static fromEnv(env: NodeJS.ProcessEnv): EnvironmentApiKeyTurns | null {
        return env.ANTHROPIC_API_KEY?.trim() ? new EnvironmentApiKeyTurns(env) : null;
    }

    public async begin(): Promise<ApiKeyTurn> {
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(ClaudeEnvironment.forChild(this.env))) {
            if (value !== undefined) {
                env[name] = value;
            }
        }
        return { env, end: () => {} };
    }
}

/**
 * Runner for an Anthropic API key (product and server mode).
 *
 * Runs the same Claude Agent SDK loop as the local runner, but each turn gets its environment
 * from {@link ApiKeyTurns}: no `claude` login is used, and in server mode the real key stays in
 * the daemon's credential proxy. Without turns (no API key setup) every turn fails with
 * `not-configured`. A shipped product must use this runner, because claude.ai logins may not
 * be offered in third-party products.
 */
export class ApiKeyRunner implements ClaudeRunner {
    public readonly kind = "api-key";
    private readonly inner: LocalCliRunner;

    /**
     * @param settings - MCP endpoint, Claude executable and model
     * @param turns - prepares each turn; none when the runner is not set up
     */
    constructor(
        settings: LocalRunnerSettings,
        private readonly turns: ApiKeyTurns | null = null
    ) {
        this.inner = new LocalCliRunner(settings);
    }

    public async *send(
        conversation: RunnerConversation,
        input: RunnerInput,
        opts: RunnerOptions
    ): AsyncIterable<RunnerEvent> {
        if (!this.turns) {
            throw new RunnerNotConfiguredError("The API key runner is not configured");
        }
        const turn = await this.turns.begin();
        try {
            yield* this.inner.send(conversation, input, {
                ...opts,
                env: turn.env,
                mcpHeaders: turn.mcpHeaders,
                model: turn.model ?? opts.model,
            });
        } finally {
            turn.end();
        }
    }

    public cancel(conversationId?: string): void {
        this.inner.cancel(conversationId);
    }
}
