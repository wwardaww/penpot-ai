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

/**
 * Type of a Penpot project: the platform of the app it designs (`web`, `mobile`), or a project
 * linked to a folder on this computer (W38): the UI of a Unity / Unreal game (`game`), or a new
 * look for an existing app (`existing`).
 */
export type Platform = "web" | "mobile" | "game" | "existing";

/** Project types linked to a folder on this computer (W38). */
export type LinkedProjectKind = "game" | "existing";

/** Platform of designed screens where a project type needs a web or mobile choice. */
export type ScreenPlatform = "web" | "mobile";

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
    /** largest file per group; Claude takes images up to 5 MB of base64, about 3.75 MB raw */
    maxBytes: { image: 3.75 * 1024 * 1024, pdf: 10 * 1024 * 1024, text: 1024 * 1024 } as Record<
        FileAttachmentGroup,
        number
    >,
    /** most files per message */
    maxFiles: 10,
    /** largest total size of the files of one message */
    maxTotalBytes: 20 * 1024 * 1024,
} as const;

/** File inside an attached folder. */
export interface FolderAttachmentFile {
    /** path inside the folder, "/" separated (e.g. "icons/home.svg") */
    path: string;
    /** size of the file in bytes */
    size: number;
    /** file bytes, base64 encoded (no data URL prefix); client to daemon only */
    base64?: string;
}

/**
 * Folder the user attached to a chat message: every file in it is source material for the request.
 *
 * The client sends every file with its path inside the folder; the daemon stores the folder in the
 * project (`.penforge/sources/`) and tells Claude where it is, so Claude reads the files it needs
 * with its own tools instead of getting them all inline. Any file type is accepted. The folder's
 * bytes count toward {@link FILE_ATTACHMENT_LIMITS} `maxTotalBytes` with the message's files.
 * Stored history entries carry `path` and the file list without bytes.
 */
export interface FolderAttachment {
    kind: "folder";
    /** name of the folder the user picked */
    name: string;
    files: FolderAttachmentFile[];
    /** where the daemon stored the folder, relative to the project folder; set by the daemon */
    path?: string;
}

/** Limits of folder attachments (the total size limit is the one of {@link FILE_ATTACHMENT_LIMITS}). */
export const FOLDER_ATTACHMENT_LIMITS = {
    /** most files in one folder */
    maxFiles: 300,
    /** largest file in a folder */
    maxFileBytes: 10 * 1024 * 1024,
    /** folder and file names the client leaves out (tool folders and system files) */
    skipped: [".git", "node_modules", ".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX"],
} as const;

export type Attachment = NodeAttachment | CommentAttachment | ImageAttachment | FileAttachment | FolderAttachment;

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
    /** true when layers are selected but the user removed them from this message's context */
    selectionDismissed?: boolean;
    /**
     * Id of the user message (W37), chosen by the client so it can edit, delete or revert the
     * message later; same pattern as conversation ids. The daemon makes one up when it is missing,
     * invalid or already used in the conversation.
     */
    messageId?: string;
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
    | PreviewStopMessage
    | AppsClientMessage
    | ChatEditClientMessage
    | LinkedClientMessage;

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
    /** stable code of a daemon check (e.g. `boards-overlap`), for clients that word it themselves */
    code?: string;
    /** parameters of `code` */
    params?: Record<string, unknown>;
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
    | "restarting"
    | "start-timeout"
    | "crashed"
    | "command-failed"
    | "stopped"
    | "project-closed"
    | "daemon-stopped"
    /** the server could be reached from the network although it must stay on this computer (W20) */
    | "exposed";

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
    | "internal"
    /** W24 server mode: a limit refused the request */
    | "rate-limited"
    /** W24 server mode: the user may not use the project */
    | "forbidden";

