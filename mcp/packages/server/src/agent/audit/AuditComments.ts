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
 * comments) at the finding's position in page coordinates, on the page made active first. Each
 * comment ends with `Ref: <ref>`, the short hash of the finding's stable id; a finding is a
 * duplicate when an open audit thread carries its ref, wherever the thread sits.
 */
export class AuditComments {
    /** Prefix of every audit comment. */
    public static readonly PREFIX = "[Audit]";

    private static readonly MAX_LENGTH = 750;
    private static readonly BATCH = 15;
    private static readonly REF_PATTERN = /\bRef: (A-[0-9a-f]{8})\s*$/;

    constructor(private readonly reader: DesignReader) {}

    /**
     * Text of the comment for a finding.
     *
     * @param finding - the finding
     */
    public static content(finding: AuditFinding): string {
        const ref = `\nRef: ${finding.ref}`;
        const max = AuditComments.MAX_LENGTH - ref.length;
        const text = `${AuditComments.PREFIX} ${finding.title}: ${finding.message}\nSuggested fix: ${finding.suggestion}`;
        return (text.length > max ? text.slice(0, max - 1) + "…" : text) + ref;
    }

    /**
     * Ref of the finding an audit thread reports, from its first comment.
     *
     * @param thread - the thread
     * @returns the ref, or null for threads without one
     */
    public static refOf(thread: CanvasThread): string | null {
        const match = AuditComments.REF_PATTERN.exec(thread.comments[0]?.content ?? "");
        return match ? match[1] : null;
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
        return threads.find((thread) => AuditComments.refOf(thread) === finding.ref);
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
