import type { Board, Page, Shape } from "@penpot/plugin-types";
import { NodeSerializer } from "./serialize.ts";
import type { JsonObject } from "./serialize.ts";
import { PrototypeReader } from "./prototype.ts";

/**
 * Action of a prototype interaction as the `update_prototype` tool receives it. Boards and shapes
 * are referenced by id.
 */
export interface ActionSpec {
    type: "navigate-to" | "open-overlay" | "toggle-overlay" | "close-overlay" | "previous-screen" | "open-url";
    destinationId?: string;
    url?: string;
    preserveScrollPosition?: boolean;
    position?: string;
    relativeToId?: string;
    closeWhenClickOutside?: boolean;
    addBackgroundOverlay?: boolean;
    animation?: Record<string, unknown> | null;
}

/**
 * One operation of the `update_prototype` tool.
 */
export type PrototypeOperation =
    | { op: "add-interaction"; sourceId: string; trigger?: string; delay?: number; action: ActionSpec }
    | {
          op: "update-interaction";
          sourceId: string;
          index: number;
          trigger?: string;
          delay?: number;
          action?: ActionSpec;
      }
    | { op: "remove-interaction"; sourceId: string; index: number }
    | { op: "set-flow"; name: string; startingBoardId: string; newName?: string }
    | { op: "remove-flow"; name: string; pageId?: string };

const TRIGGERS = ["click", "mouse-enter", "mouse-leave", "after-delay"];
const ACTION_TYPES = ["navigate-to", "open-overlay", "toggle-overlay", "close-overlay", "previous-screen", "open-url"];
const DESTINATION_REQUIRED = ["navigate-to", "open-overlay", "toggle-overlay"];
const POSITIONS = [
    "manual",
    "center",
    "top-left",
    "top-right",
    "top-center",
    "bottom-left",
    "bottom-right",
    "bottom-center",
];
const EASINGS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out"];
const DIRECTIONS = ["right", "left", "up", "down"];

/**
 * A validated operation bound to the Plugin API objects it changes.
 */
interface BoundOperation {
    spec: PrototypeOperation;
    run: () => JsonObject;
}

/**
 * Creates, updates and removes prototype interactions and flows of one page.
 *
 * All operations are validated and bound to their shapes before the first change, so a bad
 * operation leaves the file untouched and removing several interactions of one shape never
 * shifts the indexes of the others. Adding an interaction never deletes an existing one: when
 * the source already has an interaction with the same trigger that leads somewhere else, the
 * operation is reported as a `conflict` and skipped, so the caller can ask the user first.
 */
export class PrototypeWriter {
    private readonly page: Page;

    /**
     * @param page - the active page all operations apply to
     */
    constructor(page: Page) {
        this.page = page;
    }

    /**
     * Checks the shape of the operations without touching the file. Throws on the first problem.
     *
     * @param operations - the operations to check
     */
    public static validate(operations: unknown): asserts operations is PrototypeOperation[] {
        if (!Array.isArray(operations) || operations.length === 0) {
            throw new Error("operations must be a non-empty array");
        }
        operations.forEach((raw, i) => {
            const op: any = raw;
            const where = `operations[${i}]`;
            if (!op || typeof op !== "object") {
                throw new Error(`${where} must be an object`);
            }
            switch (op.op) {
                case "add-interaction":
                    PrototypeWriter.requireString(op.sourceId, `${where}.sourceId`);
                    PrototypeWriter.checkTrigger(op.trigger, where);
                    PrototypeWriter.checkAction(op.action, where);
                    break;
                case "update-interaction":
                    PrototypeWriter.requireString(op.sourceId, `${where}.sourceId`);
                    PrototypeWriter.requireIndex(op.index, where);
                    PrototypeWriter.checkTrigger(op.trigger, where);
                    if (op.action !== undefined) {
                        PrototypeWriter.checkAction(op.action, where);
                    }
                    break;
                case "remove-interaction":
                    PrototypeWriter.requireString(op.sourceId, `${where}.sourceId`);
                    PrototypeWriter.requireIndex(op.index, where);
                    break;
                case "set-flow":
                    PrototypeWriter.requireString(op.name, `${where}.name`);
                    PrototypeWriter.requireString(op.startingBoardId, `${where}.startingBoardId`);
                    if (op.newName !== undefined) {
                        PrototypeWriter.requireString(op.newName, `${where}.newName`);
                    }
                    break;
                case "remove-flow":
                    PrototypeWriter.requireString(op.name, `${where}.name`);
                    break;
                default:
                    throw new Error(
                        `${where}.op must be one of add-interaction, update-interaction, remove-interaction, ` +
                            `set-flow, remove-flow (got ${JSON.stringify(op.op)})`
                    );
            }
        });
    }

    /**
     * Returns the ids of all shapes the operations reference, in order (used to find the page).
     *
     * @param operations - validated operations
     */
    public static referencedIds(operations: PrototypeOperation[]): string[] {
        const ids: string[] = [];
        for (const op of operations) {
            if ("sourceId" in op) {
                ids.push(op.sourceId);
            }
            if (op.op === "set-flow") {
                ids.push(op.startingBoardId);
            }
        }
        return ids;
    }

