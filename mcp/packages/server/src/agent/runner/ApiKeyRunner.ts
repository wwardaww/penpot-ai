import type { ClaudeRunner, RunnerConversation, RunnerEvent, RunnerInput, RunnerOptions } from "./ClaudeRunner";
import { RunnerNotConfiguredError } from "./ClaudeRunner";

/**
 * Runner for an Anthropic API key (product phase, W24).
 *
 * Not configured yet: every turn fails with `not-configured`. A shipped product must use this runner,
 * because claude.ai logins may not be offered in third-party products.
 */
export class ApiKeyRunner implements ClaudeRunner {
    public readonly kind = "api-key";

    public async *send(
        _conversation: RunnerConversation,
        _input: RunnerInput,
        _opts: RunnerOptions
    ): AsyncIterable<RunnerEvent> {
        throw new RunnerNotConfiguredError("The API key runner is not configured yet");
    }

    public cancel(_conversationId?: string): void {}
}
