/**
 * Penforge agent WebSocket protocol (`ws://127.0.0.1:4410/agent`).
 *
 * Source of truth for the messages exchanged between the browser and the Penforge daemon,
 * mirrored by the frontend in `app.main.data.ai.protocol`. JSON, one object per message; every
 * message has a `type`. Requests carry a client-chosen `rid`, which the replies echo.
 * See `wiki/architecture.md` §5.
 */

/** UI complexity profile of the user (not a security boundary). */
export type Persona = "designer" | "developer";

/** Target platform of a Penpot project. */
export type Platform = "web" | "mobile";

/** Status of a tool call reported by `chat.tool`. */
export type ToolCallStatus = "running" | "done" | "error";

/** Risk level of an action that needs the user's permission. */
export type PermissionRisk = "low" | "medium" | "high";

/** Kind of a `workflow.event`; workflows may define further kinds. */
export type WorkflowEventKind = "progress" | "plan" | "question" | "result" | "log" | (string & {});

// ---------------------------------------------------------------------------------------------
// attachments

/** Design node attached to a chat message. */
export interface NodeAttachment {
    kind: "node";
    fileId: string;
    pageId: string;
    nodeId: string;
    name: string;
    type: string;
    /** PNG snapshot of the node, base64 encoded (no data URL prefix). */
    snapshotPng?: string;
}

/** Canvas comment thread attached to a chat message. */
export interface CommentAttachment {
    kind: "comment";
    threadId: string;
    [key: string]: unknown;
}

/** Image attached to a chat message. */
export interface ImageAttachment {
    kind: "image";
    mime: string;
    /** image bytes, base64 encoded (no data URL prefix) */
    base64: string;
}

/**
 * File the user attached to a chat message (screenshot, image, PDF, text or Markdown file).
 *
 * The client sends the bytes in `base64`; the daemon checks type and size, stores the file in the
 * project folder (`.penforge/uploads/`) and passes it to Claude (images and PDFs as content
 * blocks, text inline). Stored history entries carry `path` instead of the bytes.
 */
export interface FileAttachment {
    kind: "file";
    /** original file name, as shown to the user */
    name: string;
    /** media type; one of {@link FILE_ATTACHMENT_LIMITS} `types` */
    mime: string;
    /** size of the file in bytes */
    size: number;
    /** file bytes, base64 encoded (no data URL prefix); client to daemon only */
    base64?: string;
    /** where the daemon stored the file, relative to the project folder; set by the daemon */
    path?: string;
}

/** Group of accepted attachment files with its own size limit. */
export type FileAttachmentGroup = "image" | "pdf" | "text";

/**
 * Limits of file attachments, shared by the daemon (which enforces them) and the client (which
 * checks them first to give a quick answer). Sizes are in bytes, before base64 encoding.
 */
export const FILE_ATTACHMENT_LIMITS = {
    /** accepted media types and their group */
    types: {
        "image/png": "image",
        "image/jpeg": "image",
        "image/gif": "image",
        "image/webp": "image",
        "application/pdf": "pdf",
        "text/plain": "text",
        "text/markdown": "text",
        "text/csv": "text",
        "application/json": "text",
    } as Record<string, FileAttachmentGroup>,
    /** largest file per group (Claude takes images up to 5 MB) */
    maxBytes: { image: 5 * 1024 * 1024, pdf: 10 * 1024 * 1024, text: 1024 * 1024 } as Record<
        FileAttachmentGroup,
        number
    >,
    /** most files per message */
    maxFiles: 10,
    /** largest total size of the files of one message */
    maxTotalBytes: 20 * 1024 * 1024,
} as const;

export type Attachment = NodeAttachment | CommentAttachment | ImageAttachment | FileAttachment;

// ---------------------------------------------------------------------------------------------
// client -> daemon

export interface AuthMessage {
    type: "auth";
    token: string;
}

