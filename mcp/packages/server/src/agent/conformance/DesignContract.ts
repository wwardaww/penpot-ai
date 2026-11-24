import type { WorkflowContext, WorkflowToolsApi } from "@penpot/mcp-common";
import { ExecuteCodeReply } from "../changes/ExecuteCodeReply";
import { BindingStore } from "../designsystem/conformance/Binding";
import { type PrototypeFlow, type PrototypeLink, PrototypeLinks } from "./PrototypeLinks";

/** Component of the design with the screens that use it. */
export interface UsedComponent {
    id: string;
    /** path and name, e.g. `Cards/Task card` */
    design: string;
    name: string;
    path: string;
    /** component of the linked design system */
    system: boolean;
    /** boards that hold instances, with how many */
    boards: Record<string, number>;
}

/** Animated layer of a board, as `get_animation_spec` (W32) describes it. */
export interface AnimatedDesignLayer {
    nodeId: string;
    name: string;
    path: string;
    codeName: string;
    childCount: number;
    boardId: string;
    boardName: string;
    /** W31 spec */
    animations: Record<string, unknown>;
    /** smart animate links */
    smart: { destinationId: string; destinationName: string; duration?: number; easing?: unknown }[];
}

/** Parts of the contract that may be unreadable. */
export type ContractPart = "prototype" | "components" | "animations";

/** What the app must follow: prototype, design system use and animations of the design. */
export interface DesignContract {
    fileId: string;
    boards: { id: string; name: string }[];
    flows: PrototypeFlow[];
    links: PrototypeLink[];
    /** boards shown only on top of other screens */
    overlays: Set<string>;
    components: UsedComponent[];
    animations: AnimatedDesignLayer[];
    /** name of the linked design system, or null */
    designSystem: string | null;
    /** parts that could not be read, with the reason */
    unread: { part: ContractPart; reason: string }[];
}

/**
 * Reader of the {@link DesignContract} of the open file. Each part is read on its own: one that
 * cannot be read is listed in `unread`, so the report says what it did not check.
 */
export class DesignContractReader {
    /** components taken at most (most used first) */
    public static readonly MAX_COMPONENTS = 80;

    /** Plugin code listing the component instances of every top-level board (outermost ones). */
    public static readonly COMPONENTS_SCRIPT = `const file = penpot.currentFile;
if (!file) { throw new Error("No Penpot file is open"); }
const str = (v) => (v === undefined || v === null ? "" : String(v));
const call = (s, name) => { try { return typeof s[name] === "function" ? s[name]() : null; } catch (e) { return null; } };
const found = {};
const walk = (s, boardId) => {
  if (!call(s, "isComponentMainInstance") && call(s, "isComponentCopyInstance")) {
    const c = call(s, "component");
    if (c) {
      const key = str(c.libraryId) + "/" + str(c.path) + "/" + str(c.name);
      const entry = found[key] || (found[key] = { id: str(c.id), name: str(c.name), path: str(c.path), libraryId: str(c.libraryId), boards: {} });
      entry.boards[boardId] = (entry.boards[boardId] || 0) + 1;
      return;
    }
  }
  const children = Array.isArray(s.children) ? s.children : [];
  for (const child of children) { walk(child, boardId); }
};
for (const page of file.pages || []) {
  const top = page.root && Array.isArray(page.root.children) ? page.root.children : [];
  for (const board of top) { if (board.type === "board") { walk(board, board.id); } }
}
return { components: Object.keys(found).map((k) => found[k]) };`;

    private readonly tools: WorkflowToolsApi;

    /**
     * @param ctx - the workflow context of the open file
     */
    constructor(private readonly ctx: Pick<WorkflowContext, "tools" | "workspace" | "context">) {
        this.tools = ctx.tools;
    }

    /** Reads the contract. */
    public async read(): Promise<DesignContract> {
        const unread: DesignContract["unread"] = [];
        const part = async <T>(name: ContractPart, fallback: T, body: () => Promise<T>): Promise<T> => {
            try {
                return await body();
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                unread.push({ part: name, reason: reason.slice(0, 300) });
                return fallback;
            }
        };
        const binding = await new BindingStore(this.ctx.workspace).read().catch(() => null);
        const prototype = await part(
            "prototype",
            { boards: [], flows: [], links: [] } as Pick<DesignContract, "boards" | "flows" | "links">,
            () => this.prototype()
        );
        const components = await part("components", [] as UsedComponent[], () =>
            this.components(binding?.fileId ?? null)
        );
        const animations = await part("animations", [] as AnimatedDesignLayer[], () => this.animations());
        return {
            fileId: this.ctx.context.fileId,
            ...prototype,
            overlays: PrototypeLinks.overlayBoards(prototype.links, prototype.flows),
            components,
            animations,
            designSystem: binding === null ? null : binding.name || "design system",
            unread,
        };
    }