export interface ErrorMessage {
    type: "error";
    rid?: string;
    code: AgentErrorCode | (string & {});
    /** English text; clients prefer translating `reason` when they know it */
    message: string;
    /** finer reason of a `bad-request`, e.g. a refused file: `file-type`, `file-size`, `file-count`,
     * `files-total`, `file-read`, `file-incomplete` */
    reason?: string;
    /** parameters of `reason` (e.g. `{name, limitMb}`) */
    params?: Record<string, unknown>;
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
    | AppsDaemonMessage
    | ChatChangedMessage
    | LinkedDaemonMessage
    | McpRestartMessage
    | ErrorMessage;

/**
 * Asks the tab to restart its hidden MCP plugin: a design tool found no plugin session while the
 * tab is connected to the daemon (the plugin's frame went away without coming back).
 */
export interface McpRestartMessage {
    type: "mcp.restart";
}

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
    /**
     * Platform of the screens: the project's platform, `web` for Game UI, and the detected app
     * platform for an Existing project (W38).
     */
    platform: ScreenPlatform;
    /** project type as chosen in Penpot (`context.set` `platform`); absent means `platform` */
    projectType?: Platform;
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
    /**
     * Tools a runner without a per-use permission channel (`local-cli-spawn`) may approve up front
     * for this turn, in Claude Code permission rule syntax (e.g. `Read`, `Edit(app-src/**)`,
     * `mcp__penpot__list_boards`); every other tool is then denied. Without it such a runner keeps
     * its fixed default list, which ignores {@link check}.
     */
    readonly allowedTools?: readonly string[];
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
    /**
     * Resolves a path inside the project folder (or an absolute path inside the linked folder of a
     * Game UI / Existing project, W38); throws for anything outside.
     */
    resolve(path: string): string;
    /** the folder of this computer a Game UI / Existing project is linked to, when it exists (W38) */
    readonly linkedRoot?: string | null;
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

// ---------------------------------------------------------------------------------------------
// built apps on the dashboard (W33)

/**
 * Request for the built apps of this computer: projects below `<PENFORGE_HOME>/projects/` whose
 * app was built (`.penforge/map.json`). Needs no `context.set`. The reply is `apps.list`; the
 * client then receives `apps.status` for every app until it disconnects.
 */
export interface AppsListMessage {
    type: "apps.list";
    rid: string;
    /** only apps of this Penpot team (`project.json` `teamId`) */
    teamId?: string;
}

/**
 * Request to run the dev server of a built app (W09 `DevServerManager`, one per project); the
 * client follows it with `apps.status`. Idempotent. The server keeps running until `apps.stop`
 * (also when no tab watches it) or the daemon stops.
 */
export interface AppsStartMessage {
    type: "apps.start";
    rid: string;
    projectId: string;
}

/** Request to stop the dev server of an app (process tree killed, port freed). */
export interface AppsStopMessage {
    type: "apps.stop";
    rid: string;
    projectId: string;
}

/** Request for the buffered dev server output of an app; the reply is `apps.logs`. */
export interface AppsLogsMessage {
    type: "apps.logs";
    rid: string;
    projectId: string;
}

/**
 * Request to open an Expo app on a phone: the dev server restarts reachable from the local
 * network (W20 `PhonePreview`) and `apps.phone` carries the QR code. `confirmed` must be true:
 * the client asked the user first. The session ends on `apps.phone.stop`, `apps.stop`, client
 * disconnect or after 30 min; the dev server then goes back to this computer only.
 */
export interface AppsPhoneStartMessage {
    type: "apps.phone.start";
    rid: string;
    projectId: string;
    confirmed: true;
}

/** Request to end the phone session of an app. */
export interface AppsPhoneStopMessage {
    type: "apps.phone.stop";
    rid?: string;
    projectId: string;
}

export type AppsClientMessage =
    | AppsListMessage
    | AppsStartMessage
    | AppsStopMessage
    | AppsLogsMessage
    | AppsPhoneStartMessage
    | AppsPhoneStopMessage;

/** Who can reach an app's dev server: this computer only, or the local network (phone session). */
export type AppExposure = "loopback" | "lan";

/** Dev server state of an app; `stopped` when none runs. */
export interface AppRunStatus {
    state: PreviewState;
    /** loopback URL once a port is assigned */
    url?: string;
    reason?: PreviewReason;
    /** English technical detail (developer persona) */
    message?: string;
    exposure?: AppExposure;
}

/** Last AI checkpoint of an app's project (W19). */
export interface AppCheckpointInfo {
    n: number;
    label: string;
    at: string;
}

/** Built app, as listed on the dashboard. */
export interface AppInfo {
    projectId: string;
    /** Penpot project name (`project.json`), else the stack name */
    name: string;
    teamId: string | null;
    /** Penpot file the app was built from (`map.json`), for "Open design" */
    fileId: string | null;
    platform: Platform;
    /** stack name and versions (`stack.json`) */
    stack: { name: string; version: string };
    /** Expo app: opened on a phone (QR), optionally in the browser */
    expo: boolean;
    /** the dev server shows the app in a browser (web apps; Expo apps with react-native-web) */
    web: boolean;
    /** last build (ISO time) and its `app-src` commit */
    builtAt: string | null;
    commit: string | null;
    checkpoint: AppCheckpointInfo | null;
    /** small PNG `data:` URL (`.penforge/thumbnail.png` or the newest visual QA app screenshot) */
    thumbnail: string | null;
    /** source of the thumbnail, relative to the project folder */
    thumbnailPath: string | null;
    /** project folder and `app-src/` folder on this computer (developer persona: "Open folder") */
    path: string;
    appPath: string;
    status: AppRunStatus;
}

export interface AppsListReplyMessage {
    type: "apps.list";
    rid: string;
    apps: AppInfo[];
}

/** Dev server state change of an app; sent to every client that listed the apps or started one. */
export interface AppsStatusMessage extends AppRunStatus {
    type: "apps.status";
    projectId: string;
}

export interface AppsLogsReplyMessage {
    type: "apps.logs";
    rid: string;
    projectId: string;
    lines: { stream: "stdout" | "stderr" | "system"; text: string }[];
}

/**
 * Phone session of an app: `starting`, `ready` (with `url` = `exp://<lan address>:<port>`, `qr`
 * matrix, `expiresAt`), `stopped`, or `failed` (`code`: `no-phone-preview`, `no-network`,
 * `preview-failed`, `no-app`, `busy`, `internal`; `message` in English).
 */
export interface AppsPhoneMessage {
    type: "apps.phone";
    projectId: string;
    state: "starting" | "ready" | "stopped" | "failed";
    url?: string;
    host?: string;
    port?: number;
    qr?: { size: number; rows: string[] };
    expiresAt?: string;
    code?: string;
    message?: string;
}

export type AppsDaemonMessage = AppsListReplyMessage | AppsStatusMessage | AppsLogsReplyMessage | AppsPhoneMessage;

// ---------------------------------------------------------------------------------------------
// message actions in the chat (W37)

/**
 * Request to send an edited user message again: the message `messageId` and every later message
 * are dropped, then a turn runs with `text` like `chat.send` (the edited message keeps its
 * attachments, read from the conversation file; the client sends none). The daemon first replies
 * `chat.changed` (action `edit`), then streams the turn. Refused with `busy` while the
 * conversation answers.
 */
export interface ChatEditMessage {
    type: "chat.edit";
    rid: string;
    conversationId: string;
    /** user message to edit */
    messageId: string;
    text: string;
    /** id of the new user message (as `chat.send.messageId`) */
    newMessageId?: string;
    selectionDismissed?: boolean;
}

/** Request to drop a user message and its answer from a conversation; replied with `chat.changed`. */
export interface ChatDeleteMessage {
    type: "chat.delete";
    rid: string;
    conversationId: string;
    messageId: string;
}

/**
 * Request to put the design back to how it was before a user message and drop that message and
 * every later one. The design comes back from the first W19 checkpoint a turn from that message on
 * saved (a chat turn saves one before its first design or file change); none means the AI changed
 * nothing since, so only the messages go. `confirmed` says the client asked the user first.
 * Replied with `chat.changed` (action `revert`); a failed restore answers `error` and keeps the
 * messages.
 */
export interface ChatRevertMessage {
    type: "chat.revert";
    rid: string;
    conversationId: string;
    messageId: string;
    confirmed: true;
}

export type ChatEditClientMessage = ChatEditMessage | ChatDeleteMessage | ChatRevertMessage;

/** What a message action did to the design. */
export type ChatRevertDesign = "restored" | "unchanged";

/**
 * Reply to `chat.edit`, `chat.delete` and `chat.revert`: the messages are gone from the
 * conversation file. `removed` lists the ids of the dropped user and assistant messages. The next
 * turn starts a new Claude session that gets a short history of the kept messages, so Claude does
 * not remember the dropped ones (`wiki/architecture.md` §5).
 */
export interface ChatChangedMessage {
    type: "chat.changed";
    rid: string;
    conversationId: string;
    action: "edit" | "delete" | "revert";
    messageId: string;
    removed: string[];
    /** revert only */
    design?: ChatRevertDesign;
    /** revert only: the restored checkpoint */
    checkpointId?: string;
}

// ---------------------------------------------------------------------------------------------
// linked project folders (W38): folder browser and Game UI / Existing project links

/**
 * Request to list a folder of this computer for the folder browser. Needs no `context.set`.
 * Without `path`: the roots (drives on Windows, `/` elsewhere, and the home folder). The reply is
 * `folder.list`; a refused path is an `error` (`bad-request`, `reason` one of
 * {@link LinkRefusalReason}).
 */
export interface FolderListMessage {
    type: "folder.list";
    rid: string;
    /** absolute folder path */
    path?: string;
}

/**
 * Request to link a project to a folder of this computer (stored in the project's
 * `.penforge/project.json`, never in the backend). Replaces an earlier link. The reply is
 * `project.linked`, or an `error` (`bad-request` with a {@link LinkRefusalReason}).
 */
export interface ProjectLinkMessage {
    type: "project.link";
    rid: string;
    projectId: string;
    kind: LinkedProjectKind;
    /** absolute folder path */
    path: string;
}

/** Request for a project's link; the reply is `project.linked` (`linked: false` when none). */
export interface ProjectLinkStatusMessage {
    type: "project.link.status";
    rid: string;
    projectId: string;
}

export type LinkedClientMessage = FolderListMessage | ProjectLinkMessage | ProjectLinkStatusMessage;

/** Why a folder is refused for browsing or linking (client translates; `message` is English). */
export type LinkRefusalReason =
    | "bad-path"
    | "folder-missing"
    | "not-a-folder"
    | "folder-unreadable"
    | "folder-refused"
    | "not-a-game"
    | "empty-folder";

/** Game engine of a Game UI folder. */
export type GameEngine = "unity" | "unreal";

/** App stack detected in an Existing project folder. */
export interface DetectedStack {
    platform: ScreenPlatform;
    /** e.g. `react`, `next`, `vue`, `flutter`, `react-native`, `expo`, `ios`, `android`, `web` */
    name: string;
}

/** What a folder looks like, from the names in it (no file content is read except manifests). */
export interface FolderFacts {
    /** has `.git` */
    git: boolean;
    /** has `Assets/` and `ProjectSettings/` */
    unity: boolean;
    /** has a `*.uproject` file */
    unreal: boolean;
    uproject: string | null;
    /** project manifests found, e.g. `package.json`, `pubspec.yaml`, `*.xcodeproj`, `build.gradle` */
    markers: string[];
    /** holds no file or folder at all */
    empty: boolean;
    engine: GameEngine | null;
    stack: DetectedStack | null;
}

/** Root of the folder browser. */
export interface FolderRoot {
    name: string;
    path: string;
    kind: "drive" | "home";
}

export interface FolderListReplyMessage {
    type: "folder.list";
    rid: string;
    /** the listed folder (real path), null for the roots */
    path: string | null;
    /** parent folder, null at a root */
    parent: string | null;
    /** only for the roots listing; empty otherwise */
    roots: FolderRoot[];
    /** sub-folders, names only, hidden ones skipped, sorted by name */
    entries: Array<{ name: string; path: string }>;
    /** more than the listed entries exist */
    truncated: boolean;
    facts: FolderFacts | null;
}

/** Link of a project (reply to `project.link` and `project.link.status`). */
export interface ProjectLinkedMessage {
    type: "project.linked";
    rid: string;
    projectId: string;
    linked: boolean;
    kind?: LinkedProjectKind;
    linkedRoot?: string;
    engine?: GameEngine | null;
    stack?: DetectedStack | null;
}

export type LinkedDaemonMessage = FolderListReplyMessage | ProjectLinkedMessage;