/** Context of the browser tab; sent on connect and whenever file, page, persona or platform change. */
export interface ContextSetMessage {
    type: "context.set";
    fileId: string;
    fileName: string;
    projectId: string;
    teamId: string;
    pageId: string;
    persona: Persona;
    platform: Platform;
    /** Penpot MCP plugin session of this tab; MCP tools target it. */
    mcpSessionId?: string;
    /** Penpot project name, used in prompts. */
    projectName?: string;
}

export interface ChatSendMessage {
    type: "chat.send";
    rid: string;
    conversationId: string;
    text: string;
    attachments?: Attachment[];
}

export interface ChatCancelMessage {
    type: "chat.cancel";
    conversationId: string;
}

/** Request for the stored messages of a conversation (e.g. after a page reload). */
export interface ChatHistoryRequestMessage {
    type: "chat.history";
    rid: string;
    conversationId: string;
}

export interface PermissionRespondMessage {
    type: "permission.respond";
    requestId: string;
    allow: boolean;
    remember?: boolean;
}

export interface WorkflowRunMessage {
    type: "workflow.run";
    rid: string;
    /** workflow id, see `wiki/architecture.md` §7; `answer` is built in */
    name: string;
    params?: Record<string, unknown>;
}

export interface WorkflowCancelMessage {
    type: "workflow.cancel";
    runId: string;
}

/**
 * Request to run the dev server of a project's generated app (`app-src/`) and preview it.
 *
 * Idempotent: a running server is reused and its current status is sent again. The project must be
 * the one of the client's `context.set`. The client then receives the `preview.*` messages of that
 * project until it disconnects or starts the preview of another project.
 */
export interface PreviewStartMessage {
    type: "preview.start";
    /** optional request id, echoed by an `error` reply */
    rid?: string;
    projectId: string;
}

/** Request to stop the dev server of a project (all tabs on that project see it stop). */
export interface PreviewStopMessage {
    type: "preview.stop";
    rid?: string;
    projectId: string;
}

export type ClientMessage =
    | AuthMessage
    | ContextSetMessage
    | ChatSendMessage
    | ChatCancelMessage
    | ChatHistoryRequestMessage
    | PermissionRespondMessage
    | WorkflowRunMessage
    | WorkflowCancelMessage
    | PreviewStartMessage
    | PreviewStopMessage;

// ---------------------------------------------------------------------------------------------
// daemon -> client

export interface AuthOkMessage {
    type: "auth.ok";
    daemonVersion: string;
}

export interface AuthErrorMessage {
    type: "auth.error";
    reason: string;
}

export interface ChatDeltaMessage {
    type: "chat.delta";
    conversationId: string;
    messageId: string;
    text: string;
}

export interface ChatToolMessage {
    type: "chat.tool";
    conversationId: string;
    toolName: string;
    summary: string;
    status: ToolCallStatus;
    /** technical detail (input, error text); only shown to the developer persona */
    detail?: string;
}

/** Token usage of one assistant turn. */
export interface ChatUsage {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
}

export interface ChatDoneMessage {
    type: "chat.done";
    conversationId: string;
    messageId: string;
    usage?: ChatUsage;
}

/** Stored chat message, as returned by `chat.history`. */
export interface ChatHistoryEntry {
    role: "user" | "assistant";
    messageId: string;
    text: string;
    ts: string;
    attachments?: Attachment[];
}

export interface ChatHistoryMessage {
    type: "chat.history";
    rid: string;
    conversationId: string;
    messages: ChatHistoryEntry[];
}

export interface PermissionRequestMessage {
    type: "permission.request";
    requestId: string;
    title: string;
    description: string;
    risk: PermissionRisk;
}

export interface WorkflowStartedMessage {
    type: "workflow.started";
    rid: string;
    runId: string;
    name: string;
}

export interface WorkflowEventMessage {
    type: "workflow.event";
    runId: string;
    kind: WorkflowEventKind;
    payload: unknown;
}

export interface WorkflowDoneMessage {
    type: "workflow.done";
    runId: string;
    ok: boolean;
    summary: string;
    error?: string;
}

export interface PreviewReadyMessage {
    type: "preview.ready";
    projectId: string;
    url: string;
}

