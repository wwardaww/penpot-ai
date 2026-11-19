import { appendFile, readFile, rename, writeFile } from "fs/promises";
import type { Attachment, ChatHistoryEntry } from "@penpot/mcp-common";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";

/** Line of a conversation file. */
type ConversationRecord =
    | ({ type: "message" } & ChatHistoryEntry)
    | { type: "session"; sessionId: string; ts: string }
    /** W19 checkpoint a turn saved before its first change (W37), linked to the turn's user message */
    | { type: "checkpoint"; messageId: string; checkpointId: string; ts: string };

/**
 * How much of a conversation a message action drops: the user message and every later message
 * (`from`: edit, revert), or the user message and its answer only (`turn`: delete).
 */
export type ConversationCutMode = "from" | "turn";

/** What a message action drops from a conversation (see {@link ConversationStore.planCut}). */
export class ConversationCut {
    constructor(
        /** the user message the action is about */
        public readonly target: ChatHistoryEntry,
        /** the dropped user and assistant messages, oldest first (the target first) */
        public readonly removed: ChatHistoryEntry[],
        /** checkpoints the dropped turns saved, oldest first */
        public readonly checkpoints: string[],
        /** the records the conversation file keeps */
        readonly kept: readonly unknown[]
    ) {}

    /** Ids of the dropped messages. */
    public removedIds(): string[] {
        return this.removed.map((entry) => entry.messageId);
    }
}

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
     * Links the W19 checkpoint a turn saved to the turn's user message.
     */
    public async setCheckpoint(conversationId: string, messageId: string, checkpointId: string): Promise<void> {
        await this.append(conversationId, {
            type: "checkpoint",
            messageId,
            checkpointId,
            ts: new Date().toISOString(),
        });
    }

    /**
     * Whether a conversation holds a message with this id.
     */
    public async hasMessage(conversationId: string, messageId: string): Promise<boolean> {
        return (await this.records(conversationId)).some(
            (record) => record.type === "message" && record.messageId === messageId
        );
    }

    /**
     * Works out what a message action drops, without changing the file.
     *
     * @param conversationId - the conversation
     * @param messageId - a user message of it
     * @param mode - drop every message from it on (`from`), or it and its answer (`turn`)
     * @returns the cut, or null when the conversation has no such user message
     */
    public async planCut(
        conversationId: string,
        messageId: string,
        mode: ConversationCutMode
    ): Promise<ConversationCut | null> {
        const records = await this.records(conversationId);
        const start = records.findIndex(
            (record) => record.type === "message" && record.role === "user" && record.messageId === messageId
        );
        if (start < 0) {
            return null;
        }
        let end = records.length;
        if (mode === "turn") {
            const next = records.findIndex(
                (record, index) => index > start && record.type === "message" && record.role === "user"
            );
            end = next < 0 ? records.length : next;
        }
        const dropped = records.slice(start, end);
        const removed = dropped
            .filter((record): record is { type: "message" } & ChatHistoryEntry => record.type === "message")
            .map(({ type: _type, ...entry }) => entry);
        const checkpoints = dropped
            .filter((record) => record.type === "checkpoint")
            .map((record) => (record as { checkpointId: string }).checkpointId);
        // every session is dropped: Claude's session remembers the dropped turns
        const kept = [...records.slice(0, start), ...records.slice(end)].filter((record) => record.type !== "session");
        return new ConversationCut(removed[0], removed, checkpoints, kept);
    }

    /**
     * Applies a cut: rewrites the conversation file with the kept records (atomically, through a
     * temporary file). The conversation keeps no Claude session afterwards, so the next turn starts
     * a new one.
     */
    public async applyCut(conversationId: string, cut: ConversationCut): Promise<void> {
        const file = this.file(conversationId);
        const temp = `${file}.tmp`;
        const content = cut.kept.map((record) => `${JSON.stringify(record)}\n`).join("");
        await writeFile(temp, content, "utf8");
        await rename(temp, file);
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
        if (attachment.kind === "folder") {
            return { ...attachment, files: attachment.files.map(({ path, size }) => ({ path, size })) };
        }
        return attachment;
    }
}
