import type { Attachment, ImageAttachment, Persona, WorkflowContext } from "@penpot/mcp-common";

/** Comment of a canvas thread, as returned by `list_canvas_comments`. */
export interface CanvasComment {
    author: string | null;
    date: string | null;
    content: string;
}

/** Canvas comment thread, as returned by `list_canvas_comments`. */
export interface CanvasThread {
    threadId: string;
    seqNumber: number;
    pageId: string | null;
    boardId: string | null;
    nodeId: string | null;
    position: { x: number; y: number } | null;
    resolved: boolean;
    comments: CanvasComment[];
}

/** Outcome of fixing one thread. */
export type FixOutcome = "fixed" | "no-change" | "failed";

/** Report of fixing one thread. */
export interface FixReport {
    threadId: string;
    seqNumber: number;
    outcome: FixOutcome;
    /** short text for the designer (also posted on the thread when it was replied to) */
    note: string;
    /** the thread was marked as resolved */
    resolved: boolean;
    /** the note was posted as a reply */
    replied: boolean;
}

/** What the caller already knows about the thread. */
export interface FixHint {
    /** the change the comment asks for, in a few words (from the batch classification) */
    request?: string;
}

/**
 * Verdict that closes a fix turn: the last JSON object of Claude's answer with an `outcome` key.
 */
export class FixVerdict {
    private static readonly OUTCOMES = new Set<FixOutcome>(["fixed", "no-change", "failed"]);
    private static readonly MAX_NOTE_CHARS = 1000;

    private constructor(
        public readonly outcome: FixOutcome,
        public readonly note: string
    ) {}

    /**
     * Parses the verdict of a fix turn.
     *
     * @param text - Claude's final answer
     * @returns the verdict, or null when the answer has none
     */
    public static parse(text: string): FixVerdict | null {
        const candidates = text.match(/\{[^{}]*"outcome"[^{}]*\}/g) ?? [];
        for (const candidate of candidates.reverse()) {
            try {
                const value = JSON.parse(candidate) as { outcome?: unknown; note?: unknown };
                if (typeof value.outcome === "string" && FixVerdict.OUTCOMES.has(value.outcome as FixOutcome)) {
                    const note = typeof value.note === "string" ? value.note.trim() : "";
                    return new FixVerdict(value.outcome as FixOutcome, note.slice(0, FixVerdict.MAX_NOTE_CHARS));
                }
            } catch {
                // not JSON; try the previous candidate
            }
        }
        return null;
    }
}

/**
 * Fixer of canvas comment threads, shared by the `fix-comment` and `fix-comments` workflows.
 *
 * Reads the thread's layer fresh from the canvas, lets Claude apply the requested change with the
 * typed MCP tools, then resolves the thread with Claude's note. Comments that ask for nothing get
 * the note as a reply and stay open, so the designer decides.
 */
export class CommentFixer {
    private static readonly LIST_TOOL = "list_canvas_comments";
    private static readonly PROPERTIES_TOOL = "get_node_properties";
    private static readonly SCREENSHOT_TOOL = "capture_node_screenshot";
    private static readonly RESOLVE_TOOL = "resolve_canvas_comment";
    private static readonly EXECUTE_TOOL = "execute_code";
    private static readonly PROMPT_NAME = "fix-comment";
    private static readonly MAX_PROPERTIES_CHARS = 8000;

    /**
     * @param ctx - context of the workflow run
     */
    constructor(private readonly ctx: WorkflowContext) {}

    /** Persona of the tab the run belongs to. */
    public get persona(): Persona {
        return this.ctx.context.persona;
    }

    /**
     * Lists comment threads.
     *
     * @param pageId - only threads of this page; all pages when omitted
     * @param status - `unresolved` or `all`
     * @throws Error if the tool fails
     */
    public async listThreads(pageId: string | undefined, status: "unresolved" | "all"): Promise<CanvasThread[]> {
        const args: Record<string, unknown> = { status };
        if (pageId) {
            args.pageId = pageId;
        }
        const result = await this.ctx.tools.call(CommentFixer.LIST_TOOL, args);
        if (result.isError) {
            throw new Error(`Could not read the comments: ${result.text}`);
        }
        const value = JSON.parse(result.text || "[]") as unknown;
        if (!Array.isArray(value)) {
            throw new Error("Unexpected comment list");
        }
        return value.filter(CommentFixer.isThread);
    }

    /**
     * Finds a thread, resolved ones included.
     *
     * @param threadId - the thread id
     * @param pageId - page to look on first; the whole file is searched when it is not there
     * @returns the thread, or null
     */
    public async findThread(threadId: string, pageId?: string): Promise<CanvasThread | null> {
        if (pageId) {
            const onPage = (await this.listThreads(pageId, "all")).find((thread) => thread.threadId === threadId);
            if (onPage) {
                return onPage;
            }
        }
        return (await this.listThreads(undefined, "all")).find((thread) => thread.threadId === threadId) ?? null;
    }

    /**
     * Fixes one thread.
     *
     * @param thread - the thread
     * @param hint - what the caller already knows about it
     */
    public async fix(thread: CanvasThread, hint: FixHint = {}): Promise<FixReport> {
        const target = thread.nodeId ?? thread.boardId;
        const properties = target ? await this.readProperties(target) : null;
        this.checkCancelled();
        const image = target ? await this.capture(target, target !== thread.boardId) : null;
        this.checkCancelled();

        const attachments: Attachment[] = image ? [image] : [];
        const answer = await this.ctx.runner.run({
            prompt: CommentFixer.prompt(thread, target, properties, image !== null, hint),
            promptName: CommentFixer.PROMPT_NAME,
            attachments: attachments.length > 0 ? attachments : undefined,
        });
        this.checkCancelled();

        const verdict = FixVerdict.parse(answer.text);
        const base = { threadId: thread.threadId, seqNumber: thread.seqNumber };
        if (!verdict || verdict.outcome === "failed") {
            return {
                ...base,
                outcome: "failed",
                note: verdict?.note || CommentFixer.lastLine(answer.text),
                resolved: false,
                replied: false,
            };
        }
        if (verdict.outcome === "fixed") {
            const resolved = await this.resolve(thread.threadId, verdict.note);
            return { ...base, outcome: "fixed", note: verdict.note, resolved, replied: resolved && !!verdict.note };
        }
        const replied = verdict.note ? await this.reply(thread.threadId, verdict.note) : false;
        return { ...base, outcome: "no-change", note: verdict.note, resolved: false, replied };
    }