export interface PreviewStoppedMessage {
    type: "preview.stopped";
    projectId: string;
    url: string;
}

/** State of a project's dev server. */
export type PreviewState = "starting" | "ready" | "stopped" | "failed";

/**
 * Why a dev server is restarting, stopped or failed; the client words it for the user.
 * `restarting` after a crash, `start-timeout` (no HTTP answer in time), `crashed` (gave up after
 * the restarts), `command-failed` (the dev command could not start), `stopped` (`preview.stop`),
 * `project-closed` (no tab watched it for a while), `daemon-stopped`.
 */
export type PreviewReason =
    "restarting" | "start-timeout" | "crashed" | "command-failed" | "stopped" | "project-closed" | "daemon-stopped";

/**
 * Status of a project's dev server; sent on every state change (and on `preview.start` of a
 * client that joins a running server). `preview.ready` / `preview.stopped` are sent as well.
 */
export interface PreviewStatusMessage {
    type: "preview.status";
    projectId: string;
    state: PreviewState;
    /** preview URL once a port is assigned */
    url?: string;
    /** why the server is restarting, failed or stopped (code; see {@link PreviewReason}) */
    reason?: PreviewReason;
    /** technical detail of `reason`, in English (for logs and the developer persona) */
    message?: string;
    /** number of restarts after crashes */
    restarts?: number;
}

/** Output line of a project's dev server; sent only to clients with the developer persona. */
export interface PreviewLogMessage {
    type: "preview.log";
    projectId: string;
    stream: "stdout" | "stderr" | "system";
    text: string;
}

/** Error codes of the `error` message. */
export type AgentErrorCode =
    | "bad-request"
    | "not-authenticated"
    | "no-context"
    | "unknown-type"
    | "unknown-workflow"
    | "busy"
    | "not-configured"
    | "not-implemented"
    | "internal";

export interface ErrorMessage {
    type: "error";
    rid?: string;
    code: AgentErrorCode | (string & {});
    message: string;
}

export type DaemonMessage =
    | AuthOkMessage
    | AuthErrorMessage
    | ChatDeltaMessage
    | ChatToolMessage
    | ChatDoneMessage
    | ChatHistoryMessage
    | PermissionRequestMessage
    | WorkflowStartedMessage
    | WorkflowEventMessage
    | WorkflowDoneMessage
    | PreviewReadyMessage
    | PreviewStoppedMessage
    | PreviewStatusMessage
    | PreviewLogMessage
    | ErrorMessage;

// ---------------------------------------------------------------------------------------------
// workflow questions

export interface QuestionOption {
    id: string;
    label: string;
}

/** Question a workflow asks the user (`workflow.event` kind `question`). */
export interface WorkflowQuestion {
    text: string;
    options: QuestionOption[];
}

/** Payload of a `workflow.event` of kind `question`. */
export interface WorkflowQuestionPayload extends WorkflowQuestion {
    questionId: string;
}

/** Params of the built-in `answer` workflow, which answers a pending question. */
export interface AnswerParams {
    runId: string;
    questionId: string;
    optionId: string;
}

// ---------------------------------------------------------------------------------------------
// daemon workflow API (`mcp/packages/server/src/agent/workflows/<name>.ts`)

/** Context of the browser tab a workflow runs for (from `context.set`). */
export interface AgentContext {
    fileId: string;
    fileName: string;
    projectId: string;
    projectName?: string;
    teamId: string;
    pageId: string;
    persona: Persona;
    platform: Platform;
    mcpSessionId?: string;
}

/** Event emitted by a Claude run. */
export type RunnerEvent =
    | { kind: "session"; sessionId: string }
    | { kind: "text"; messageId: string; text: string }
    | {
          kind: "tool";
          toolUseId: string;
          toolName: string;
          status: ToolCallStatus;
          input?: unknown;
          detail?: string;
      }
    | { kind: "done"; messageId: string; text: string; usage?: ChatUsage }
    | { kind: "error"; message: string };

/**
 * Narrows the tools Claude may use in one workflow turn, on top of the daemon's permission policy.
 */
