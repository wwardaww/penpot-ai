import { z } from "zod";
import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { PenforgePluginTool } from "./PenforgePluginTool";
import { PenforgeSchemas } from "./PenforgeSchemas";

const EASING = z.enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]);
const DIRECTION = z.enum(["right", "left", "up", "down"]);

/**
 * Transition of a prototype action (durations in milliseconds).
 */
const ANIMATION = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("dissolve"), duration: z.number().min(0), easing: EASING.optional() }),
    z.strictObject({
        type: z.literal("slide"),
        way: z.enum(["in", "out"]),
        direction: DIRECTION,
        duration: z.number().min(0),
        offsetEffect: z.boolean().optional(),
        easing: EASING.optional(),
    }),
    z.strictObject({
        type: z.literal("push"),
        direction: DIRECTION,
        duration: z.number().min(0),
        easing: EASING.optional(),
    }),
]);

const OVERLAY_FIELDS = {
    destinationId: PenforgeSchemas.NODE_ID.describe("Top-level board shown as overlay."),
    position: z
        .enum([
            "manual",
            "center",
            "top-left",
            "top-right",
            "top-center",
            "bottom-left",
            "bottom-right",
            "bottom-center",
        ])
        .optional(),
    relativeToId: PenforgeSchemas.NODE_ID.optional(),
    closeWhenClickOutside: z.boolean().optional(),
    addBackgroundOverlay: z.boolean().optional(),
    animation: ANIMATION.optional(),
};

/**
 * Action of an interaction; boards are referenced by id and must be top-level boards (screens) of
 * the source's page.
 */
export const PROTOTYPE_ACTION = z.discriminatedUnion("type", [
    z.strictObject({
        type: z.literal("navigate-to"),
        destinationId: PenforgeSchemas.NODE_ID.describe("Top-level board (screen) to go to."),
        preserveScrollPosition: z.boolean().optional(),
        animation: ANIMATION.optional(),
    }),
    z.strictObject({ type: z.literal("open-overlay"), ...OVERLAY_FIELDS }),
    z.strictObject({ type: z.literal("toggle-overlay"), ...OVERLAY_FIELDS }),
    z.strictObject({
        type: z.literal("close-overlay"),
        destinationId: PenforgeSchemas.NODE_ID.optional(),
        animation: ANIMATION.optional(),
    }),
    z.strictObject({ type: z.literal("previous-screen") }),
    z.strictObject({ type: z.literal("open-url"), url: z.string().min(1).max(2048) }),
]);

const TRIGGER = z.enum(["click", "mouse-enter", "mouse-leave", "after-delay"]);

/**
 * One operation of {@link UpdatePrototypeTool}.
 */
export const PROTOTYPE_OPERATION = z.discriminatedUnion("op", [
    z.strictObject({
        op: z.literal("add-interaction"),
        sourceId: PenforgeSchemas.NODE_ID.describe("Layer the user interacts with (button, icon, row...)."),
        trigger: TRIGGER.optional().describe("Defaults to click."),
        delay: z.number().int().min(0).optional().describe("Milliseconds, after-delay only (default 600)."),
        action: PROTOTYPE_ACTION,
    }),
    z.strictObject({
        op: z.literal("update-interaction"),
        sourceId: PenforgeSchemas.NODE_ID,
        index: z.number().int().min(0).describe("Position in the source's `interactions` list."),
        trigger: TRIGGER.optional(),
        delay: z.number().int().min(0).optional(),
        action: PROTOTYPE_ACTION.optional(),
    }),
    z.strictObject({
        op: z.literal("remove-interaction"),
        sourceId: PenforgeSchemas.NODE_ID,
        index: z.number().int().min(0).describe("Position in the source's `interactions` list."),
    }),
    z.strictObject({
        op: z.literal("set-flow"),
        name: z.string().min(1).max(200).describe("Flow to create, or to change when one has this name."),
        startingBoardId: PenforgeSchemas.NODE_ID.describe("Top-level board where the flow starts."),
        newName: z.string().min(1).max(200).optional(),
    }),
    z.strictObject({
        op: z.literal("remove-flow"),
        name: z.string().min(1).max(200),
    }),
]);

/**
 * Arguments of {@link UpdatePrototypeTool}.
 */
export class UpdatePrototypeArgs {
    static schema = {
        operations: z.array(PROTOTYPE_OPERATION).min(1).max(200).describe("Changes, applied in order."),
        pageId: PenforgeSchemas.PAGE_ID.optional().describe(
            "Page to change; only needed when no operation references a node (remove-flow only)."
        ),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    operations!: z.infer<typeof PROTOTYPE_OPERATION>[];

    pageId?: string;

    sessionId?: string;
}

/**
 * Creates, updates and removes prototype interactions and flows through the Plugin API (W27).
 */
export class UpdatePrototypeTool extends PenforgePluginTool<UpdatePrototypeArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, UpdatePrototypeArgs.schema);
    }

    public getToolName(): string {
        return "update_prototype";
    }

    public getToolDescription(): string {
        return (
            "Wires the prototype: adds, updates or removes interactions (trigger click/mouse-enter/" +
            "mouse-leave/after-delay; action navigate-to, open-overlay, toggle-overlay, close-overlay, " +
            "previous-screen, open-url; optional dissolve/slide/push animation) and creates, moves, " +
            "renames or removes flows. All operations target one page (the page of the nodes they " +
            "reference, opened if needed), are checked before the first change and run as one undo " +
            "step. Destinations and flow starts must be top-level boards (screens) of that page. " +
            "Adding is safe to repeat: an identical interaction is `skipped`, and when the source " +
            "already has an interaction with the same trigger the add is reported as `conflict` and " +
            "NOT applied - ask the user, then use update-interaction or remove-interaction with the " +
            "reported `index`. `set-flow` changes the flow with that name or creates it. Returns " +
            "`{pageId, undoGrouped, results, graph}`; `results` has one `{op, status, ...}` per " +
            "operation (status added, updated, removed, skipped or conflict) and `graph` is " +
            "get_prototype_graph for the page after the change."
        );
    }

    protected async executeCore(args: UpdatePrototypeArgs): Promise<ToolResponse> {
        const params: Record<string, unknown> = { operations: args.operations };
        if (args.pageId !== undefined) {
            params.pageId = args.pageId;
        }
        const data = await this.callPlugin("updatePrototype", params, args.sessionId);
        return PenforgePluginTool.json(data);
    }
}
