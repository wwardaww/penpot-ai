import type { Persona, Workflow, WorkflowContext } from "@penpot/mcp-common";
import { type CanvasThread, CommentFixer, type FixReport } from "./fix-comment-fixer";

/** Params of the `fix-comments` workflow. */
export interface FixCommentsParams {
    /** `page` (default): unresolved threads of one page; `file`: of every page */
    scope?: "page" | "file";
    /** page for the `page` scope; defaults to the tab's current page */
    pageId?: string;
}

/** Kind of a comment, as sorted by the classification turn. */
export type CommentKind = "change-request" | "question" | "informational";

/** Thread left open on purpose. */
export interface SkippedThread {
    threadId: string;
    seqNumber: number;
    reason: "informational" | "no-change" | "conflict";
    note: string;
}

/** Thread the designer has to look at. */
export interface NeedsYouThread {
    threadId: string;
    seqNumber: number;
    reason: "question" | "conflict" | "failed" | "not-resolved";
    note: string;
}

/** `result` event of a `fix-comments` run. */
export interface FixCommentsResult {
    fixed: FixReport[];
    skipped: SkippedThread[];
    needsYou: NeedsYouThread[];
}

/** Change requests that cannot all be applied. */
export interface CommentConflict {
    threadIds: string[];
    /** question for the designer, in plain words */
    question: string;
    /** short option label per thread id */
    labels: Record<string, string>;
}

/** Result of the classification turn. */
export interface Classification {
    kinds: Map<string, { kind: CommentKind; request: string }>;
    conflicts: CommentConflict[];
}

/**
 * Classifier of comment threads: one Claude turn without tools sorts every thread into change
 * request, question or informational, and names change requests that contradict each other.
 */
export class CommentClassifier {
    private static readonly PROMPT_NAME = "fix-comments";
    private static readonly KINDS = new Set<CommentKind>(["change-request", "question", "informational"]);

    /**
     * @param ctx - context of the workflow run
     */
    constructor(private readonly ctx: WorkflowContext) {}

    /**
     * Classifies threads.
     *
     * When the answer cannot be read, every thread counts as a change request without conflicts:
     * the fix turn of each thread still decides whether there is anything to change.
     *
     * @param threads - the threads
     */
    public async classify(threads: CanvasThread[]): Promise<Classification> {
        const answer = await this.ctx.runner.run({
            prompt: CommentClassifier.prompt(threads),
            promptName: CommentClassifier.PROMPT_NAME,
        });
        return CommentClassifier.parse(answer.text, threads);
    }

    /**
     * Reads the classification answer.
     *
     * @param text - Claude's answer
     * @param threads - the classified threads
     */
    public static parse(text: string, threads: CanvasThread[]): Classification {
        const known = new Set(threads.map((thread) => thread.threadId));
        const kinds = new Map<string, { kind: CommentKind; request: string }>();
        const value = CommentClassifier.json(text);
        const entries = Array.isArray(value?.threads) ? (value.threads as unknown[]) : [];
        for (const entry of entries) {
            const item = entry as { threadId?: unknown; kind?: unknown; request?: unknown };
            if (
                typeof item?.threadId === "string" &&
                known.has(item.threadId) &&
                typeof item.kind === "string" &&
                CommentClassifier.KINDS.has(item.kind as CommentKind)
            ) {
                kinds.set(item.threadId, {
                    kind: item.kind as CommentKind,
                    request: typeof item.request === "string" ? item.request.trim() : "",
                });
            }
        }
        for (const thread of threads) {
            if (!kinds.has(thread.threadId)) {
                kinds.set(thread.threadId, { kind: "change-request", request: "" });
            }
        }

        const conflicts: CommentConflict[] = [];
        const taken = new Set<string>();
        const rawConflicts = Array.isArray(value?.conflicts) ? (value.conflicts as unknown[]) : [];
        for (const entry of rawConflicts) {
            const item = entry as { threadIds?: unknown; question?: unknown; labels?: unknown };
            const ids = Array.isArray(item?.threadIds)
                ? [
                      ...new Set(
                          item.threadIds.filter(
                              (id): id is string =>
                                  typeof id === "string" && kinds.get(id)?.kind === "change-request" && !taken.has(id)
                          )
                      ),
                  ]
                : [];
            if (ids.length < 2) {
                continue;
            }
            ids.forEach((id) => taken.add(id));
            const labels: Record<string, string> = {};
            const rawLabels = (item.labels ?? {}) as Record<string, unknown>;
            for (const id of ids) {
                if (typeof rawLabels[id] === "string" && rawLabels[id]) {
                    labels[id] = (rawLabels[id] as string).trim().slice(0, 120);
                }
            }
            conflicts.push({
                threadIds: ids,
                question: typeof item.question === "string" ? item.question.trim() : "",
                labels,
            });
        }
        return { kinds, conflicts };
    }

    private static json(text: string): { threads?: unknown; conflicts?: unknown } | null {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        const body = fenced ? fenced[1] : text;
        const start = body.indexOf("{");
        const end = body.lastIndexOf("}");
        if (start < 0 || end <= start) {
            return null;
        }
        try {
            return JSON.parse(body.slice(start, end + 1));
        } catch {
            return null;
        }
    }

