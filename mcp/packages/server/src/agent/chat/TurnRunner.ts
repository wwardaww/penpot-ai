import type { AgentContext, Attachment, RunnerEvent, WorkflowToolsApi } from "@penpot/mcp-common";
import type { ClaudeRunner, RunnerConversation, ToolPermissionHandler } from "../runner/ClaudeRunner";
import type { PromptRegistry } from "../prompts/promptRegistry";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { AttachmentPrompt } from "./AttachmentPrompt";

/** Client-side state a Claude turn runs with. */
export interface TurnSetup {
    context: AgentContext;
    workspace: ProjectWorkspace;
    permissions: ToolPermissionHandler;
    tools: WorkflowToolsApi | null;
    signal?: AbortSignal;
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
}

/**
 * Runner of single Claude turns with the daemon's system prompt.
 *
 * Builds the system prompt (base, persona, workflow, tab context) and the input (text plus
 * attachments), and runs the turn in the project folder.
 */
export class TurnRunner {
    constructor(
        public readonly runner: ClaudeRunner,
        private readonly prompts: PromptRegistry
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
        const systemPrompt = this.prompts.build({
            persona: context.persona,
            platform: context.platform,
            projectName: context.projectName ?? context.fileName,
            workflow: request.workflow,
            extra: [TurnRunner.tabContext(context), TurnRunner.selectionNote(request), request.systemPromptAppend]
                .filter(Boolean)
                .join("\n\n"),
        });
        const input = await new AttachmentPrompt(setup.tools).build(request.text, request.attachments);
        yield* this.runner.send(conversation, input, {
            cwd: setup.workspace.root,
            systemPromptAppend: systemPrompt,
            permissions: setup.permissions,
            signal: setup.signal,
        });
    }

    /** Note for Claude when a chat message has no layer attached (the chat attaches the selection). */
    private static selectionNote(request: TurnRequest): string | undefined {
        const attached = (request.attachments ?? []).some((attachment) => attachment.kind === "node");
        return request.noteMissingSelection && !attached
            ? "## Canvas selection\nNo layer is selected on the canvas and none is attached to this message."
            : undefined;
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
