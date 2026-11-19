import type { ChatHistoryEntry } from "@penpot/mcp-common";

/**
 * System prompt section that gives a new Claude session the kept messages of a conversation.
 *
 * After the user edits, deletes or reverts a message, the conversation drops the Claude session
 * (it remembers the dropped turns). The next turn starts a new session and gets this recap of the
 * messages that remain instead: the newest ones, each cut to {@link MAX_MESSAGE_CHARS}, at most
 * {@link MAX_TOTAL_CHARS} in all. Dropped messages are not in it, so Claude cannot remember them.
 */
export class ConversationRecap {
    /** Most messages in a recap (the newest). */
    public static readonly MAX_MESSAGES = 30;
    /** Longest text of one message in a recap. */
    public static readonly MAX_MESSAGE_CHARS = 2000;
    /** Longest recap. */
    public static readonly MAX_TOTAL_CHARS = 16000;

    /**
     * Builds the recap section.
     *
     * @param history - the kept messages, oldest first
     * @returns the section, or undefined when there is nothing to recall
     */
    public static text(history: readonly ChatHistoryEntry[]): string | undefined {
        const lines: string[] = [];
        let total = 0;
        for (const entry of [...history].reverse().slice(0, ConversationRecap.MAX_MESSAGES)) {
            const line = ConversationRecap.line(entry);
            if (total + line.length > ConversationRecap.MAX_TOTAL_CHARS) {
                break;
            }
            total += line.length;
            lines.unshift(line);
        }
        if (lines.length === 0) {
            return undefined;
        }
        const skipped = history.length - lines.length;
        return [
            "## Earlier in this conversation",
            "This conversation started before this message, in a session you no longer have. These are " +
                "the messages it still holds, oldest first; long ones are shortened. Take them as what was " +
                "said so far. The design on the canvas is the current state: read it again before you " +
                "change it.",
            ...(skipped > 0 ? [`(${skipped} older messages left out.)`] : []),
            "",
            ...lines,
        ].join("\n");
    }

    private static line(entry: ChatHistoryEntry): string {
        const who = entry.role === "user" ? "User" : "You";
        const text = entry.text.replace(/\s+/g, " ").trim();
        const short =
            text.length > ConversationRecap.MAX_MESSAGE_CHARS
                ? `${text.slice(0, ConversationRecap.MAX_MESSAGE_CHARS - 1)}…`
                : text;
        const files = (entry.attachments ?? []).length;
        const attached = files > 0 ? ` [${files} attachment${files === 1 ? "" : "s"}]` : "";
        return `${who}: ${short}${attached}`;
    }
}
