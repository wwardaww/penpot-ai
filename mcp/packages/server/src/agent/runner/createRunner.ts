import type { AgentConfig } from "../AgentConfig";
import { ApiKeyRunner } from "./ApiKeyRunner";
import type { ClaudeRunner } from "./ClaudeRunner";
import { CliProcessRunner } from "./CliProcessRunner";
import { FakeRunner } from "./FakeRunner";
import { LocalCliRunner } from "./LocalCliRunner";

/**
 * Creates the Claude runner chosen by the configuration.
 *
 * @param config - the daemon configuration
 */
export function createRunner(config: AgentConfig): ClaudeRunner {
    const settings = { mcpUrl: config.mcpUrl, claudePath: config.claudePath, model: config.model };
    switch (config.runner) {
        case "local-cli":
            return new LocalCliRunner(settings);
        case "local-cli-spawn":
            return new CliProcessRunner(settings);
        case "api-key":
            return new ApiKeyRunner();
        case "fake":
            return new FakeRunner();
    }
}
