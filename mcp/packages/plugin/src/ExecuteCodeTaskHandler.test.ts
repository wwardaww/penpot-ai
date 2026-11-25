import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as PenpotUtils from "./PenpotUtils.ts";
import * as ErrorUtils from "./ErrorUtils.ts";
import * as CanvasSnapshot from "./penforge/canvasSnapshot.ts";
import * as LayoutCheck from "./penforge/layoutCheck.ts";
import { ExecuteCodeTaskConsole } from "./ExecuteCodeTaskConsole.ts";

type TaskResponse = {
    type: string;
    response: {
        id: string;
        success: boolean;
        data?: unknown;
        error?: string;
    };
};

/** Compiles a TypeScript source file for a simulated plugin context. */
function compile(name: string) {
    return ts.transpileModule(readFileSync(new URL(name, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
}

/**
 * Loads Task + ExecuteCodeTaskHandler with `penpot` / `penpotMgmt` resolved from
 * the outer globalThis (so installPenpot can configure them before construction).
 */
function loadHandler(): { ExecuteCodeTaskHandler: any; Task: any } {
    const taskExports: Record<string, unknown> = {};
    const handlerExports: Record<string, unknown> = {};

    const context: Record<string, unknown> = {
        console,
        exports: taskExports,
        require: (id: string) => {
            if (id === "../TaskHandler" || id.endsWith("/TaskHandler")) {
                return taskExports;
            }
            if (id.includes("common/src")) {
                return {};
            }
            if (id.includes("PenpotUtils")) {
                return PenpotUtils;
            }
            if (id.includes("ExecuteCodeTaskConsole")) {
                return { ExecuteCodeTaskConsole };
            }
            if (id.includes("ErrorUtils")) {
                return ErrorUtils;
            }
            if (id.includes("canvasSnapshot")) {
                return CanvasSnapshot;
            }
            if (id.includes("layoutCheck")) {
                return LayoutCheck;
            }
            throw new Error(`Unexpected import: ${id}`);
        },
    };
    Object.defineProperty(context, "penpot", {
        enumerable: true,
        get: () => (globalThis as any).penpot,
    });
    Object.defineProperty(context, "penpotMgmt", {
        enumerable: true,
        get: () => (globalThis as any).penpotMgmt,
    });

    runInNewContext(compile("TaskHandler.ts"), context);

    context.exports = handlerExports;
    runInNewContext(compile("task-handlers/ExecuteCodeTaskHandler.ts"), context);

    return {
        ExecuteCodeTaskHandler: handlerExports.ExecuteCodeTaskHandler,
        Task: taskExports.Task,
    };
}

function installPenpot(options: { waitForSave?: (() => Promise<void>) | null; workspaceStatus?: string }): {
    messages: TaskResponse[];
} {
    const messages: TaskResponse[] = [];
    const penpot: Record<string, unknown> = {
        flags: {
            naturalChildOrdering: false,
            throwValidationErrors: false,
        },
        waitForLayoutUpdate: async () => undefined,
        ui: {
            sendMessage: (message: TaskResponse) => {
                messages.push(message);
            },
        },
    };
    if (options.waitForSave !== null && options.waitForSave !== undefined) {
        penpot.waitForSave = options.waitForSave;
    }
    (globalThis as any).penpot = penpot;
    (globalThis as any).penpotMgmt =
        options.workspaceStatus === undefined ? undefined : { workspace: { status: options.workspaceStatus } };
    return { messages };
}

function lastResponse(messages: TaskResponse[]) {
    assert.ok(messages.length > 0, "expected a task response");
    return messages[messages.length - 1].response;
}

test("awaits waitForSave before reporting success", async () => {
    let resolveSave!: () => void;
    let waitForSaveCalls = 0;
    const saveGate = new Promise<void>((resolve) => {
        resolveSave = resolve;
    });
    const { messages } = installPenpot({
        waitForSave: async () => {
            waitForSaveCalls += 1;
            return saveGate;
        },
    });

    const { ExecuteCodeTaskHandler, Task } = loadHandler();
    const handler = new ExecuteCodeTaskHandler();
    const task = new Task("req-1", "executeCode", { code: "return 42;" });
    const done = handler.handle(task);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(messages.length, 0, "must not succeed before save settles");
    assert.equal(waitForSaveCalls, 1, "must call waitForSave after the code runs");

    resolveSave();
    await done;

    const response = lastResponse(messages);
    assert.equal(response.success, true);
    assert.equal((response.data as any).result, 42);
});

test("reports an error when waitForSave rejects", async () => {
    const { messages } = installPenpot({
        waitForSave: async () => {
            throw new Error("Changes could not be saved");
        },
    });

    const { ExecuteCodeTaskHandler, Task } = loadHandler();
    const handler = new ExecuteCodeTaskHandler();
    const task = new Task("req-2", "executeCode", { code: "return 1;" });
    await assert.rejects(handler.handle(task), /could not be saved/i);
    assert.equal(messages.length, 0, "must not report success");
});

test("hard-fails when waitForSave is missing", async () => {
    const { messages } = installPenpot({ waitForSave: null });

    const { ExecuteCodeTaskHandler, Task } = loadHandler();
    const handler = new ExecuteCodeTaskHandler();
    const task = new Task("req-3", "executeCode", { code: "return 1;" });
    await assert.rejects(handler.handle(task), /waitForSave/);
    assert.equal(messages.length, 0, "must not report success");
});

for (const workspaceStatus of ["none", "loading"]) {
    test(`skips waitForSave when the workspace is ${workspaceStatus}`, async () => {
        let waitForSaveCalls = 0;
        const { messages } = installPenpot({
            workspaceStatus,
            waitForSave: async () => {
                waitForSaveCalls += 1;
                throw new Error("Changes could not be saved");
            },
        });

        const { ExecuteCodeTaskHandler, Task } = loadHandler();
        const handler = new ExecuteCodeTaskHandler();
        const task = new Task("req-4", "executeCode", { code: "return 7;" });
        await handler.handle(task);

        assert.equal(waitForSaveCalls, 0, "no workspace edit can be pending");
        const response = lastResponse(messages);
        assert.equal(response.success, true);
        assert.equal((response.data as any).result, 7);
    });
}

test("awaits waitForSave when the workspace is ready", async () => {
    const { messages } = installPenpot({
        workspaceStatus: "ready",
        waitForSave: async () => {
            throw new Error("Changes could not be saved");
        },
    });

    const { ExecuteCodeTaskHandler, Task } = loadHandler();
    const handler = new ExecuteCodeTaskHandler();
    const task = new Task("req-5", "executeCode", { code: "return 1;" });
    await assert.rejects(handler.handle(task), /could not be saved/i);
    assert.equal(messages.length, 0, "must not report success");
});

/** A page whose root takes shapes; `penpot.add(shape)` puts one on it. */
function installPage() {
    const { messages } = installPenpot({ waitForSave: async () => undefined });
    const penpot = (globalThis as any).penpot;
    const root: any = { id: "root", children: [] };
    penpot.currentPage = { id: "page", root };
    penpot.root = root;
    penpot.add = (shape: any) => {
        shape.parent = root;
        root.children = [...root.children, shape];
        return shape;
    };
    return { messages, penpot };
}

const BOARD = `{ id: "b1", type: "board", name: "Landing", children: [], bounds: { x: 0, y: 0, width: 10, height: 10 } }`;

async function run(params: Record<string, unknown>) {
    const { ExecuteCodeTaskHandler, Task } = loadHandler();
    const handler = new ExecuteCodeTaskHandler();
    await handler.handle(new Task("req", "executeCode", params));
}

test("a failed script names the shapes it left on the page", async () => {
    installPage();
    const code = `penpot.add(${BOARD}); throw new Error("boom");`;
    await assert.rejects(run({ code, trackShapes: true }), (error: Error) => {
        assert.match(error.message, /boom\nThe script was not rolled back\./);
        assert.match(error.message, /board "Landing" b1\. Remove them by id/);
        return true;
    });
});

test("a failed script that added nothing keeps its own error", async () => {
    installPage();
    await assert.rejects(run({ code: `throw new Error("boom");`, trackShapes: true }), /^Error: boom$/);
    await assert.rejects(run({ code: `penpot.add(${BOARD}); throw new Error("boom");` }), /^Error: boom$/);
});

test("the layout is checked only when asked, also for later scripts on the same board", async () => {
    const { messages } = installPage();
    const { ExecuteCodeTaskHandler, Task } = loadHandler();
    const handler = new ExecuteCodeTaskHandler();
    const call = async (code: string, checkLayout: boolean) => {
        await handler.handle(new Task("req", "executeCode", { code, trackShapes: true, checkLayout }));
        return lastResponse(messages).data as any;
    };
    assert.equal("layoutProblems" in (await call("return 1;", false)), false);
    const empty = ['board "Landing" b1 is empty; remove it by id if a failed script left it'];
    assert.deepEqual([...(await call(`penpot.add(${BOARD});`, true)).layoutProblems], empty);
    assert.deepEqual([...(await call("return 1;", true)).layoutProblems], empty);
    assert.deepEqual([...(await call("penpot.root.children = [];", true)).layoutProblems], []);
});

test("layout work that never settles delays a call by a short wait only", async () => {
    const { messages, penpot } = installPage();
    const timeouts: unknown[] = [];
    penpot.waitForLayoutUpdate = async (timeout?: number) => {
        timeouts.push(timeout);
        throw new Error("waitForLayoutUpdate timeout");
    };
    const { ExecuteCodeTaskHandler, Task } = loadHandler();
    const handler = new ExecuteCodeTaskHandler();
    await handler.handle(
        new Task("req", "executeCode", { code: `penpot.add(${BOARD});`, trackShapes: true, checkLayout: true })
    );
    assert.deepEqual(timeouts, [5000, 5000], "both waits pass a short timeout");
    const data = lastResponse(messages).data as any;
    assert.deepEqual(
        [...data.layoutProblems],
        ['board "Landing" b1 is empty; remove it by id if a failed script left it']
    );
});

test("calls without effect come back as warnings, once", async () => {
    const { messages } = installPage();
    const code = `
        const row = { id: "r", name: "Row", x: 0, y: 0, flex: {} };
        const child = { parent: row, layoutChild: { absolute: false } };
        penpotUtils.setParentXY(child, 5, 5);
        penpotUtils.setParentXY(child, 6, 6);`;
    await run({ code });
    const { warnings } = lastResponse(messages).data as any;
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no effect on the children of "Row" r: its flex layout places them/);
    await run({ code: "return 1;" });
    assert.equal("warnings" in (lastResponse(messages).data as any), false);
});
