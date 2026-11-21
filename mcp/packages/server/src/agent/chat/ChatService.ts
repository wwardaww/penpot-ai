import { randomUUID } from "crypto";
import type {
    Attachment,
    ChatCancelMessage,
    ChatDeleteMessage,
    ChatEditMessage,
    ChatHistoryEntry,
    ChatHistoryRequestMessage,
    ChatRevertDesign,
    ChatRevertMessage,
    ChatSendMessage,
    ChatUsage,
    Persona,
} from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { AgentError, type AgentClient } from "../AgentClient";
import { RunnerNotConfiguredError } from "../runner/ClaudeRunner";
import { CanvasCheck } from "./CanvasCheck";
import { AnimationSteps } from "../animations/AnimationSteps";
import { ConversationRecap } from "./ConversationRecap";
import { type ConversationCut, type ConversationCutMode, ConversationStore } from "./ConversationStore";
import { ToolSummary } from "./toolSummary";
import { type ChatCheckpointStore, TurnCheckpointGuard, W19ChatCheckpoints } from "./TurnCheckpoints";
import type { TurnRunner, TurnSetup } from "./TurnRunner";
import { UploadRefusedError, UploadStore } from "./UploadStore";

/** A user message to answer: from `chat.send`, or the new text of `chat.edit`. */
type TurnMessage = Pick<ChatSendMessage, "rid" | "conversationId" | "text" | "attachments" | "selectionDismissed"> & {
    messageId?: string;
};

/** Running chat turn. */
interface ActiveTurn {
    clientId: string;
    conversationId: string;
    abort: AbortController;
}

/**
 * Service behind `chat.send`, `chat.cancel`, `chat.history` and the message actions `chat.edit`,
 * `chat.delete`, `chat.revert` (W37).
 *
 * Runs one Claude turn per message, streams it to the client as `chat.delta` / `chat.tool` /
 * `chat.done`, and persists the conversation in the project folder. A conversation resumes its
 * Claude session, also after a page reload or a daemon restart. One turn or message action per
 * conversation runs at a time.
 *
 * A turn saves a W19 checkpoint right before its first design or file change
 * ({@link TurnCheckpointGuard}); `chat.revert` restores it. A message action drops the
 * conversation's Claude session, which remembers the dropped turns; the next turn starts a new
 * session with a {@link ConversationRecap} of the kept messages.
 */
export class ChatService {
    private readonly logger = createLogger("ChatService");
    private readonly active = new Map<string, ActiveTurn>();
    /** Tool name of the canvas check's step lines in `chat.tool`. */
    public static readonly CANVAS_CHECK = "penforge_canvas_check";

    /**
     * @param turns - runner of Claude turns
     * @param checkpoints - saves and restores the turns' checkpoints
     */
    constructor(
        private readonly turns: TurnRunner,
        private readonly checkpoints: ChatCheckpointStore = new W19ChatCheckpoints()
    ) {}

    /**
     * Handles `chat.send`; resolves when the turn is over.
     */
    public async send(client: AgentClient, message: ChatSendMessage): Promise<void> {
        await this.exclusive(client, message.conversationId, (setup, signal) =>
            this.runTurn(client, message, setup, signal)
        );
    }

    /**
     * Handles `chat.edit`: drops the edited message and every later one, replies `chat.changed`,
     * then answers the new text (with the edited message's attachments) like `chat.send`.
     */
    public async edit(client: AgentClient, message: ChatEditMessage): Promise<void> {
        await this.exclusive(client, message.conversationId, async (setup, signal) => {
            const store = new ConversationStore(setup.workspace);
            const cut = await ChatService.cut(store, message.conversationId, message.messageId, "from");
            await store.applyCut(message.conversationId, cut);
            client.send(ChatService.changed(message, "edit", cut));
            await this.runTurn(
                client,
                {
                    rid: message.rid,
                    conversationId: message.conversationId,
                    text: message.text,
                    selectionDismissed: message.selectionDismissed,
                    messageId: message.newMessageId,
                },
                setup,
                signal,
                ChatService.reusable(cut.target.attachments)
            );
        });
    }

