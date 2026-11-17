import type { RunnerEvent } from "@penpot/mcp-common";

export type { RunnerEvent };

/** Conversation a Claude turn belongs to. */
export interface RunnerConversation {
    /** conversation id chosen by the client */
    id: string;
    /** Claude session to resume, if the conversation has one */
    resumeSessionId?: string;
}

/** Image passed to Claude with the user's text. */
export interface RunnerImage {
    mime: string;
    /** image bytes, base64 encoded */
    base64: string;
}

/** User input of a Claude turn. */
export interface RunnerInput {
    text: string;
    images?: RunnerImage[];
}

/** Tool use Claude asks permission for. */
export interface ToolUseRequest {
    toolName: string;
    input: Record<string, unknown>;
    signal: AbortSignal;
}

/** Decision on a tool use. */
export type ToolUseDecision =
    { allow: true; updatedInput?: Record<string, unknown> } | { allow: false; message: string };

/**
 * Policy deciding whether Claude may use a tool.
 */
export interface ToolPermissionHandler {
    decide(request: ToolUseRequest): Promise<ToolUseDecision>;
}

/** Options of a Claude turn. */
export interface RunnerOptions {
    /** working directory of Claude (the project folder) */
    cwd: string;
    /** text appended to Claude's system prompt */
    systemPromptAppend: string;
    /** policy for tool uses */
    permissions: ToolPermissionHandler;
    /** aborts the turn */
    signal?: AbortSignal;
}

/**
 * Runner of Claude turns.
 *
 * Implementations stream the events of one turn; a turn ends with a `done` or an `error` event.
 */
export interface ClaudeRunner {
    /** short name of the runner, reported in `/health` */
    readonly kind: string;

    /**
     * Runs one Claude turn.
     *
     * @param conversation - the conversation, with the Claude session to resume
     * @param input - the user's input
     * @param opts - options of the turn
     */
    send(conversation: RunnerConversation, input: RunnerInput, opts: RunnerOptions): AsyncIterable<RunnerEvent>;

    /**
     * Cancels running turns.
     *
     * @param conversationId - the conversation whose turn to cancel; all turns when omitted
     */
    cancel(conversationId?: string): void;
}

/**
 * Error raised by a runner that cannot be used in the current configuration.
 */
export class RunnerNotConfiguredError extends Error {
    public readonly code = "not-configured";

    constructor(message: string) {
        super(message);
        this.name = "RunnerNotConfiguredError";
    }
}
