import { randomUUID } from "crypto";
import { readdir } from "fs/promises";
import { join } from "path";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import type { ComponentBrief } from "./ConformanceScripts";
import type { MissingItem } from "./types";

/** Item handed to the design system tab. */
export interface AddTaskItem {
    id: string;
    kind: MissingItem["kind"];
    name: string;
    reason: string;
    /** outline of the project's own component (what it looks like today) */
    brief: ComponentBrief | null;
}

/** What the design system tab made. */
export interface AddTaskResult {
    created: { itemId: string; componentId: string; name: string }[];
    failed: { itemId: string; reason: string }[];
    checkpoint: { id: string; n: number } | null;
}

/**
 * "Add to design system" across two tabs (W30). The plugin edits only the file open in its tab,
 * so the project tab writes a task into the design system project's `.penforge/`, the client opens
 * the design system file in a new tab, that tab runs `design-system-missing {action:"build"}`
 * with its own plugin, and the project tab's run waits here for the result.
 */
export interface AddTask {
    version: 1;
    taskId: string;
    createdAt: string;
    systemFileId: string;
    systemProjectId: string;
    project: { projectId: string; fileId: string; fileName: string };
    items: AddTaskItem[];
    status: "open" | "building" | "done" | "failed";
    result?: AddTaskResult;
    error?: string;
    finishedAt?: string;
}

/** Task id format. */
const TASK_ID = /^[0-9a-f-]{36}$/;

/** Files `design-system-tasks/<id>.json` of the design system project. */
export class AddTaskStore {
    public static readonly DIR = "design-system-tasks";

    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    public static newId(): string {
        return randomUUID();
    }

    public static validId(taskId: unknown): taskId is string {
        return typeof taskId === "string" && TASK_ID.test(taskId);
    }

    public async read(taskId: string): Promise<AddTask | null> {
        if (!AddTaskStore.validId(taskId)) {
            return null;
        }
        return this.workspace.readJson<AddTask | null>(`${AddTaskStore.DIR}/${taskId}.json`, null);
    }

    /**
     * The newest open task for a design system file (the tab that opens the file picks it up), or
     * null. Tasks older than `maxAgeMs` are left alone.
     */
    public async pendingFor(systemFileId: string, maxAgeMs = 30 * 60_000): Promise<AddTask | null> {
        let names: string[];
        try {
            names = await readdir(join(this.workspace.metaDir, AddTaskStore.DIR));
        } catch {
            return null;
        }
        let newest: AddTask | null = null;
        for (const name of names) {
            const task = name.endsWith(".json") ? await this.read(name.slice(0, -5)).catch(() => null) : null;
            if (
                task &&
                task.status === "open" &&
                task.systemFileId === systemFileId &&
                Date.now() - Date.parse(task.createdAt) <= maxAgeMs &&
                (!newest || task.createdAt > newest.createdAt)
            ) {
                newest = task;
            }
        }
        return newest;
    }

    public async write(task: AddTask): Promise<void> {
        if (!AddTaskStore.validId(task.taskId)) {
            throw new Error("Invalid task id");
        }
        await this.workspace.writeJson(`${AddTaskStore.DIR}/${task.taskId}.json`, task);
    }
}

/** Waiters of the project tabs, by task id (both tabs talk to this daemon process). */
const waiters = new Map<string, Set<(task: AddTask) => void>>();

/** In-process signal between the two tabs of an "Add to design system" task. */
export const AddTaskSignals = {
    /** Wakes the project tab's run waiting for the task. */
    finished(task: AddTask): void {
        for (const wake of waiters.get(task.taskId) ?? []) {
            wake(task);
        }
    },

    /**
     * Waits until the task is done or failed: woken by {@link finished}, and reading the task
     * file every `pollMs` as a fallback.
     *
     * @returns the finished task, or null on timeout
     */
    async wait(
        store: AddTaskStore,
        taskId: string,
        signal: { aborted: boolean; addEventListener?: (type: "abort", listener: () => void) => void },
        timeoutMs: number,
        pollMs = 3000
    ): Promise<AddTask | null> {
        const finished = (task: AddTask | null) =>
            task !== null && (task.status === "done" || task.status === "failed");
        const now = await store.read(taskId);
        if (finished(now)) {
            return now;
        }
        return new Promise<AddTask | null>((resolve, reject) => {
            let settled = false;
            const set = waiters.get(taskId) ?? new Set();
            waiters.set(taskId, set);
            const done = (task: AddTask | null, error?: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearInterval(poll);
                clearTimeout(timer);
                set.delete(wake);
                if (set.size === 0) {
                    waiters.delete(taskId);
                }
                if (error) {
                    reject(error);
                } else {
                    resolve(task);
                }
            };
            const wake = (task: AddTask) => done(task);
            set.add(wake);
            const poll = setInterval(() => {
                if (signal.aborted) {
                    done(null, new Error("cancelled"));
                    return;
                }
                store.read(taskId).then(
                    (task) => {
                        if (finished(task)) {
                            done(task);
                        }
                    },
                    () => undefined
                );
            }, pollMs);
            const timer = setTimeout(() => done(null), timeoutMs);
            signal.addEventListener?.("abort", () => done(null, new Error("cancelled")));
        });
    },
};
