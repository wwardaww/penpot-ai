import type { Workflow, WorkflowContext } from "@penpot/mcp-common";
import { ensureCheckpoint } from "../checkpoints";
import {
    AddTaskSignals,
    AddTaskStore,
    BindingFailure,
    BindingRun,
    ConformanceChecker,
    ConformanceScripts,
    DesignSystemConformance,
    DesignSystemTurnCheck,
    MissingItems,
    siblingWorkspace,
    sourceMapFixes,
    type AddTask,
    type AddTaskResult,
    type ComponentBrief,
    type DesignSystemBinding,
    type MissingItem,
    type SystemCatalog,
} from "../designsystem/conformance";
import type { SourceMap } from "../designsystem/extract";

/** Params of `design-system-missing`. */
export type DesignSystemMissingParams =
    | { action: "list" }
    | { action: "keep"; ids: string[] }
    | { action: "add"; ids: string[] }
    | { action: "build"; taskId: string }
    | { action: "pending" };

/** Event that asks the client to open the design system file in a new tab. */
export const OPEN_EVENT = "open-design-system";

/** How long the project tab waits for the design system tab. */
export const ADD_TIMEOUT_MS = 20 * 60_000;
/** How long the project tab waits for the new components to arrive through the library. */
export const LIBRARY_WAIT_MS = 90_000;
const LIBRARY_POLL_MS = 3000;

/** Tunables (tests shorten them). */
export const timing = {
    addTimeoutMs: ADD_TIMEOUT_MS,
    libraryWaitMs: LIBRARY_WAIT_MS,
    libraryPollMs: LIBRARY_POLL_MS,
    taskPollMs: 3000,
};

/**
 * `design-system-missing` (W30): the list of things the project's design system lacks and the
 * user's single decision about them.
 *
 * - `list` → `result {action, items}`.
 * - `keep {ids}` ("Don't add") → the items stay the project's own; the check leaves them alone.
 * - `add {ids}` ("Add to design system", project tab) → writes a task for the design system
 *   project, asks the client to open the design system file in a new tab (event
 *   `open-design-system {fileId, projectId, taskId}`), waits for that tab, then waits for the new
 *   components to reach this file through the library and swaps the project's own ones for them.
 * - `pending` (design system tab, silent) → `result {action, taskId|null, count, project}`: the
 *   open task the project tab left for this file.
 * - `build {taskId}` (design system tab) → Claude makes new, system-conformant components for the
 *   task's items in the design system file and tags them; the waiting project tab continues.
 */
export const workflow: Workflow<DesignSystemMissingParams> = {
    name: "design-system-missing",
    description: "Decide about the items the design system lacks",
    run: async (ctx, params) => {
        const run = new BindingRun(ctx);
        const result = await run.guard(async () => {
            switch (params?.action) {
                case "list":
                    return list(ctx);
                case "keep":
                    return keep(ctx, params.ids);
                case "add":
                    return add(ctx, run, params.ids);
                case "build":
                    return build(ctx, run, params.taskId);
                case "pending":
                    return pending(ctx);
                default:
                    throw new BindingFailure("bad-params", "Unknown action");
            }
        });
        ctx.emit("result", result);
        return { summary: result.summary };
    },
};

async function requireBinding(ctx: WorkflowContext): Promise<DesignSystemBinding> {
    const binding = await DesignSystemConformance.binding(ctx.workspace);
    if (!binding) {
        throw new BindingFailure("not-linked", "This project uses no design system yet");
    }
    return binding;
}

function cleanIds(ids: unknown): string[] {
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string").slice(0, 100) : [];
}

async function list(ctx: WorkflowContext) {
    const binding = await requireBinding(ctx);
    const items = await new MissingItems(ctx.workspace, binding.fileId).all();
    return { action: "list" as const, items, summary: `${items.filter((i) => i.status === "open").length} open items` };
}

async function keep(ctx: WorkflowContext, ids: unknown) {
    const binding = await requireBinding(ctx);
    const wanted = cleanIds(ids);
    if (wanted.length === 0) {
        throw new BindingFailure("no-items", "No items given");
    }
    const kept = await new MissingItems(ctx.workspace, binding.fileId).setStatus(wanted, "kept");
    return {
        action: "keep" as const,
        kept: kept.map((item) => item.id),
        summary: `Kept ${kept.length} of the project's own items`,
    };
}

