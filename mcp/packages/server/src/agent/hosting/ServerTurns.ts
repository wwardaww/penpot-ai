import { mkdir } from "fs/promises";
import { join } from "path";
import { AgentError } from "../AgentClient";
import { ChildEnvironment } from "../build/ChildEnvironment";
import type { ApiKeyTurn, ApiKeyTurns } from "../runner/ApiKeyRunner";
import { RunnerNotConfiguredError } from "../runner/ClaudeRunner";
import type { ApiKeyProxy } from "./ApiKeyProxy";
import type { ServerStore } from "./ServerStore";
import type { TurnLimiter } from "./TurnLimiter";
import { UserScope } from "./UserScope";

/**
 * Turns of the API key runner in server mode.
 *
 * Each turn belongs to the user of the running request ({@link UserScope}): it passes the
 * limits, gets a ticket of the credential proxy instead of the API key, a Claude config folder
 * of its team and the user's plugin bridge token for the MCP connection.
 */
export class ServerTurns implements ApiKeyTurns {
    /**
     * @param store - API keys and settings
     * @param limiter - per-user limits
     * @param proxy - credential proxy
     * @param claudeConfigDir - folder of the per-team Claude config folders
     * @param bridgeToken - plugin bridge token of a profile
     */
    constructor(
        private readonly store: ServerStore,
        private readonly limiter: TurnLimiter,
        private readonly proxy: ApiKeyProxy,
        private readonly claudeConfigDir: string,
        private readonly bridgeToken: (profileId: string) => string
    ) {}

    public async begin(): Promise<ApiKeyTurn> {
        const scope = UserScope.current();
        if (!scope) {
            throw new AgentError("not-authenticated", "AI requests need a logged-in Penpot user");
        }
        const owner = { profileId: scope.user.profileId, teamId: scope.teamId };
        const apiKey = await this.store.apiKey(scope.teamId);
        if (!apiKey) {
            throw new RunnerNotConfiguredError(
                "No Anthropic API key is set on this server. Ask your admin to add one on the Penforge admin page."
            );
        }
        const settings = await this.store.settings();
        const permit = await this.limiter.acquire(owner);
        try {
            const configDir = join(this.claudeConfigDir, scope.teamId ?? "no-team");
            await mkdir(configDir, { recursive: true, mode: 0o700 });
            const ticket = this.proxy.issue(owner, apiKey);
            return {
                env: ChildEnvironment.scrub(process.env, {
                    ANTHROPIC_BASE_URL: ticket.baseUrl,
                    ANTHROPIC_API_KEY: ticket.value,
                    CLAUDE_CONFIG_DIR: configDir,
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                    DISABLE_AUTOUPDATER: "1",
                }),
                mcpHeaders: { Authorization: `Bearer ${this.bridgeToken(owner.profileId)}` },
                model: settings.model,
                end: () => {
                    ticket.revoke();
                    permit.release();
                },
            };
        } catch (error) {
            permit.release();
            throw error;
        }
    }
}