    private static prompt(threads: CanvasThread[]): string {
        const byNode = new Map<string, number[]>();
        for (const thread of threads) {
            const node = thread.nodeId ?? thread.boardId;
            if (node) {
                byNode.set(node, [...(byNode.get(node) ?? []), thread.seqNumber]);
            }
        }
        const shared = [...byNode.values()].filter((numbers) => numbers.length > 1);
        const list = threads.map((thread) => ({
            threadId: thread.threadId,
            seqNumber: thread.seqNumber,
            layer: thread.nodeId ?? thread.boardId,
            board: thread.boardId,
            comments: CommentFixer.conversation(thread),
        }));
        const lines = ["Open comment threads:", JSON.stringify(list, null, 2)];
        if (shared.length > 0) {
            lines.push(
                "",
                "Threads on the same layer: " +
                    shared.map((numbers) => numbers.map((n) => `#${n}`).join(", ")).join("; ")
            );
        }
        lines.push("", "Sort them as your instructions say and answer with the JSON object only.");
        return lines.join("\n");
    }
}

/**
 * Lookup of another daemon workflow by name.
 */
export interface WorkflowLookup {
    find(name: string): Promise<Workflow<any> | undefined>;
}

/**
 * Lookup in the workflows shipped with the daemon (`workflows/index.ts`).
 *
 * Imports the index lazily, as it also exports the workflow that uses this lookup.
 */
export class ShippedWorkflowLookup implements WorkflowLookup {
    public async find(name: string): Promise<Workflow<any> | undefined> {
        const shipped = (await import("./index")) as Record<string, unknown>;
        return Object.values(shipped).find(
            (value): value is Workflow<any> => (value as Workflow<any> | null)?.name === name
        );
    }
}

/**
 * Checkpoint taken before a batch changes the design, through the W19 `checkpoint-create`
 * workflow when the daemon ships it; skipped otherwise.
 */
export class CheckpointStep {
    public static readonly WORKFLOW = "checkpoint-create";

    /**
     * @param lookup - finds the checkpoint workflow
     */
    constructor(private readonly lookup: WorkflowLookup) {}

    /**
     * Creates a checkpoint.
     *
     * @param ctx - context of the run
     * @param label - checkpoint label
     * @param workflowName - workflow the checkpoint belongs to
     * @returns true if a checkpoint was created
     */
    public async create(ctx: WorkflowContext, label: string, workflowName: string): Promise<boolean> {
        const checkpoint = await this.lookup.find(CheckpointStep.WORKFLOW);
        if (!checkpoint) {
            return false;
        }
        try {
            await checkpoint.run(ctx, { label, workflow: workflowName });
            return true;
        } catch (error) {
            if (ctx.signal.aborted) {
                throw error;
            }
            ctx.emit("log", { text: `Checkpoint failed: ${error instanceof Error ? error.message : String(error)}` });
            return false;
        }
    }
}

/**
 * Wording of the `fix-comments` run for the designer and the developer persona.
 */
class FixCommentsWording {
    public static reading(scope: "page" | "file"): string {
        return scope === "file" ? "Reading the comments of the file" : "Reading the comments of this page";
    }

    public static sorting(count: number): string {
        return count === 1 ? "Reading 1 comment" : `Reading ${count} comments`;
    }

    public static conflict(threads: CanvasThread[]): string {
        const numbers = threads.map((thread) => `#${thread.seqNumber}`);
        const list = `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
        return `Comments ${list} ask for different things on the same layer. Which one should I apply?`;
    }

    public static fixing(persona: Persona, seqNumber: number, index: number, total: number): string {
        return persona === "developer"
            ? `Fixing comment #${seqNumber} (${index} of ${total})`
            : `Working on comment #${seqNumber} (${index} of ${total})`;
    }

    public static summary(persona: Persona, result: FixCommentsResult): string {
        const { fixed, skipped, needsYou } = result;
        if (fixed.length + skipped.length + needsYou.length === 0) {
            return "No open comments to fix";
        }
        const numbers = (items: { seqNumber: number }[]) => items.map((item) => `#${item.seqNumber}`).join(", ");
        const plural = (count: number) => (count === 1 ? "comment" : "comments");
        const parts = [`Fixed ${fixed.length} ${plural(fixed.length)}`];
        if (persona === "developer" && fixed.length > 0) {
            parts[0] += ` (${numbers(fixed)})`;
        }
        if (skipped.length > 0) {
            parts.push(
                `left ${skipped.length} without changes` + (persona === "developer" ? ` (${numbers(skipped)})` : "")
            );
        }
        if (needsYou.length > 0) {
            parts.push(`${needsYou.length} ${plural(needsYou.length)} need you (${numbers(needsYou)})`);
        }
        return parts.join(", ");
    }
}

/**
 * Creates the `fix-comments` workflow.
 *
 * @param lookup - finds the checkpoint workflow
 */
