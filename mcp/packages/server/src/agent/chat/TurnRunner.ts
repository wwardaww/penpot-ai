import type { AgentContext, Attachment, RunnerEvent, WorkflowToolFilter, WorkflowToolsApi } from "@penpot/mcp-common";
import type { ClaudeRunner, RunnerConversation, ToolPermissionHandler } from "../runner/ClaudeRunner";
import { LayoutCheckHeader } from "../../LayoutCheckHeader";
import { LinkedProjectPrompt } from "../linked/LinkedProjectPrompt";
import type { PermissionModeState } from "../permissions/PermissionModeState";
import type { ModelGuide } from "../prompts/ModelGuide";
import type { PromptRegistry } from "../prompts/promptRegistry";
import { AppFolderPrompt } from "../workspace/AppFolderPrompt";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { AttachmentPrompt } from "./AttachmentPrompt";
import { AnimationSettings } from "../animations/AnimationSettings";

/** Client-side state a Claude turn runs with. */
export interface TurnSetup {
    context: AgentContext;
    workspace: ProjectWorkspace;
    permissions: ToolPermissionHandler;
    tools: WorkflowToolsApi | null;
    signal?: AbortSignal;
    /** permission mode in force; `manual` when unset */
    permissionMode?: PermissionModeState;
}

/** What to ask Claude. */
export interface TurnRequest {
    text: string;
    attachments?: Attachment[];
    /** workflow whose prompt is added to the system prompt */
    workflow?: string;
    /** extra system prompt text */
    systemPromptAppend?: string;
    /** tells Claude when the message has no layer attached (chat turns) */
    noteMissingSelection?: boolean;
    /** the user removed the selected layers from the message (with `noteMissingSelection`) */
    selectionDismissed?: boolean;
    /** tools runners without a permission channel may approve (see `RunnerOptions.allowedTools`) */
    allowedTools?: readonly string[];
    /** what the turn's tools may do; `setup.permissions` applies it */
    toolFilter?: WorkflowToolFilter;
    /** model of the turn over the configured one */
    model?: string;
}

/**
 * Runner of single Claude turns with the daemon's system prompt.
 *
 * Builds the system prompt (base, persona, workflow, tab context, the drawing guide for models other
 * than Claude) and the input (text plus attachments), and runs the turn in the project folder.
 */
export class TurnRunner {
    /** Last in the prompt: it holds over the parts that tell Claude to ask first. */
    private static readonly AWAY =
        "## The user is away\n" +
        "The user is away and answers no questions now. Do not stop to ask, and do not end your reply with a " +
        "question. Where you would ask, take the option you would recommend, or else the most sensible one, and " +
        "go on until the request is done. Say in your reply what you assumed, so the user can change it. If a " +
        "tool use is refused, do not look for a way around it: go on without it and say what is left to do.";

    /**
     * @param runner - runs the turns
     * @param prompts - the prompt templates
     * @param askForFolder - whether Build asks the user for a folder (W41; not in server mode)
     * @param guide - the drawing guide for models other than Claude (not in server mode)
     */
    constructor(
        public readonly runner: ClaudeRunner,
        private readonly prompts: PromptRegistry,
        private readonly askForFolder = false,
        private readonly guide?: ModelGuide
    ) {}

    /**
     * Runs one turn.
     *
     * @param setup - context, workspace, permissions and tools of the client
     * @param conversation - the conversation, with the Claude session to resume
     * @param request - text, attachments and prompt parts
     */
    public async *run(
        setup: TurnSetup,
        conversation: RunnerConversation,
        request: TurnRequest
    ): AsyncIterable<RunnerEvent> {
        const { context } = setup;
        // W32: tells chat and generate-screen turns whether they may animate on their own
        const animationNote = await AnimationSettings.promptNote(setup.workspace, request.workflow);
        const built = this.prompts.build({
            persona: context.persona,
            // a Game UI project (W38) uses the `{{#game}}` sections instead of the web ones
            platform: context.projectType === "game" ? "game" : context.platform,
            projectType: context.projectType,
            projectName: context.projectName ?? context.fileName,
            workflow: request.workflow,
            extra: [
                TurnRunner.tabContext(context),
                TurnRunner.selectionNote(request),
                animationNote,
                request.systemPromptAppend,
                setup.permissionMode?.unattended ? TurnRunner.AWAY : undefined,
            ]
                .filter(Boolean)
                .join("\n\n"),
        });
        // the linked project's brief is user content: added after the template rendering (W38)
        const linked = await LinkedProjectPrompt.section(setup.workspace, context);
        // the app may be in a folder the user picked instead of `app-src/` (W41)
        const app = new AppFolderPrompt(setup.workspace);
        const isChat = !request.workflow || request.workflow === "chat";
        const noApp = isChat && this.askForFolder ? app.noAppSection(context) : "";
        const section = [linked, app.section(context), noApp].filter(Boolean).join("\n\n");
        const prompt = section ? `${app.text(built)}\n${section}\n` : built;
        // last, where small models follow it best
        const guide = this.guide?.section(request);
        const systemPrompt = guide ? `${prompt}\n${guide}\n` : prompt;
        // a chat message is the user's text; a workflow's prompt is the daemon's
        const text = isChat ? request.text : app.text(request.text);
        const input = await new AttachmentPrompt(setup.tools).build(text, request.attachments);
        yield* this.runner.send(conversation, input, {
            cwd: setup.workspace.root,
            systemPromptAppend: systemPrompt,
            allowedTools: request.allowedTools,
            ...(request.model ? { model: request.model } : {}),
            permissions: app.permissions(setup.permissions),
            additionalDirectories: app.directories,
            // who needs the guide also needs to be told what it drew wrong
            ...(guide ? { mcpHeaders: { ...LayoutCheckHeader.HEADERS } } : {}),
            signal: setup.signal,
        });
    }

    /** Note for Claude when a chat message has no layer attached (the chat attaches the selection). */
    private static selectionNote(request: TurnRequest): string | undefined {
        const attached = (request.attachments ?? []).some((attachment) => attachment.kind === "node");
        if (!request.noteMissingSelection || attached) {
            return undefined;
        }
        return request.selectionDismissed
            ? "## Canvas selection\nThe user has layers selected but chose not to attach them to this " +
                  "message; do not assume the request is about them."
            : "## Canvas selection\nNo layer is selected on the canvas and none is attached to this message.";
    }

    private static tabContext(context: AgentContext): string {
        const lines = [
            "## Open in the user's tab",
            `- Penpot file "${context.fileName}" (fileId ${context.fileId}), current pageId ${context.pageId}.`,
        ];
        if (context.mcpSessionId) {
            lines.push(
                `- Penpot MCP session of this tab: \`${context.mcpSessionId}\`. ` +
                    "Pass it as `sessionId` to every Penpot tool that accepts one."
            );
        }
        return lines.join("\n");
    }
}