    /**
     * Binds every operation to the page's shapes. Throws before any change when one is invalid.
     *
     * @param operations - validated operations
     */
    public bind(operations: PrototypeOperation[]): BoundOperation[] {
        return operations.map((spec, i) => ({ spec, run: this.bindOne(spec, `operations[${i}]`) }));
    }

    /**
     * Runs bound operations and returns one result per operation.
     *
     * @param bound - operations returned by {@link bind}
     */
    public static run(bound: BoundOperation[]): JsonObject[] {
        return bound.map(({ spec, run }) => ({ op: spec.op, ...run() }));
    }

    private bindOne(spec: PrototypeOperation, where: string): () => JsonObject {
        switch (spec.op) {
            case "add-interaction": {
                const source = this.shape(spec.sourceId, `${where}.sourceId`);
                const trigger = spec.trigger ?? "click";
                const action = this.buildAction(spec.action, where);
                const delay = trigger === "after-delay" ? (spec.delay ?? 600) : undefined;
                return () => this.addInteraction(source, trigger, action, delay);
            }
            case "update-interaction": {
                const source = this.shape(spec.sourceId, `${where}.sourceId`);
                const interaction = this.interaction(source, spec.index, where);
                const action = spec.action ? this.buildAction(spec.action, where) : undefined;
                return () => {
                    if (spec.trigger !== undefined) {
                        interaction.trigger = spec.trigger;
                    }
                    if (spec.delay !== undefined) {
                        interaction.delay = spec.delay;
                    }
                    if (action !== undefined) {
                        interaction.action = action;
                    }
                    return {
                        status: "updated",
                        sourceId: source.id,
                        sourceName: source.name,
                        interaction: NodeSerializer.interaction(interaction),
                    };
                };
            }
            case "remove-interaction": {
                const source = this.shape(spec.sourceId, `${where}.sourceId`);
                const interaction = this.interaction(source, spec.index, where);
                return () => {
                    const removed = NodeSerializer.interaction(interaction);
                    if (typeof (source as any).removeInteraction === "function") {
                        source.removeInteraction(interaction);
                    } else {
                        interaction.remove();
                    }
                    return { status: "removed", sourceId: source.id, sourceName: source.name, interaction: removed };
                };
            }
            case "set-flow": {
                const board = this.topLevelBoard(spec.startingBoardId, `${where}.startingBoardId`);
                return () => this.setFlow(spec.name, board, spec.newName);
            }
            case "remove-flow": {
                const flow = (this.page.flows ?? []).find((f) => f.name === spec.name);
                return () => {
                    if (!flow) {
                        return { status: "skipped", reason: "not-found", name: spec.name };
                    }
                    if (typeof (this.page as any).removeFlow === "function") {
                        this.page.removeFlow(flow);
                    } else {
                        flow.remove();
                    }
                    return { status: "removed", name: spec.name };
                };
            }
        }
    }

    private addInteraction(source: Shape, trigger: string, action: any, delay: number | undefined): JsonObject {
        const wanted = NodeSerializer.interaction({ trigger, delay, action } as any);
        const wantedAction = wanted.action as JsonObject;
        const existing = (source.interactions ?? []).map((interaction, index) => ({
            index,
            serialized: NodeSerializer.interaction(interaction),
        }));
        const same = existing.find(
            ({ serialized }) =>
                serialized.trigger === trigger &&
                (serialized.action as JsonObject).type === wantedAction.type &&
                (serialized.action as JsonObject).destinationId === wantedAction.destinationId &&
                (serialized.action as JsonObject).url === wantedAction.url
        );
        if (same) {
            return {
                status: "skipped",
                reason: "exists",
                sourceId: source.id,
                sourceName: source.name,
                index: same.index,
            };
        }
        const clash = existing.find(({ serialized }) => serialized.trigger === trigger);
        if (clash) {
            return {
                status: "conflict",
                reason: `the source already has a ${trigger} interaction; ask the user, then update or remove it`,
                sourceId: source.id,
                sourceName: source.name,
                index: clash.index,
                existing: clash.serialized,
            };
        }
        const created = source.addInteraction(trigger as any, action, delay);
        return {
            status: "added",
            sourceId: source.id,
            sourceName: source.name,
            index: (source.interactions ?? []).length - 1,
            interaction: NodeSerializer.interaction(created ?? ({ trigger, delay, action } as any)),
        };
    }

    private setFlow(name: string, board: Board, newName: string | undefined): JsonObject {
        const flows = this.page.flows ?? [];
        const flow = flows.find((f) => f.name === name);
        if (!flow) {
            this.page.createFlow(newName ?? name, board);
            return { status: "added", name: newName ?? name, startingBoardId: board.id, startingBoardName: board.name };
        }
        const changed: string[] = [];
        if (flow.startingBoard?.id !== board.id) {
            flow.startingBoard = board;
            changed.push("startingBoard");
        }
        if (newName !== undefined && newName !== flow.name) {
            flow.name = newName;
            changed.push("name");
        }
        return {
            status: changed.length > 0 ? "updated" : "skipped",
            ...(changed.length === 0 ? { reason: "exists" } : { changed }),
            name: flow.name,
            startingBoardId: board.id,
            startingBoardName: board.name,
        };
    }