    /**
     * Handles `chat.delete`: drops a user message and its answer.
     */
    public async delete(client: AgentClient, message: ChatDeleteMessage): Promise<void> {
        await this.exclusive(client, message.conversationId, async (setup) => {
            const store = new ConversationStore(setup.workspace);
            const cut = await ChatService.cut(store, message.conversationId, message.messageId, "turn");
            await store.applyCut(message.conversationId, cut);
            client.send(ChatService.changed(message, "delete", cut));
        });
    }

    /**
     * Handles `chat.revert`: restores the first checkpoint a turn from the message on saved (the
     * state before the message, as the AI changed nothing between it and that turn), then drops
     * the message and every later one. A failed restore keeps the messages.
     */
    public async revert(client: AgentClient, message: ChatRevertMessage): Promise<void> {
        await this.exclusive(client, message.conversationId, async (setup) => {
            const store = new ConversationStore(setup.workspace);
            const cut = await ChatService.cut(store, message.conversationId, message.messageId, "from");
            const checkpointId = cut.checkpoints[0];
            let design: ChatRevertDesign = "unchanged";
            if (checkpointId !== undefined) {
                try {
                    await this.checkpoints.restore(setup, checkpointId);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    throw new AgentError("internal", `The design could not be put back: ${reason}`);
                }
                design = "restored";
            }
            await store.applyCut(message.conversationId, cut);
            client.send({ ...ChatService.changed(message, "revert", cut), design, checkpointId });
        });
    }

    /**
     * Handles `chat.cancel`.
     */
    public cancel(client: AgentClient, message: ChatCancelMessage): void {
        for (const turn of this.active.values()) {
            if (turn.clientId === client.id && turn.conversationId === message.conversationId) {
                turn.abort.abort();
                this.turns.runner.cancel(turn.conversationId);
            }
        }
    }

    /**
     * Handles `chat.history`.
     */
    public async history(client: AgentClient, message: ChatHistoryRequestMessage): Promise<void> {
        ChatService.checkConversationId(message.conversationId);
        const { workspace } = await client.setup();
        const messages = await new ConversationStore(workspace).history(message.conversationId);
        client.send({ type: "chat.history", rid: message.rid, conversationId: message.conversationId, messages });
    }

    /** Cancels every running turn. */
    public cancelAll(): void {
        for (const turn of this.active.values()) {
            turn.abort.abort();
        }
        this.turns.runner.cancel();
    }

    /**
     * Runs `action` with the client's setup while no other turn or action of the conversation
     * runs; `signal` (also `setup.signal`) aborts when the client disconnects or cancels.
     */
    private async exclusive(
        client: AgentClient,
        conversationId: string,
        action: (setup: TurnSetup, signal: AbortSignal) => Promise<void>
    ): Promise<void> {
        ChatService.checkConversationId(conversationId);
        const setup = await client.setup();
        const key = `${setup.workspace.projectId}/${conversationId}`;
        if (this.active.has(key)) {
            throw new AgentError("busy", "This conversation is still answering the previous message");
        }
        const abort = new AbortController();
        const onClose = () => abort.abort();
        client.closed.addEventListener("abort", onClose, { once: true });
        this.active.set(key, { clientId: client.id, conversationId, abort });
        try {
            await action({ ...setup, signal: abort.signal }, abort.signal);
        } finally {
            client.closed.removeEventListener("abort", onClose);
            this.active.delete(key);
        }
    }

    private static async cut(
        store: ConversationStore,
        conversationId: string,
        messageId: string,
        mode: ConversationCutMode
    ): Promise<ConversationCut> {
        const cut = await store.planCut(conversationId, messageId, mode);
        if (!cut) {
            throw new AgentError("bad-request", "No such message in this conversation");
        }
        return cut;
    }

