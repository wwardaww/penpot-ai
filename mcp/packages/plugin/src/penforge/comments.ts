import type { CommentThread, Page } from "@penpot/plugin-types";
import type { NodeLocator } from "./locate.ts";
import type { JsonObject } from "./serialize.ts";

/**
 * Reads and resolves canvas comment threads through the Plugin API.
 *
 * The released Plugin API has gaps that W03 closes: thread ids are only available as the
 * non-enumerable `$id`, `Page.findCommentThreads` returns the threads of the whole file, and threads
 * have no `nodeId`. This class works with both versions. It detects the fixed API by the presence of
 * an enumerable string `id` on threads; with the old API it derives the page from the thread's board
 * and drops threads whose page cannot be known (root-level threads) when a page filter is given.
 */
export class CommentService {
    private static readonly ROOT_ID = "00000000-0000-0000-0000-000000000000";

    private readonly penpot: any;
    private readonly locator: NodeLocator;

    /**
     * @param penpotApi - the Penpot plugin API object
     * @param locator - the node locator of the same file
     */
    constructor(penpotApi: any, locator: NodeLocator) {
        this.penpot = penpotApi;
        this.locator = locator;
    }

    /**
     * Returns the id of a thread for both the fixed (`id`) and the released (`$id`) Plugin API.
     *
     * @param thread - the comment thread
     */
    public static threadId(thread: CommentThread): string | null {
        const t = thread as any;
        const id = typeof t.id === "string" ? t.id : t["$id"];
        return id === undefined || id === null ? null : String(id);
    }

    private static hasPageAwareApi(thread: CommentThread): boolean {
        return typeof (thread as any).id === "string";
    }

    /**
     * Lists comment threads with their comments.
     *
     * @param pageId - optional page filter
     * @param status - "unresolved" (default) or "all"
     */
    public async list(pageId: string | undefined, status: "unresolved" | "all"): Promise<JsonObject[]> {
        const showResolved = status === "all";
        // the page filter needs every page with the released API, since threads carry no page there
        const pages = this.locator.pages();
        if (pageId !== undefined) {
            this.locator.page(pageId);
        }
        const criteria = { onlyYours: false, showResolved };
        const collected: { thread: CommentThread; pageId: string | null }[] = [];
        for (const page of pages) {
            const threads = await page.findCommentThreads(criteria);
            if (threads.length === 0) {
                continue;
            }
            if (!CommentService.hasPageAwareApi(threads[0])) {
                // released API: one call returns the threads of the whole file
                for (const thread of threads) {
                    const threadPageId = this.pageOfBoard(thread);
                    if (pageId === undefined || threadPageId === pageId) {
                        collected.push({ thread, pageId: threadPageId });
                    }
                }
                break;
            }
            // fixed API: each call returns the threads of that page only
            if (pageId === undefined || page.id === pageId) {
                collected.push(...threads.map((thread) => ({ thread, pageId: page.id })));
            }
        }
        if (!showResolved) {
            // the released API defaults showResolved to true; filter again to be safe
            const unresolved = collected.filter((entry) => !entry.thread.resolved);
            collected.length = 0;
            collected.push(...unresolved);
        }
        const seen = new Set<string>();
        const result: JsonObject[] = [];
        for (const entry of collected) {
            const id = CommentService.threadId(entry.thread);
            if (id !== null && seen.has(id)) {
                continue;
            }
            if (id !== null) {
                seen.add(id);
            }
            result.push(await this.serializeThread(entry.thread, entry.pageId));
        }
        result.sort((a, b) => Number(a.seqNumber) - Number(b.seqNumber));
        return result;
    }

    /**
     * Posts an optional note as a reply, then marks the thread as resolved.
     *
     * @param threadId - the thread id
     * @param resolutionNote - optional reply text
     */
    public async resolve(threadId: string, resolutionNote: string | undefined): Promise<JsonObject> {
        const thread = await this.findThread(threadId);
        if (!thread) {
            throw new Error(`Comment thread not found: ${threadId}`);
        }
        const note = resolutionNote?.trim();
        if (note) {
            await thread.reply(note);
        }
        thread.resolved = true;
        return { ok: true, threadId, replied: Boolean(note), resolved: Boolean(thread.resolved) };
    }

    private async findThread(threadId: string): Promise<CommentThread | null> {
        const p = this.penpot;
        if (typeof p.findCommentThreadById === "function") {
            const thread = await p.findCommentThreadById(threadId);
            if (thread) {
                return thread;
            }
        }
        const criteria = { onlyYours: false, showResolved: true };
        for (const page of this.locator.pages() as Page[]) {
            const pageApi = page as any;
            if (typeof pageApi.findCommentThreadById === "function") {
                const thread = await pageApi.findCommentThreadById(threadId);
                if (thread) {
                    return thread;
                }
                continue;
            }
            const threads = await page.findCommentThreads(criteria);
            const match = threads.find((thread) => CommentService.threadId(thread) === threadId);
            if (match) {
                return match;
            }
            if (threads.length > 0 && !CommentService.hasPageAwareApi(threads[0])) {
                // the released API already returned the whole file
                return null;
            }
        }
        return null;
    }

    private boardId(thread: CommentThread): string | null {
        let board: any;
        try {
            board = thread.board;
        } catch {
            return null;
        }
        const id = board ? (board.id ?? board["$id"]) : null;
        if (!id || String(id) === CommentService.ROOT_ID) {
            return null;
        }
        return String(id);
    }

    private pageOfBoard(thread: CommentThread): string | null {
        const boardId = this.boardId(thread);
        if (!boardId) {
            return null;
        }
        const located = this.locator.find(boardId);
        return located ? located.page.id : null;
    }

    private async serializeThread(thread: CommentThread, pageId: string | null): Promise<JsonObject> {
        const t = thread as any;
        const comments = await thread.findComments();
        const position = thread.position;
        return {
            threadId: CommentService.threadId(thread),
            seqNumber: thread.seqNumber,
            pageId,
            boardId: this.boardId(thread),
            nodeId: typeof t.nodeId === "string" ? t.nodeId : null,
            position: position ? { x: position.x, y: position.y } : null,
            resolved: Boolean(thread.resolved),
            comments: comments.map((comment) => ({
                author: comment.user?.name ?? null,
                date: CommentService.isoDate(comment.date),
                content: comment.content,
            })),
        };
    }

    private static isoDate(date: unknown): string | null {
        if (date instanceof Date) {
            return date.toISOString();
        }
        if (typeof date === "string" || typeof date === "number") {
            const parsed = new Date(date);
            return Number.isNaN(parsed.getTime()) ? String(date) : parsed.toISOString();
        }
        return null;
    }
}