    private buildAction(spec: ActionSpec, where: string): any {
        const action: any = { type: spec.type };
        if (spec.destinationId !== undefined) {
            action.destination = this.topLevelBoard(spec.destinationId, `${where}.action.destinationId`);
        }
        if (spec.type === "open-url") {
            action.url = spec.url;
        }
        if (spec.type === "navigate-to" && spec.preserveScrollPosition !== undefined) {
            action.preserveScrollPosition = spec.preserveScrollPosition;
        }
        if (spec.type === "open-overlay" || spec.type === "toggle-overlay") {
            action.position = spec.position ?? "center";
            if (spec.relativeToId !== undefined) {
                action.relativeTo = this.shape(spec.relativeToId, `${where}.action.relativeToId`);
            }
            action.closeWhenClickOutside = spec.closeWhenClickOutside ?? true;
            action.addBackgroundOverlay = spec.addBackgroundOverlay ?? false;
        }
        if (spec.animation && spec.type !== "open-url" && spec.type !== "previous-screen") {
            action.animation = { ...spec.animation };
        }
        return action;
    }

    private shape(id: string, where: string): Shape {
        const shape = this.page.getShapeById(id);
        if (!shape) {
            throw new Error(
                `${where}: node ${id} is not on page "${this.page.name}" (prototype links stay on one page)`
            );
        }
        return shape;
    }

    private topLevelBoard(id: string, where: string): Board {
        const shape = this.shape(id, where);
        const root: any = this.page.root;
        const children: Shape[] = root && Array.isArray(root.children) ? root.children : [];
        if (shape.type !== "board" || !children.some((child) => child.id === id)) {
            throw new Error(`${where}: ${shape.name} (${id}) is not a top-level board (screen)`);
        }
        return shape as Board;
    }

    private interaction(source: Shape, index: number, where: string): any {
        const interactions = source.interactions ?? [];
        const interaction = interactions[index];
        if (!interaction) {
            throw new Error(
                `${where}.index: ${source.name} has no interaction at index ${index} (it has ${interactions.length})`
            );
        }
        return interaction;
    }

    private static requireString(value: unknown, where: string): void {
        if (typeof value !== "string" || value.length === 0) {
            throw new Error(`${where} must be a non-empty string`);
        }
    }

    private static requireIndex(value: unknown, where: string): void {
        if (!Number.isInteger(value) || (value as number) < 0) {
            throw new Error(`${where}.index must be an integer >= 0`);
        }
    }

    private static checkTrigger(trigger: unknown, where: string): void {
        if (trigger !== undefined && !TRIGGERS.includes(trigger as string)) {
            throw new Error(`${where}.trigger must be one of ${TRIGGERS.join(", ")}`);
        }
    }

    private static checkAction(raw: unknown, where: string): void {
        const action: any = raw;
        if (!action || typeof action !== "object") {
            throw new Error(`${where}.action must be an object`);
        }
        if (!ACTION_TYPES.includes(action.type)) {
            throw new Error(`${where}.action.type must be one of ${ACTION_TYPES.join(", ")}`);
        }
        if (DESTINATION_REQUIRED.includes(action.type)) {
            PrototypeWriter.requireString(action.destinationId, `${where}.action.destinationId`);
        }
        if (action.type === "open-url") {
            PrototypeWriter.requireString(action.url, `${where}.action.url`);
        }
        if (action.position !== undefined && !POSITIONS.includes(action.position)) {
            throw new Error(`${where}.action.position must be one of ${POSITIONS.join(", ")}`);
        }
        const animation = action.animation;
        if (animation !== undefined && animation !== null) {
            if (!["dissolve", "slide", "push"].includes(animation.type)) {
                throw new Error(`${where}.action.animation.type must be dissolve, slide or push`);
            }
            if (typeof animation.duration !== "number" || animation.duration < 0) {
                throw new Error(`${where}.action.animation.duration must be a number of milliseconds`);
            }
            if (animation.easing !== undefined && !EASINGS.includes(animation.easing)) {
                throw new Error(`${where}.action.animation.easing must be one of ${EASINGS.join(", ")}`);
            }
            if (animation.type !== "dissolve" && !DIRECTIONS.includes(animation.direction)) {
                throw new Error(`${where}.action.animation.direction must be one of ${DIRECTIONS.join(", ")}`);
            }
            if (animation.type === "slide" && !["in", "out"].includes(animation.way)) {
                throw new Error(`${where}.action.animation.way must be in or out`);
            }
        }
    }

    /**
     * Returns the prototype graph of the page after the changes.
     */
    public graph(): JsonObject {
        return new PrototypeReader().graph([this.page]);
    }
}