    /**
     * Throws when the run was cancelled.
     */
    public checkCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }

    /**
     * Gets the text of a thread's comments, one `author: content` line each.
     *
     * @param thread - the thread
     */
    public static conversation(thread: CanvasThread): string {
        return thread.comments
            .map((comment) => `${comment.author ?? "Someone"}: ${comment.content.replace(/\s+/g, " ").trim()}`)
            .join("\n");
    }

    private async readProperties(nodeId: string): Promise<string | null> {
        try {
            const result = await this.ctx.tools.call(CommentFixer.PROPERTIES_TOOL, { nodeId, depth: 2 });
            if (result.isError || !result.text) {
                return null;
            }
            return result.text.length > CommentFixer.MAX_PROPERTIES_CHARS
                ? `${result.text.slice(0, CommentFixer.MAX_PROPERTIES_CHARS)}\n…(truncated)`
                : result.text;
        } catch {
            return null;
        }
    }

    private async capture(nodeId: string, small: boolean): Promise<ImageAttachment | null> {
        try {
            const result = await this.ctx.tools.call(CommentFixer.SCREENSHOT_TOOL, {
                nodeId,
                scale: small ? 2 : 1,
                format: "png",
                padding: small ? 24 : 0,
            });
            if (result.isError) {
                return null;
            }
            const block = result.content.find(
                (part: any) => part?.type === "image" && typeof part.data === "string"
            ) as { data: string; mimeType?: string } | undefined;
            return block ? { kind: "image", mime: block.mimeType ?? "image/png", base64: block.data } : null;
        } catch {
            return null;
        }
    }

    private async resolve(threadId: string, note: string): Promise<boolean> {
        const args: Record<string, unknown> = { threadId };
        if (note) {
            args.resolutionNote = note;
        }
        try {
            const result = await this.ctx.tools.call(CommentFixer.RESOLVE_TOOL, args);
            if (result.isError) {
                return false;
            }
            const value = JSON.parse(result.text) as { resolved?: unknown };
            return value.resolved === true;
        } catch {
            return false;
        }
    }

    private async reply(threadId: string, note: string): Promise<boolean> {
        try {
            const result = await this.ctx.tools.call(CommentFixer.EXECUTE_TOOL, {
                code: CommentFixer.replyCode(threadId, note),
            });
            return !result.isError;
        } catch {
            return false;
        }
    }

    /**
     * Builds the plugin code that replies to a thread without resolving it.
     *
     * Values are embedded as JSON literals, so no text is ever interpolated as code.
     */
    private static replyCode(threadId: string, note: string): string {
        return [
            `const threadId = ${JSON.stringify(threadId)};`,
            `const note = ${JSON.stringify(note)};`,
            "let thread = null;",
            'if (typeof penpot.findCommentThreadById === "function") {',
            "  thread = await penpot.findCommentThreadById(threadId);",
            "}",
            "for (const page of (thread ? [] : penpot.currentFile.pages)) {",
            '  if (typeof page.findCommentThreadById === "function") {',
            "    thread = await page.findCommentThreadById(threadId);",
            "    if (thread) { break; }",
            "  }",
            "}",
            'if (!thread) { throw new Error("Comment thread not found: " + threadId); }',
            "await thread.reply(note);",
            "return { replied: true };",
        ].join("\n");
    }

    private static prompt(
        thread: CanvasThread,
        target: string | null,
        properties: string | null,
        hasImage: boolean,
        hint: FixHint
    ): string {
        const lines = [
            `Comment thread #${thread.seqNumber} (threadId ${thread.threadId}) on page ${thread.pageId ?? "unknown"}:`,
            CommentFixer.conversation(thread),
            "",
        ];
        if (hint.request) {
            lines.push(`It was read as this change request: ${hint.request}`, "");
        }
        if (target) {
            lines.push(
                `The comment points at layer ${target}` +
                    (thread.boardId && thread.boardId !== target ? ` inside board ${thread.boardId}` : "") +
                    (thread.position ? ` (canvas point ${thread.position.x}, ${thread.position.y}).` : ".")
            );
        } else {
            lines.push(
                "The comment is not on any layer" +
                    (thread.position ? ` (canvas point ${thread.position.x}, ${thread.position.y}).` : ".")
            );
        }
        if (properties) {
            lines.push("Its properties, read from the canvas just now:", properties);
        }
        if (hasImage) {
            lines.push("A screenshot of it, taken just now, is attached.");
        }
        lines.push(
            "",
            "Read the layer again with get_node_properties before you change anything, then fix the comment " +
                "as your instructions say and end with the verdict line."
        );
        return lines.join("\n");
    }

    private static lastLine(text: string): string {
        const lines = text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        return (lines[lines.length - 1] ?? "").slice(0, 500);
    }

    private static isThread(value: unknown): value is CanvasThread {
        const thread = value as Partial<CanvasThread> | null;
        return (
            typeof thread === "object" &&
            thread !== null &&
            typeof thread.threadId === "string" &&
            Array.isArray(thread.comments)
        );
    }
}