export interface WorkflowToolFilter {
    /**
     * Checks one tool use.
     *
     * @param toolName - the tool name as Claude calls it (Penpot tools are `mcp__penpot__<name>`)
     * @param input - the tool input
     * @returns null to leave the decision to the daemon's policy, or the reason Claude is told
     *   when the use is denied
     */
    check(toolName: string, input: Record<string, unknown>): string | null;
}

/** Claude turn requested by a workflow. */
export interface WorkflowClaudeRequest {
    /** user prompt of the turn */
    prompt: string;
    /** workflow prompt name (`<name>.prompt.md`), added to the system prompt; defaults to the workflow name */
    promptName?: string;
    /** extra system prompt text */
    systemPromptAppend?: string;
    attachments?: Attachment[];
    /** Claude session to resume */
    resumeSessionId?: string;
    /** receives every runner event of the turn */
    onEvent?: (event: RunnerEvent) => void;
    /** denies tool uses before the daemon's permission policy sees them */
    toolFilter?: WorkflowToolFilter;
}

/** Result of a Claude turn requested by a workflow. */
export interface WorkflowClaudeResult {
    text: string;
    sessionId?: string;
    usage?: ChatUsage;
}

/** Claude runner as seen by a workflow. */
export interface WorkflowRunnerApi {
    run(request: WorkflowClaudeRequest): Promise<WorkflowClaudeResult>;
}

/** Result of an MCP tool call made by a workflow. */
export interface WorkflowToolResult {
    isError: boolean;
    /** MCP content blocks */
    content: unknown[];
    /** concatenated text content */
    text: string;
}

/** Penpot MCP tools as seen by a workflow; the tab's `sessionId` is added automatically. */
export interface WorkflowToolsApi {
    call(toolName: string, args?: Record<string, unknown>): Promise<WorkflowToolResult>;
    list(): Promise<string[]>;
}

/** Git repository of a project. */
export type ProjectRepo = "design" | "app-src";

/** Project folder (`~/Penforge/projects/<id>/`) as seen by a workflow. */
export interface WorkflowWorkspaceApi {
    readonly projectId: string;
    readonly root: string;
    readonly designDir: string;
    readonly appSrcDir: string;
    readonly metaDir: string;
    /** Resolves a path inside the project folder; throws for anything outside. */
    resolve(path: string): string;
    /** Stages and commits every change of a repo; returns the commit hash, or null if clean. */
    commitAll(repo: ProjectRepo, message: string): Promise<string | null>;
    /** Reads `.penforge/<name>`; returns `fallback` when missing. */
    readJson<T>(name: string, fallback: T): Promise<T>;
    /** Writes `.penforge/<name>`. */
    writeJson(name: string, value: unknown): Promise<void>;
}

/** Abort signal, structurally compatible with the platform's `AbortSignal`. */
export interface AbortSignalLike {
    readonly aborted: boolean;
    addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
    removeEventListener(type: "abort", listener: () => void): void;
}

/** Everything a workflow run can use. */
export interface WorkflowContext {
    readonly runId: string;
    readonly context: AgentContext;
    readonly runner: WorkflowRunnerApi;
    readonly tools: WorkflowToolsApi;
    readonly workspace: WorkflowWorkspaceApi;
    /** aborted on `workflow.cancel` or client disconnect */
    readonly signal: AbortSignalLike;
    /** Sends a `workflow.event` to the client. */
    emit(kind: WorkflowEventKind, payload: unknown): void;
    /** Asks the user a question; resolves with the chosen option id. */
    ask(question: WorkflowQuestion): Promise<string>;
}

/** Result of a workflow run, reported in `workflow.done`. */
export interface WorkflowResult {
    summary: string;
}

/** Daemon workflow; each `agent/workflows/<name>.ts` exports one as `workflow`. */
export interface Workflow<P = Record<string, unknown>> {
    /** id used in `workflow.run` */
    name: string;
    description: string;
    run(ctx: WorkflowContext, params: P): Promise<WorkflowResult | void>;
}
