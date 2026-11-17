import type { AuditFinding, AuditPoint } from "./AuditFinding";
import type { DesignReader } from "./TreeLoader";

/** Comment thread as returned by the `list_canvas_comments` tool. */
export interface CanvasThread {
    threadId: string;
    seqNumber?: number;
    pageId?: string | null;
    boardId?: string | null;
    nodeId?: string | null;
    position?: AuditPoint | null;
    resolved?: boolean;
    comments: { author?: string; date?: string; content: string }[];
}

/** Outcome of posting findings as canvas comments. */
export interface PostResult {
    /** new threads, by finding id */
    posted: Map<string, string>;
    /** findings that already had an open audit thread, by finding id */
    duplicates: Map<string, string>;
    /** findings left out because of the comment limit */
    overLimit: string[];
}

/**
 * Canvas comments of the design audit: posts findings as `[Audit]` threads and finds the open ones.
 *
 * Threads are created with `Page.addCommentThread` through `execute_code` (no typed tool creates
 * comments) at the finding's position in page coordinates, on the page made active first. A finding
 * is a duplicate when an open audit thread with the same title sits on the same node, or within a
 * few pixels of the same spot.
 */
export class AuditComments {
    /** Prefix of every audit comment. */
    public static readonly PREFIX = "[Audit]";

    private static readonly MAX_LENGTH = 750;
    private static readonly SAME_SPOT_PX = 6;
    private static readonly BATCH = 15;

    constructor(private readonly reader: DesignReader) {}

    /**
     * Text of the comment for a finding.
     *
     * @param finding - the finding
     */
    public static content(finding: AuditFinding): string {
        const text = `${AuditComments.PREFIX} ${finding.title}: ${finding.message}\nSuggested fix: ${finding.suggestion}`;
        return text.length > AuditComments.MAX_LENGTH ? text.slice(0, AuditComments.MAX_LENGTH - 1) + "…" : text;
    }

    /**
     * Tells whether a thread was opened by the audit.
     *
     * @param thread - the thread
     */
    public static isAuditThread(thread: CanvasThread): boolean {
        return (thread.comments[0]?.content ?? "").trimStart().startsWith(AuditComments.PREFIX);
    }

    /**
     * Lists the unresolved audit threads of a page.
     *
     * @param pageId - the page id
     */
    public async openThreads(pageId: string): Promise<CanvasThread[]> {
        const threads = await this.reader.call("list_canvas_comments", { pageId, status: "unresolved" });
        return (Array.isArray(threads) ? (threads as CanvasThread[]) : []).filter(
            (thread) => !thread.resolved && Array.isArray(thread.comments) && AuditComments.isAuditThread(thread)
        );
    }

    /**
     * Finds the open audit thread that already reports a finding.
     *
     * @param finding - the finding
     * @param threads - open audit threads
     */
    public static duplicateOf(finding: AuditFinding, threads: CanvasThread[]): CanvasThread | undefined {
        const head = `${AuditComments.PREFIX} ${finding.title}:`;
        return threads.find((thread) => {
            if (!thread.comments[0].content.trimStart().startsWith(head)) {
                return false;
            }
            if (thread.nodeId && thread.nodeId === finding.nodeId) {
                return true;
            }
            const p = thread.position;
            return (
                !!p &&
                Math.abs(p.x - finding.position.x) <= AuditComments.SAME_SPOT_PX &&
                Math.abs(p.y - finding.position.y) <= AuditComments.SAME_SPOT_PX
            );
        });
    }

    /**
     * Posts findings as comments, skipping duplicates of open audit threads.
     *
     * @param pageId - the page of the findings
     * @param findings - the findings, most important first
     * @param maxComments - maximum number of new threads
     */
    public async post(pageId: string, findings: AuditFinding[], maxComments: number): Promise<PostResult> {
        const existing = await this.openThreads(pageId);
        const result: PostResult = { posted: new Map(), duplicates: new Map(), overLimit: [] };
        const toPost: { finding: AuditFinding; position: AuditPoint }[] = [];
        const used: AuditPoint[] = [];
        for (const finding of findings) {
            const duplicate = AuditComments.duplicateOf(finding, existing);
            if (duplicate) {
                result.duplicates.set(finding.id, duplicate.threadId);
            } else if (toPost.length >= maxComments) {
                result.overLimit.push(finding.id);
            } else {
                toPost.push({ finding, position: AuditComments.freeSpot(finding.position, used) });
            }
        }
        for (let i = 0; i < toPost.length; i += AuditComments.BATCH) {
            const batch = toPost.slice(i, i + AuditComments.BATCH);
            const created = await this.create(
                pageId,
                batch.map(({ finding, position }) => ({
                    key: finding.id,
                    content: AuditComments.content(finding),
                    x: position.x,
                    y: position.y,
                }))
            );
            for (const { key, threadId } of created) {
                result.posted.set(key, threadId);
            }
        }
        return result;
    }

    /**
     * Moves a comment spot a little when another new comment already sits there.
     */
    private static freeSpot(position: AuditPoint, used: AuditPoint[]): AuditPoint {
        let spot = { ...position };
        while (used.some((p) => Math.abs(p.x - spot.x) < 10 && Math.abs(p.y - spot.y) < 10)) {
            spot = { x: spot.x + 12, y: spot.y };
        }
        used.push(spot);
        return spot;
    }

    private async create(
        pageId: string,
        items: { key: string; content: string; x: number; y: number }[]
    ): Promise<{ key: string; threadId: string }[]> {
        // replacer functions keep "$" sequences of the texts literal
        const code = AuditComments.CREATE_CODE.replace("__PAGE_ID__", () => JSON.stringify(pageId)).replace(
            "__ITEMS__",
            () => JSON.stringify(items)
        );
        const created = await this.reader.call("execute_code", { code });
        return Array.isArray(created) ? (created as { key: string; threadId: string }[]) : [];
    }

    // runs in the plugin; threads anchor on the active page, so the page is opened first
    private static readonly CREATE_CODE = `
const pageId = __PAGE_ID__;
const items = __ITEMS__;
const page = penpot.currentFile.pages.find((p) => p.id === pageId);
if (!page) { throw new Error("Page not found: " + pageId); }
if (!penpot.currentPage || penpot.currentPage.id !== pageId) { await penpot.openPage(page); }
const active = penpot.currentPage;
const created = [];
for (const item of items) {
  const thread = await active.addCommentThread(item.content, { x: item.x, y: item.y });
  created.push({ key: item.key, threadId: String(thread.id ?? thread["$id"]) });
}
return created;
`;
}
