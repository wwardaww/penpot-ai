import { randomUUID } from "crypto";
import type {
    AnswerParams,
    ChatUsage,
    WorkflowCancelMessage,
    WorkflowClaudeRequest,
    WorkflowClaudeResult,
    WorkflowContext,
    WorkflowEventKind,
    WorkflowQuestion,
    WorkflowRunMessage,
} from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { AgentError, type AgentClient } from "../AgentClient";
import { ToolSummary } from "../chat/toolSummary";
import type { TurnRunner, TurnSetup } from "../chat/TurnRunner";
import { WorkflowRegistry } from "./WorkflowRegistry";

/** Pending question of a run. */
interface PendingQuestion {
    optionIds: Set<string>;
    resolve: (optionId: string) => void;
    reject: (error: Error) => void;
}

/** Running workflow. */
interface WorkflowRun {
    runId: string;
    clientId: string;
    abort: AbortController;
    questions: Map<string, PendingQuestion>;
}

/**
 * Engine running workflows for clients (`workflow.run`, `workflow.cancel`).
 *
 * Gives each run a {@link WorkflowContext}, reports `workflow.started` / `workflow.event` /
 * `workflow.done`, and implements questions: `ctx.ask()` sends a `question` event and waits for the
 * built-in `answer` workflow. Runs are aborted when cancelled or when their client disconnects.
 */
export class WorkflowEngine {
    private readonly logger = createLogger("WorkflowEngine");
    private readonly runs = new Map<string, WorkflowRun>();

    constructor(
        private readonly registry: WorkflowRegistry,
        private readonly turns: TurnRunner
    ) {}

    /**
     * Handles `workflow.run`; resolves when the run is over.
     */
    public async run(client: AgentClient, message: WorkflowRunMessage): Promise<void> {
        if (message.name === WorkflowRegistry.ANSWER) {
            this.answer(client, message.params ?? {});
            return;
        }
        const workflow = this.registry.get(message.name);
        if (!workflow) {
            throw new AgentError("unknown-workflow", `Unknown workflow ${JSON.stringify(message.name)}`);
        }
        const setup = await client.setup();
        const run: WorkflowRun = {
            runId: randomUUID(),
            clientId: client.id,
            abort: new AbortController(),
            questions: new Map(),
        };
        const onClose = () => run.abort.abort();
        client.closed.addEventListener("abort", onClose, { once: true });
        run.abort.signal.addEventListener("abort", () => this.rejectQuestions(run), { once: true });
        this.runs.set(run.runId, run);
        client.send({ type: "workflow.started", rid: message.rid, runId: run.runId, name: workflow.name });

        const ctx = this.context(client, { ...setup, signal: run.abort.signal }, run, workflow.name);
        try {
            const result = await workflow.run(ctx, message.params ?? {});
            if (run.abort.signal.aborted) {
                throw new Error("cancelled");
            }
            client.send({ type: "workflow.done", runId: run.runId, ok: true, summary: result?.summary ?? "Done" });
        } catch (error) {
            const reason = run.abort.signal.aborted ? "cancelled" : WorkflowEngine.describe(error);
            this.logger.warn("Workflow %s (%s) failed: %s", workflow.name, run.runId, reason);
            client.send({
                type: "workflow.done",
                runId: run.runId,
                ok: false,
                summary: reason === "cancelled" ? "Stopped" : "Could not finish",
                error: reason,
            });
        } finally {
            client.closed.removeEventListener("abort", onClose);
            this.rejectQuestions(run);
            this.runs.delete(run.runId);
        }
    }

    /**
     * Handles `workflow.cancel`.
     */
    public cancel(client: AgentClient, message: WorkflowCancelMessage): void {
        const run = this.runs.get(message.runId);
        if (!run || run.clientId !== client.id) {
            throw new AgentError("bad-request", "No such run");
        }
        run.abort.abort();
    }

    /** Aborts every run. */
    public cancelAll(): void {
        for (const run of this.runs.values()) {
            run.abort.abort();
        }
    }