    private static changed(
        message: { rid: string; conversationId: string; messageId: string },
        action: "edit" | "delete" | "revert",
        cut: ConversationCut
    ) {
        return {
            type: "chat.changed" as const,
            rid: message.rid,
            conversationId: message.conversationId,
            action,
            messageId: message.messageId,
            removed: cut.removedIds(),
        };
    }

    /**
     * Stored attachments an edited message can send again: all but pasted images, whose bytes
     * the conversation file does not keep (files and folders keep their saved path).
     */
    private static reusable(attachments: Attachment[] | undefined): Attachment[] | undefined {
        const kept = (attachments ?? []).filter((attachment) => attachment.kind !== "image");
        return kept.length > 0 ? kept : undefined;
    }

    /** Label of a chat turn's checkpoint: the start of the user's text. */
    private static checkpointLabel(text: string): string {
        const clean = text.replace(/\s+/g, " ").trim();
        const short = clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
        return `Before chat: “${short}”`;
    }

    private async runTurn(
        client: AgentClient,
        message: TurnMessage,
        setup: TurnSetup,
        signal: AbortSignal,
        storedAttachments?: Attachment[]
    ): Promise<void> {
        const { conversationId } = message;
        const persona = setup.context.persona;
        const store = new ConversationStore(setup.workspace);
        let attachments: ChatSendMessage["attachments"];
        try {
            attachments = storedAttachments ?? (await new UploadStore(setup.workspace).saveAll(message.attachments));
        } catch (error) {
            // a refused file ends the turn before anything is stored
            const code = error instanceof AgentError ? error.code : "internal";
            const text = error instanceof Error ? error.message : String(error);
            const details = error instanceof UploadRefusedError ? { reason: error.reason, params: error.params } : {};
            client.send({ type: "error", rid: message.rid, code, message: text, ...details });
            client.send({ type: "chat.done", conversationId, messageId: randomUUID() });
            return;
        }
        const resumeSessionId = await store.lastSession(conversationId);
        const earlier: ChatHistoryEntry[] = resumeSessionId ? [] : await store.history(conversationId);
        const userMessageId = await ChatService.newMessageId(store, conversationId, message.messageId);
        await store.appendMessage(conversationId, {
            role: "user",
            messageId: userMessageId,
            text: message.text,
            ts: new Date().toISOString(),
            attachments,
        });

        // the turn's checkpoint, saved right before its first change
        const guard = new TurnCheckpointGuard(setup.permissions, async () => {
            const checkpointId = await this.checkpoints.save(setup, ChatService.checkpointLabel(message.text));
            if (checkpointId !== null) {
                await store.setCheckpoint(conversationId, userMessageId, checkpointId);
            }
            return checkpointId;
        });
        if (TurnCheckpointGuard.savesUpFront(this.turns.runner.kind)) {
            await guard.ensure();
        }

        const check = new CanvasCheck(setup.tools);
        // read in parallel with the turn: Claude's first design change comes seconds later
        const boardsBefore = check.boards(setup.context.pageId);
        let changedDesign = false;
        let messageId: string = randomUUID();
        let text = "";
        let usage: ChatUsage | undefined;
        let failure: string | undefined;
        // W32: a Play line after each successful update_animations call
        const animationSteps = new AnimationSteps();
        try {
            const events = this.turns.run(
                { ...setup, permissions: guard },
                { id: conversationId, resumeSessionId },
                {
                    text: message.text,
                    attachments,
                    workflow: "chat",
                    noteMissingSelection: true,
                    selectionDismissed: message.selectionDismissed,
                    // a new session after an edit, delete or revert gets what was said so far
                    systemPromptAppend: ConversationRecap.text(earlier),
                }
            );
            for await (const event of events) {
                switch (event.kind) {
                    case "session":
                        if (event.sessionId !== resumeSessionId) {
                            await store.setSession(conversationId, event.sessionId);
                        }
                        break;
                    case "text":
                        messageId = event.messageId;
                        text += event.text;
                        client.send({ type: "chat.delta", conversationId, messageId, text: event.text });
                        break;
                    case "tool":
                        // a script that changed the design and then failed counts too
                        changedDesign ||= CanvasCheck.changesDesign(event.toolName);
                        client.send({
                            type: "chat.tool",
                            conversationId,
                            toolName: event.toolName,
                            summary: ToolSummary.summary(event.toolName, event.status, persona),
                            status: event.status,
                            detail: ToolSummary.detail(
                                persona,
                                event.status === "running" ? event.input : undefined,
                                event.status === "error" ? event.detail : undefined
                            ),
                        });
                        {
                            const step = animationSteps.observe(event);
                            if (step) {
                                client.send({ type: "chat.tool", conversationId, ...step });
                            }
                        }
                        break;
                    case "done":
                        messageId = event.messageId;
                        text = event.text || text;
                        usage = event.usage;
                        break;
                    case "error":
                        failure = event.message;
                        break;
                }
            }
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
            if (error instanceof RunnerNotConfiguredError) {
                client.send({ type: "error", rid: message.rid, code: "not-configured", message: error.message });
                failure = undefined;
            } else if (error instanceof AgentError) {
                // e.g. `rate-limited` in server mode: the text is meant for the user
                client.send({ type: "error", rid: message.rid, code: error.code, message: error.message });
                failure = undefined;
            }
        }

        if (changedDesign && !signal.aborted) {
            await this.reportCanvasProblems(client, conversationId, setup.context.pageId, check, await boardsBefore);
        }
        if (failure !== undefined && !signal.aborted) {
            this.logger.warn("Chat turn of %s failed: %s", conversationId, failure);
            client.send({
                type: "error",
                rid: message.rid,
                code: "internal",
                message: ChatService.failureText(persona, failure),
            });
        }
        if (text.length > 0) {
            await store.appendMessage(conversationId, {
                role: "assistant",
                messageId,
                text,
                ts: new Date().toISOString(),
            });
        }
        client.send({ type: "chat.done", conversationId, messageId, usage });
    }

