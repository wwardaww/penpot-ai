import type { RunnerEvent } from "@penpot/mcp-common";

/** Fields of the extra `chat.tool` line that follows a successful `update_animations` call. */
export interface AnimationStep {
    toolName: string;
    summary: string;
    status: "done";
    code: string;
    params: { nodeIds: string[]; count: number; at: string };
}

/**
 * Watcher of a chat turn's tool events that turns each successful `update_animations` call into
 * a chat step line with a Play button (W32).
 *
 * The line carries code `animations-set` and params `{nodeIds, count, at}`: the layers the call
 * animated (removals left out) and when, so the client can play them once on arrival and again
 * on request. One watcher per turn.
 */
export class AnimationSteps {
    /** Tool name of the step lines; differs from the tool, so the client adds a line of its own. */
    public static readonly TOOL_NAME = "penforge_animations";

    /** Code of the step lines. */
    public static readonly CODE = "animations-set";

    private static readonly TOOL = /(^|__)update_animations$/;

    private static readonly ANIMATING_OPS = new Set(["set", "update", "set-smart"]);

    private readonly inputs = new Map<string, unknown>();

    /**
     * @param now - clock (tests pass a fixed one)
     */
    constructor(private readonly now: () => Date = () => new Date()) {}

    /**
     * Records the input of a running call and returns the step of a finished one, if any.
     *
     * @param event - a runner event of the turn
     */
    public observe(event: RunnerEvent): AnimationStep | null {
        if (event.kind !== "tool" || !AnimationSteps.TOOL.test(event.toolName)) {
            return null;
        }
        if (event.status === "running") {
            this.inputs.set(event.toolUseId, event.input);
            return null;
        }
        const input = this.inputs.get(event.toolUseId);
        this.inputs.delete(event.toolUseId);
        if (event.status !== "done") {
            return null;
        }
        const nodeIds = AnimationSteps.animatedIds(input);
        if (nodeIds.length === 0) {
            return null;
        }
        return {
            toolName: AnimationSteps.TOOL_NAME,
            summary: nodeIds.length === 1 ? "Animated 1 layer" : `Animated ${nodeIds.length} layers`,
            status: "done",
            code: AnimationSteps.CODE,
            params: { nodeIds, count: nodeIds.length, at: this.now().toISOString() },
        };
    }

    /** Ids of the layers that the operations of an `update_animations` input animate. */
    public static animatedIds(input: unknown): string[] {
        const operations = (input as { operations?: unknown } | null | undefined)?.operations;
        if (!Array.isArray(operations)) {
            return [];
        }
        const ids: string[] = [];
        for (const op of operations) {
            if (
                op &&
                typeof op === "object" &&
                AnimationSteps.ANIMATING_OPS.has((op as any).op) &&
                typeof (op as any).nodeId === "string" &&
                !ids.includes((op as any).nodeId)
            ) {
                ids.push((op as any).nodeId);
            }
        }
        return ids;
    }
}