export function createFixCommentsWorkflow(
    lookup: WorkflowLookup = new ShippedWorkflowLookup()
): Workflow<FixCommentsParams> {
    const checkpoints = new CheckpointStep(lookup);
    return {
        name: "fix-comments",
        description: "Fixes every open change-request comment of the page or file.",
        run: async (ctx, params) => {
            const scope = params?.scope === "file" ? "file" : "page";
            const pageId =
                scope === "file"
                    ? undefined
                    : typeof params?.pageId === "string" && params.pageId
                      ? params.pageId
                      : ctx.context.pageId;
            const persona = ctx.context.persona;
            const fixer = new CommentFixer(ctx);
            const result: FixCommentsResult = { fixed: [], skipped: [], needsYou: [] };

            // a. open threads
            ctx.emit("progress", { step: "reading", text: FixCommentsWording.reading(scope) });
            const threads = (await fixer.listThreads(pageId, "unresolved")).filter((thread) => !thread.resolved);
            if (threads.length === 0) {
                ctx.emit("result", result);
                return { summary: FixCommentsWording.summary(persona, result) };
            }
            const byId = new Map(threads.map((thread) => [thread.threadId, thread]));

            // b. kinds and conflicts
            fixer.checkCancelled();
            ctx.emit("progress", { step: "sorting", text: FixCommentsWording.sorting(threads.length) });
            const { kinds, conflicts } = await new CommentClassifier(ctx).classify(threads);
            const toFix: CanvasThread[] = [];
            for (const thread of threads) {
                const { kind } = kinds.get(thread.threadId)!;
                const base = { threadId: thread.threadId, seqNumber: thread.seqNumber, note: "" };
                if (kind === "informational") {
                    result.skipped.push({ ...base, reason: "informational" });
                } else if (kind === "question") {
                    result.needsYou.push({ ...base, reason: "question" });
                } else {
                    toFix.push(thread);
                }
            }

            // c. one question per conflict
            const dropped = new Set<string>();
            for (const conflict of conflicts) {
                fixer.checkCancelled();
                const conflicting = conflict.threadIds.map((id) => byId.get(id)!);
                const choice = await ctx.ask({
                    text: conflict.question || FixCommentsWording.conflict(conflicting),
                    options: [
                        ...conflicting.map((thread) => ({
                            id: thread.threadId,
                            label: conflict.labels[thread.threadId] || `Apply #${thread.seqNumber}`,
                        })),
                        { id: "skip", label: "Skip these" },
                    ],
                });
                for (const thread of conflicting) {
                    if (thread.threadId === choice) {
                        continue;
                    }
                    dropped.add(thread.threadId);
                    const base = { threadId: thread.threadId, seqNumber: thread.seqNumber, note: "" };
                    if (choice === "skip") {
                        result.needsYou.push({ ...base, reason: "conflict" });
                    } else {
                        result.skipped.push({ ...base, reason: "conflict" });
                    }
                }
            }
            const queue = toFix.filter((thread) => !dropped.has(thread.threadId));

            // d. checkpoint
            if (queue.length > 0) {
                fixer.checkCancelled();
                ctx.emit("progress", { step: "checkpoint", text: "Saving a checkpoint" });
                await checkpoints.create(ctx, "Before fixing comments", "fix-comments");
            }

            // e. one fix at a time
            for (const [index, thread] of queue.entries()) {
                fixer.checkCancelled();
                const base = { threadId: thread.threadId, seqNumber: thread.seqNumber };
                ctx.emit("progress", {
                    ...base,
                    step: "fixing",
                    index: index + 1,
                    total: queue.length,
                    text: FixCommentsWording.fixing(persona, thread.seqNumber, index + 1, queue.length),
                });
                const report = await fixer.fix(thread, { request: kinds.get(thread.threadId)!.request });
                ctx.emit("progress", {
                    ...base,
                    step: "fixed",
                    index: index + 1,
                    total: queue.length,
                    outcome: report.outcome,
                    text: `Comment #${thread.seqNumber} done (${index + 1} of ${queue.length})`,
                });
                if (report.outcome === "fixed") {
                    result.fixed.push(report);
                    if (!report.resolved) {
                        result.needsYou.push({ ...base, reason: "not-resolved", note: report.note });
                    }
                } else if (report.outcome === "no-change") {
                    result.skipped.push({ ...base, reason: "no-change", note: report.note });
                } else {
                    result.needsYou.push({ ...base, reason: "failed", note: report.note });
                }
            }

            // f. summary
            const order = (a: { seqNumber: number }, b: { seqNumber: number }) => a.seqNumber - b.seqNumber;
            result.skipped.sort(order);
            result.needsYou.sort(order);
            ctx.emit("result", result);
            return { summary: FixCommentsWording.summary(persona, result) };
        },
    };
}

/**
 * Fixes every open change-request comment of a page (or the whole file): sorts the threads with
 * one Claude turn, asks the designer once per conflicting group, takes a checkpoint, fixes the
 * rest one by one and reports what was fixed, skipped and left for the designer.
 *
 * Events: `progress` `{text, step, threadId?, seqNumber?, index?, total?, outcome?}`, `question`
 * per conflict, `result` = {@link FixCommentsResult}.
 */
export const workflow: Workflow<FixCommentsParams> = createFixCommentsWorkflow();