    /**
     * Checks the canvas after a turn that changed the design and tells the user about problems
     * Claude's own checks missed, as failed step lines with a code the client translates. Without
     * a board listing from before the turn nothing is reported.
     */
    private async reportCanvasProblems(
        client: AgentClient,
        conversationId: string,
        pageId: string,
        check: CanvasCheck,
        before: Awaited<ReturnType<CanvasCheck["boards"]>>
    ): Promise<void> {
        const after = before ? await check.boards(pageId) : null;
        if (!before || !after) {
            return;
        }
        const problems = [...CanvasCheck.problems(before, after), ...(await check.styleDifferences(before, after))];
        for (const problem of problems) {
            client.send({
                type: "chat.tool",
                conversationId,
                toolName: ChatService.CANVAS_CHECK,
                summary: problem.text,
                // a style difference may be intended: a note, not a failed step
                status: problem.severity === "error" ? "error" : "done",
                code: problem.code,
                params: problem.params,
            });
        }
    }

    /** Id of a new user message: the client's when it is valid and new, else a random one. */
    private static async newMessageId(
        store: ConversationStore,
        conversationId: string,
        wanted: string | undefined
    ): Promise<string> {
        if (
            wanted !== undefined &&
            ConversationStore.ID_PATTERN.test(wanted) &&
            !(await store.hasMessage(conversationId, wanted))
        ) {
            return wanted;
        }
        return randomUUID();
    }

    private static failureText(persona: Persona, failure: string): string {
        return persona === "developer" ? `Claude failed: ${failure}` : "Something went wrong. Please try again.";
    }

    private static checkConversationId(conversationId: string): void {
        if (!ConversationStore.ID_PATTERN.test(conversationId)) {
            throw new AgentError("bad-request", "Invalid conversationId");
        }
    }
}