    private context(client: AgentClient, setup: TurnSetup, run: WorkflowRun, workflowName: string): WorkflowContext {
        const engine = this;
        let turnCount = 0;
        return {
            runId: run.runId,
            context: setup.context,
            workspace: setup.workspace,
            tools: setup.tools ?? WorkflowEngine.NO_TOOLS,
            signal: run.abort.signal,
            emit(kind: WorkflowEventKind, payload: unknown): void {
                client.send({ type: "workflow.event", runId: run.runId, kind, payload });
            },
            ask(question: WorkflowQuestion): Promise<string> {
                return engine.ask(client, run, question);
            },
            runner: {
                run: (request: WorkflowClaudeRequest) =>
                    this.claudeTurn(client, setup, run, `${workflowName}`, `wf-${run.runId}-${++turnCount}`, request),
            },
        };
    }

    private async claudeTurn(
        client: AgentClient,
        setup: TurnSetup,
        run: WorkflowRun,
        workflowName: string,
        conversationId: string,
        request: WorkflowClaudeRequest
    ): Promise<WorkflowClaudeResult> {
        let text = "";
        let sessionId: string | undefined;
        let usage: ChatUsage | undefined;
        const events = this.turns.run(
            setup,
            { id: conversationId, resumeSessionId: request.resumeSessionId },
            {
                text: request.prompt,
                attachments: request.attachments,
                workflow: request.promptName ?? workflowName,
                systemPromptAppend: request.systemPromptAppend,
            }
        );
        for await (const event of events) {
            request.onEvent?.(event);
            switch (event.kind) {
                case "session":
                    sessionId = event.sessionId;
                    break;
                case "text":
                    text += event.text;
                    break;
                case "tool":
                    client.send({
                        type: "workflow.event",
                        runId: run.runId,
                        kind: "progress",
                        payload: {
                            summary: ToolSummary.summary(event.toolName, event.status, setup.context.persona),
                            status: event.status,
                        },
                    });
                    break;
                case "done":
                    text = event.text || text;
                    usage = event.usage;
                    break;
                case "error":
                    throw new Error(event.message);
            }
        }
        return { text, sessionId, usage };
    }

    private ask(client: AgentClient, run: WorkflowRun, question: WorkflowQuestion): Promise<string> {
        if (run.abort.signal.aborted) {
            return Promise.reject(new Error("cancelled"));
        }
        if (!Array.isArray(question.options) || question.options.length === 0) {
            return Promise.reject(new Error("A question needs at least one option"));
        }
        const questionId = randomUUID();
        return new Promise<string>((resolve, reject) => {
            run.questions.set(questionId, {
                optionIds: new Set(question.options.map((option) => option.id)),
                resolve: (optionId) => {
                    run.questions.delete(questionId);
                    resolve(optionId);
                },
                reject: (error) => {
                    run.questions.delete(questionId);
                    reject(error);
                },
            });
            client.send({
                type: "workflow.event",
                runId: run.runId,
                kind: "question",
                payload: { questionId, text: question.text, options: question.options },
            });
        });
    }

    /**
     * Applies the built-in `answer` workflow to a pending question.
     */
    private answer(client: AgentClient, params: Record<string, unknown>): void {
        const { runId, questionId, optionId } = params as Partial<AnswerParams>;
        const run = typeof runId === "string" ? this.runs.get(runId) : undefined;
        const question =
            run && run.clientId === client.id && typeof questionId === "string"
                ? run.questions.get(questionId)
                : undefined;
        if (!question) {
            throw new AgentError("bad-request", "No such pending question");
        }
        if (typeof optionId !== "string" || !question.optionIds.has(optionId)) {
            throw new AgentError("bad-request", "Unknown option");
        }
        question.resolve(optionId);
    }

    private rejectQuestions(run: WorkflowRun): void {
        for (const question of [...run.questions.values()]) {
            question.reject(new Error("cancelled"));
        }
    }

    private static describe(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private static readonly NO_TOOLS = {
        call: () => Promise.reject(new Error("Penpot tools are not available")),
        list: () => Promise.resolve([] as string[]),
    };
}
