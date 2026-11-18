import { randomUUID } from "crypto";
import type {
    ChatCancelMessage,
    ChatHistoryRequestMessage,
    ChatSendMessage,
    ChatUsage,
    Persona,
} from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { AgentError, type AgentClient } from "../AgentClient";
import { RunnerNotConfiguredError } from "../runner/ClaudeRunner";
import { ConversationStore } from "./ConversationStore";
import { ToolSummary } from "./toolSummary";
import type { TurnRunner } from "./TurnRunner";
import { UploadStore } from "./UploadStore";

/** Running chat turn. */
interface ActiveTurn {
    clientId: string;
    conversationId: string;
    abort: AbortController;
}

/**
 * Service behind `chat.send`, `chat.cancel` and `chat.history`.
 *
 * Runs one Claude turn per message, streams it to the client as `chat.delta` / `chat.tool` /
 * `chat.done`, and persists the conversation in the project folder. A conversation resumes its
 * Claude session, also after a page reload or a daemon restart. One turn per conversation runs at a
 * time.
 */
export class ChatService {
    private readonly logger = createLogger("ChatService");
    private readonly active = new Map<string, ActiveTurn>();

    constructor(private readonly turns: TurnRunner) {}

    /**
     * Handles `chat.send`; resolves when the turn is over.
     */
    public async send(client: AgentClient, message: ChatSendMessage): Promise<void> {
        ChatService.checkConversationId(message.conversationId);
        const setup = await client.setup();
        const key = `${setup.workspace.projectId}/${message.conversationId}`;
        if (this.active.has(key)) {
            throw new AgentError("busy", "This conversation is still answering the previous message");
        }
        const abort = new AbortController();
        const onClose = () => abort.abort();
        client.closed.addEventListener("abort", onClose, { once: true });
        this.active.set(key, { clientId: client.id, conversationId: message.conversationId, abort });
        try {
            await this.runTurn(client, message, { ...setup, signal: abort.signal }, abort.signal);
        } finally {
            client.closed.removeEventListener("abort", onClose);
            this.active.delete(key);
        }
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

    private async runTurn(
        client: AgentClient,
        message: ChatSendMessage,
        setup: Parameters<TurnRunner["run"]>[0],
        signal: AbortSignal
    ): Promise<void> {
        const { conversationId } = message;
        const persona = setup.context.persona;
        const store = new ConversationStore(setup.workspace);
        let attachments: ChatSendMessage["attachments"];
        try {
            attachments = await new UploadStore(setup.workspace).saveAll(message.attachments);
        } catch (error) {
            // a refused file ends the turn before anything is stored
            const code = error instanceof AgentError ? error.code : "internal";
            const text = error instanceof Error ? error.message : String(error);
            client.send({ type: "error", rid: message.rid, code, message: text });
            client.send({ type: "chat.done", conversationId, messageId: randomUUID() });
            return;
        }
        const resumeSessionId = await store.lastSession(conversationId);
        await store.appendMessage(conversationId, {
            role: "user",
            messageId: randomUUID(),
            text: message.text,
            ts: new Date().toISOString(),
            attachments,
        });

        let messageId: string = randomUUID();
        let text = "";
        let usage: ChatUsage | undefined;
        let failure: string | undefined;
        try {
            const events = this.turns.run(
                setup,
                { id: conversationId, resumeSessionId },
                { text: message.text, attachments, workflow: "chat", noteMissingSelection: true }
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
            }
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

    private static failureText(persona: Persona, failure: string): string {
        return persona === "developer" ? `Claude failed: ${failure}` : "Something went wrong. Please try again.";
    }

    private static checkConversationId(conversationId: string): void {
        if (!ConversationStore.ID_PATTERN.test(conversationId)) {
            throw new AgentError("bad-request", "Invalid conversationId");
        }
    }
}
