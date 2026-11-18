import { appendFile, readFile } from "fs/promises";
import type { Attachment, ChatHistoryEntry } from "@penpot/mcp-common";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";

/** Line of a conversation file. */
type ConversationRecord = ({ type: "message" } & ChatHistoryEntry) | { type: "session"; sessionId: string; ts: string };

/**
 * Store of chat conversations, one JSON Lines file per conversation
 * (`.penforge/chat/<conversationId>.jsonl`).
 *
 * Keeps the messages shown to the user and the Claude session id, so that a conversation resumes
 * after a page reload or a daemon restart.
 */
export class ConversationStore {
    /** Pattern of acceptable conversation ids. */
    public static readonly ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

    constructor(private readonly workspace: ProjectWorkspace) {}

    /**
     * Appends a message.
     *
     * @param conversationId - the conversation
     * @param entry - the message; image and file bytes of attachments are not stored
     */
    public async appendMessage(conversationId: string, entry: ChatHistoryEntry): Promise<void> {
        const stored: ChatHistoryEntry = {
            ...entry,
            attachments: entry.attachments?.map((attachment) => ConversationStore.withoutBytes(attachment)),
        };
        await this.append(conversationId, { type: "message", ...stored });
    }

    /**
     * Records the Claude session of a conversation.
     */
    public async setSession(conversationId: string, sessionId: string): Promise<void> {
        await this.append(conversationId, { type: "session", sessionId, ts: new Date().toISOString() });
    }

    /**
     * Gets the messages of a conversation, oldest first.
     */
    public async history(conversationId: string): Promise<ChatHistoryEntry[]> {
        return (await this.records(conversationId))
            .filter((record): record is { type: "message" } & ChatHistoryEntry => record.type === "message")
            .map(({ type: _type, ...entry }) => entry);
    }

    /**
     * Gets the last Claude session of a conversation.
     */
    public async lastSession(conversationId: string): Promise<string | undefined> {
        const sessions = (await this.records(conversationId)).filter((record) => record.type === "session");
        return sessions.length > 0 ? (sessions[sessions.length - 1] as { sessionId: string }).sessionId : undefined;
    }

    private async append(conversationId: string, record: ConversationRecord): Promise<void> {
        await appendFile(this.file(conversationId), JSON.stringify(record) + "\n", "utf8");
    }

    private async records(conversationId: string): Promise<ConversationRecord[]> {
        let content: string;
        try {
            content = await readFile(this.file(conversationId), "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return [];
            }
            throw error;
        }
        const records: ConversationRecord[] = [];
        for (const line of content.split("\n")) {
            if (line.trim().length === 0) {
                continue;
            }
            try {
                records.push(JSON.parse(line) as ConversationRecord);
            } catch {
                // skip a line cut short by a crash
            }
        }
        return records;
    }

    private file(conversationId: string): string {
        if (!ConversationStore.ID_PATTERN.test(conversationId)) {
            throw new Error(`Invalid conversation id ${JSON.stringify(conversationId)}`);
        }
        return this.workspace.metaPath(`chat/${conversationId}.jsonl`);
    }

    private static withoutBytes(attachment: Attachment): Attachment {
        if (attachment.kind === "node") {
            const { snapshotPng: _snapshot, ...rest } = attachment;
            return rest;
        }
        if (attachment.kind === "image") {
            return { ...attachment, base64: "" };
        }
        if (attachment.kind === "file") {
            const { base64: _bytes, ...rest } = attachment;
            return rest;
        }
        return attachment;
    }
}