    private async prototype(): Promise<Pick<DesignContract, "boards" | "flows" | "links">> {
        const boards = DesignContractReader.array(await this.json("list_boards", {}));
        const graph = DesignContractReader.object(await this.json("get_prototype_graph", {}));
        return {
            boards: boards.map((board) => ({ id: String(board.id ?? ""), name: String(board.name ?? "") })),
            flows: DesignContractReader.array(graph.flows)
                .map((flow) => ({
                    name: String(flow.name ?? ""),
                    startingBoardId: String(flow.startingBoardId ?? ""),
                }))
                .filter((flow) => flow.startingBoardId.length > 0),
            links: PrototypeLinks.read(boards, DesignContractReader.array(graph.edges)),
        };
    }

    private async components(systemFileId: string | null): Promise<UsedComponent[]> {
        const reply = await this.tools.call("execute_code", { code: DesignContractReader.COMPONENTS_SCRIPT });
        if (reply.isError) {
            throw new Error(`execute_code failed: ${reply.text.slice(0, 200)}`);
        }
        const value = DesignContractReader.object(ExecuteCodeReply.parse(reply.text));
        const list = DesignContractReader.array(value.components).map((entry) => {
            const name = String(entry.name ?? "");
            const path = String(entry.path ?? "");
            const boards: Record<string, number> = {};
            for (const [boardId, count] of Object.entries(DesignContractReader.object(entry.boards))) {
                boards[boardId] = Number(count) || 0;
            }
            return {
                id: String(entry.id ?? ""),
                design: path.length > 0 ? `${path}/${name}` : name,
                name,
                path,
                system: systemFileId !== null && entry.libraryId === systemFileId,
                boards,
            };
        });
        const uses = (component: UsedComponent) => Object.values(component.boards).reduce((a, b) => a + b, 0);
        return list
            .filter((component) => component.name.length > 0)
            .sort((a, b) => uses(b) - uses(a) || a.design.localeCompare(b.design))
            .slice(0, DesignContractReader.MAX_COMPONENTS);
    }

    private async animations(): Promise<AnimatedDesignLayer[]> {
        const spec = DesignContractReader.object(
            await this.json("get_animation_spec", { fileId: this.ctx.context.fileId })
        );
        const layers: AnimatedDesignLayer[] = [];
        for (const page of DesignContractReader.array(spec.pages)) {
            for (const board of DesignContractReader.array(page.boards)) {
                for (const layer of DesignContractReader.array(board.layers)) {
                    layers.push({
                        nodeId: String(layer.nodeId ?? ""),
                        name: String(layer.name ?? ""),
                        path: String(layer.path ?? ""),
                        codeName: String(layer.codeName ?? "layer"),
                        childCount: Number(layer.childCount) || 0,
                        boardId: String(board.boardId ?? ""),
                        boardName: String(board.boardName ?? ""),
                        animations: DesignContractReader.object(layer.animations),
                        smart: DesignContractReader.array(layer.smart).map((link) => ({
                            destinationId: String(link.destinationId ?? ""),
                            destinationName: String(link.destinationName ?? ""),
                            ...(typeof link.duration === "number" ? { duration: link.duration } : {}),
                            ...(link.easing !== undefined ? { easing: link.easing } : {}),
                        })),
                    });
                }
            }
        }
        return layers;
    }

    private async json(tool: string, args: Record<string, unknown>): Promise<unknown> {
        const result = await this.tools.call(tool, args);
        if (result.isError) {
            throw new Error(`${tool} failed: ${result.text.slice(0, 200)}`);
        }
        try {
            return JSON.parse(result.text);
        } catch {
            throw new Error(`${tool} returned no JSON`);
        }
    }

    private static array(value: unknown): Record<string, unknown>[] {
        return Array.isArray(value) ? value.filter((item) => item !== null && typeof item === "object") : [];
    }

    private static object(value: unknown): Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    }
}
