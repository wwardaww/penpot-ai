import type { AgentConfig } from "../AgentConfig";
import { ApiKeyRunner, type ApiKeyTurns, EnvironmentApiKeyTurns } from "./ApiKeyRunner";
import type { ClaudeRunner } from "./ClaudeRunner";
import { CliProcessRunner } from "./CliProcessRunner";
import { FakeRunner, ReplayScript } from "./FakeRunner";
import { LocalCliRunner } from "./LocalCliRunner";

/**
 * Creates the Claude runner chosen by the configuration.
 *
 * @param config - the daemon configuration
 * @param apiKeyTurns - turns of the `api-key` runner (server mode); else the daemon's
 *   `ANTHROPIC_API_KEY`, if set
 */
export function createRunner(config: AgentConfig, apiKeyTurns?: ApiKeyTurns): ClaudeRunner {
    const settings = { mcpUrl: config.mcpUrl, claudePath: config.claudePath, model: config.model };
    switch (config.runner) {
        case "local-cli":
            return new LocalCliRunner(settings);
        case "local-cli-spawn":
            return new CliProcessRunner(settings);
        case "api-key":
            return new ApiKeyRunner(settings, apiKeyTurns ?? EnvironmentApiKeyTurns.fromEnv(process.env));
        case "fake":
            return new FakeRunner(config.fakeRecording ? ReplayScript.fromFile(config.fakeRecording) : undefined);
    }
}
