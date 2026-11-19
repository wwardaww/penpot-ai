import type {
    WorkflowContext,
    WorkflowEventKind,
    WorkflowQuestion,
    WorkflowRunnerApi,
    WorkflowToolsApi,
} from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { Checkpoints } from "../checkpoints";
import type { ToolPermissionHandler, ToolUseDecision, ToolUseRequest } from "../runner/ClaudeRunner";
import { CanvasCheck } from "./CanvasCheck";
import type { TurnSetup } from "./TurnRunner";

/**
 * Saver and restorer of the checkpoints chat turns take (W37). A strategy, so that tests can do
 * without git and the Penpot plugin.
 */
export interface ChatCheckpointStore {
    /**
     * Saves a checkpoint of the design and code of the client's project.
     *
     * @returns the checkpoint id, or null when none could be saved (never throws)
     */
    save(setup: TurnSetup, label: string): Promise<string | null>;

    /**
     * Restores a checkpoint without asking (the client asked the user).
     *
     * @throws Error when the design or the code could not be put back
     */
    restore(setup: TurnSetup, checkpointId: string): Promise<void>;
}

/**
 * Chat checkpoints as W19 checkpoints (`agent/checkpoints`): a Penpot file version plus commits of
 * `design/` and `app-src/`, listed in the AI history like the ones workflows save.
 */
export class W19ChatCheckpoints implements ChatCheckpointStore {
    /** Workflow name recorded on chat checkpoints. */
    public static readonly WORKFLOW = "chat";
    private readonly logger = createLogger("ChatCheckpoints");

    public async save(setup: TurnSetup, label: string): Promise<string | null> {
        try {
            const checkpoint = await new Checkpoints(this.context(setup)).create({
                label,
                workflow: W19ChatCheckpoints.WORKFLOW,
            });
            return checkpoint.id;
        } catch (error) {
            // the turn still runs; it just cannot be reverted to
            this.logger.warn("No checkpoint before the chat turn: %s", String(error));
            return null;
        }
    }

    public async restore(setup: TurnSetup, checkpointId: string): Promise<void> {
        const result = await new Checkpoints(this.context(setup)).restore({ id: checkpointId, confirmed: true });
        if (!result) {
            throw new Error("The checkpoint was not restored");
        }
        if (result.design === "missing") {
            throw new Error("The design version of the checkpoint is missing; only the code went back");
        }
    }

    /** Workflow context of a checkpoint operation outside a workflow run (no events, no questions). */
    private context(setup: TurnSetup): WorkflowContext {
        return {
            runId: "chat",
            context: setup.context,
            workspace: setup.workspace,
            tools: setup.tools ?? W19ChatCheckpoints.NO_TOOLS,
            runner: W19ChatCheckpoints.NO_RUNNER,
            signal: setup.signal ?? new AbortController().signal,
            emit: (_kind: WorkflowEventKind, _payload: unknown) => undefined,
            ask: (_question: WorkflowQuestion) => Promise.reject(new Error("No questions here")),
        };
    }

    private static readonly NO_TOOLS: WorkflowToolsApi = {
        call: () => Promise.reject(new Error("Penpot tools are not available")),
        list: () => Promise.resolve([] as string[]),
    };

    private static readonly NO_RUNNER: WorkflowRunnerApi = {
        run: () => Promise.reject(new Error("Claude is not available here")),
    };
}

/**
 * Permission policy of a chat turn that saves the turn's checkpoint right before its first change.
 *
 * Wraps the session's policy: once a tool use that changes the design (see
 * {@link CanvasCheck.changesDesign}) or a project file is allowed, it waits for the checkpoint
 * before Claude may run the tool, so the checkpoint holds the state from before the turn. Turns
 * that only read save none. Runners without a permission channel never ask; for them the chat
 * saves the checkpoint at the start of the turn ({@link savesUpFront}).
 */
export class TurnCheckpointGuard implements ToolPermissionHandler {
    /** Claude Code tools that write project files. */
    private static readonly FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    /** Runners that never call the permission policy. */
    private static readonly NO_PERMISSION_CHANNEL = new Set(["local-cli-spawn"]);

    private saving?: Promise<string | null>;

    /**
     * @param inner - the session's permission policy
     * @param save - saves the checkpoint; resolves with its id or null, never rejects
     */
    constructor(
        private readonly inner: ToolPermissionHandler,
        private readonly save: () => Promise<string | null>
    ) {}

    /**
     * Whether a tool use changes the design or a project file.
     *
     * @param toolName - the tool name as Claude calls it
     */
    public static changes(toolName: string): boolean {
        return CanvasCheck.changesDesign(toolName) || TurnCheckpointGuard.FILE_TOOLS.has(toolName);
    }

    /**
     * Whether turns of a runner must save their checkpoint up front.
     *
     * @param runnerKind - `ClaudeRunner.kind`
     */
    public static savesUpFront(runnerKind: string): boolean {
        return TurnCheckpointGuard.NO_PERMISSION_CHANNEL.has(runnerKind);
    }

    public async decide(request: ToolUseRequest): Promise<ToolUseDecision> {
        const decision = await this.inner.decide(request);
        if (decision.allow && TurnCheckpointGuard.changes(request.toolName)) {
            await this.ensure();
        }
        return decision;
    }

    /** Saves the checkpoint once; later calls get the same result. */
    public ensure(): Promise<string | null> {
        this.saving ??= this.save();
        return this.saving;
    }
}