async function add(ctx: WorkflowContext, run: BindingRun, ids: unknown) {
    const binding = await requireBinding(ctx);
    const missing = new MissingItems(ctx.workspace, binding.fileId);
    const wanted = new Set(cleanIds(ids));
    const items = (await missing.all()).filter(
        (item) => wanted.has(item.id) && item.status !== "kept" && item.status !== "added"
    );
    if (items.length === 0) {
        throw new BindingFailure("no-items", "No open items to add");
    }

    run.progress("prepare", "Preparing the items for the design system", { count: items.length });
    const scripts = new ConformanceScripts(ctx.tools);
    const componentIds = items.map((item) => item.componentId).filter((id): id is string => typeof id === "string");
    const briefs = componentIds.length
        ? await scripts.run<ComponentBrief[]>(ConformanceScripts.briefScript(componentIds)).catch(() => [])
        : [];
    const taskId = AddTaskStore.newId();
    const store = new AddTaskStore(siblingWorkspace(ctx.workspace, binding.projectId));
    const task: AddTask = {
        version: 1,
        taskId,
        createdAt: new Date().toISOString(),
        systemFileId: binding.fileId,
        systemProjectId: binding.projectId,
        project: { projectId: ctx.context.projectId, fileId: ctx.context.fileId, fileName: ctx.context.fileName },
        items: items.map((item) => ({
            id: item.id,
            kind: item.kind,
            name: item.name,
            reason: item.reason,
            brief: briefs.find((brief) => brief.componentId === item.componentId) ?? null,
        })),
        status: "open",
    };
    await store.write(task);
    await missing.setStatus(
        items.map((item) => item.id),
        "adding"
    );

    run.progress("open-tab", `Opening the design system "${binding.name}" in a new tab`);
    ctx.emit(OPEN_EVENT, { fileId: binding.fileId, projectId: binding.projectId, taskId, name: binding.name });
    run.progress("wait", "Waiting for the design system tab");
    let finished: AddTask | null;
    try {
        finished = await AddTaskSignals.wait(store, taskId, ctx.signal, timing.addTimeoutMs, timing.taskPollMs);
    } catch (error) {
        await missing.setStatus(
            items.map((item) => item.id),
            "open"
        );
        throw error;
    }
    if (!finished || finished.status !== "done" || !finished.result) {
        await missing.setStatus(
            items.map((item) => item.id),
            "open"
        );
        throw finished
            ? new BindingFailure("internal", finished.error ?? "The design system tab could not add the items")
            : new BindingFailure("timeout", "The design system tab did not finish in time");
    }
    const result = finished.result;
    const createdBy = new Map(result.created.map((created) => [created.itemId, created]));
    await missing.setStatus(
        items.filter((item) => createdBy.has(item.id)).map((item) => item.id),
        "added",
        Object.fromEntries(
            [...createdBy.entries()].map(([itemId, created]) => [itemId, { systemComponentId: created.componentId }])
        )
    );
    await missing.setStatus(
        items.filter((item) => !createdBy.has(item.id)).map((item) => item.id),
        "open"
    );

    run.progress("swap", "Using the new design system components in the project");
    const swapped = await swapToSystem(ctx, run, binding, items, result);
    return {
        action: "add" as const,
        taskId,
        created: result.created,
        failed: result.failed,
        checkpoint: result.checkpoint,
        swapped,
        summary:
            `Added ${result.created.length} items to "${binding.name}"` +
            (swapped > 0 ? ` and used them in ${swapped} places` : ""),
    };
}

/** Waits for the new components in the linked library, then swaps the project's own for them. */
async function swapToSystem(
    ctx: WorkflowContext,
    run: BindingRun,
    binding: DesignSystemBinding,
    items: MissingItem[],
    result: AddTaskResult
): Promise<number> {
    const conformance = new DesignSystemConformance(ctx.tools, ctx.workspace, ctx.context.fileId);
    const wantedIds = new Set(result.created.map((created) => created.componentId));
    if (wantedIds.size === 0) {
        return 0;
    }
    const deadline = Date.now() + timing.libraryWaitMs;
    let catalog: SystemCatalog | null = null;
    for (;;) {
        run.stopIfCancelled();
        catalog = (await conformance.catalog(binding)).catalog;
        if (catalog.components.filter((component) => wantedIds.has(component.id)).length === wantedIds.size) {
            break;
        }
        if (Date.now() >= deadline) {
            throw new BindingFailure(
                "library-not-updated",
                "The new components have not reached this file yet; the next design system check uses them"
            );
        }
        await new Promise((resolve) => setTimeout(resolve, timing.libraryPollMs));
    }
    const mapping: SourceMap["components"] = {};
    for (const item of items) {
        const created = result.created.find((c) => c.itemId === item.id);
        if (item.componentId && created) {
            mapping[item.componentId] = {
                componentId: created.componentId,
                name: created.name,
                path: "",
                status: "kept",
            };
        }
    }
    if (Object.keys(mapping).length === 0) {
        return 0;
    }
    const scan = await conformance.scan({ pages: "all", maxLayers: 20000 });
    const map = { components: mapping, layers: {}, colors: {} } as unknown as SourceMap;
    const fixes = sourceMapFixes(map, scan.layers, catalog, ctx.context.fileId).filter(
        (fix) => fix.code !== "color-linked"
    );
    const pageOf = Object.fromEntries(scan.layers.map((layer) => [layer.id, layer.pageId]));
    const report = await conformance.apply(catalog.libraryId, ConformanceChecker.ops(fixes), pageOf);
    return Math.max(0, fixes.length - report.failed.length);
}

async function pending(ctx: WorkflowContext) {
    const task = await new AddTaskStore(ctx.workspace).pendingFor(ctx.context.fileId);
    return {
        action: "pending" as const,
        taskId: task?.taskId ?? null,
        count: task?.items.length ?? 0,
        project: task?.project ?? null,
        summary: task ? `${task.items.length} items to add` : "Nothing to add",
    };
}

async function build(ctx: WorkflowContext, run: BindingRun, taskId: unknown) {
    if (!AddTaskStore.validId(taskId)) {
        throw new BindingFailure("task-missing", "Unknown task");
    }
    const store = new AddTaskStore(ctx.workspace);
    const task = await store.read(taskId);
    if (!task) {
        throw new BindingFailure("task-missing", "Unknown task");
    }
    if (task.systemFileId !== ctx.context.fileId) {
        throw new BindingFailure("wrong-file", "This tab shows another file than the design system");
    }
    if (task.status === "done") {
        return { action: "build" as const, taskId, ...task.result!, summary: "Already done" };
    }
    task.status = "building";
    await store.write(task);
    try {
        run.progress("checkpoint", "Saving a checkpoint");
        const checkpoint = await ensureCheckpoint(ctx, "Before adding items from a project", "design-system-missing");
        run.progress("build", `Making ${task.items.length} new components`, { count: task.items.length });
        await ctx.runner.run({ prompt: buildPrompt(task), promptName: "design-system-missing" });
        const tagged = await new ConformanceScripts(ctx.tools).run<
            { itemId: string; componentId: string; name: string }[]
        >(ConformanceScripts.taggedItemsScript());
        const ids = new Set(task.items.map((item) => item.id));
        const created = tagged.filter((entry) => ids.has(entry.itemId));
        const createdIds = new Set(created.map((entry) => entry.itemId));
        const result: AddTaskResult = {
            created,
            failed: task.items
                .filter((item) => !createdIds.has(item.id))
                .map((item) => ({ itemId: item.id, reason: "not made" })),
            checkpoint: checkpoint ? { id: checkpoint.id, n: checkpoint.n } : null,
        };
        const done: AddTask = { ...task, status: "done", result, finishedAt: new Date().toISOString() };
        await store.write(done);
        AddTaskSignals.finished(done);
        return {
            action: "build" as const,
            taskId,
            ...result,
            project: task.project,
            summary: `Made ${created.length} of ${task.items.length} components`,
        };
    } catch (error) {
        const failed: AddTask = {
            ...task,
            status: "failed",
            error: ctx.signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error),
            finishedAt: new Date().toISOString(),
        };
        await store.write(failed).catch(() => undefined);
        AddTaskSignals.finished(failed);
        throw error;
    }
}

function buildPrompt(task: AddTask): string {
    const lines = [`Project: "${task.project.fileName}". Items to add (${task.items.length}):`];
    for (const item of task.items) {
        lines.push(`- item id \`${item.id}\` — ${item.kind} "${item.name}": ${item.reason}`);
        if (item.brief?.outline) {
            lines.push("  The project's own version today (for meaning only, do not copy):");
            lines.push(...item.brief.outline.split("\n").map((line) => `    ${line}`));
        }
    }
    return lines.join("\n");
}

/** Missing items as the client lists them (re-exported for tests). */
export const itemsPayload = DesignSystemTurnCheck.itemsPayload;
