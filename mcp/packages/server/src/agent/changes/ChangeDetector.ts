import type { BoardState, DesignState, EdgeState, LayerState } from "./DesignState";
import { type ChangeItem, type ChangeSet, ChangeSets, type ScreenChange } from "./ChangeSet";

/**
 * Comparer of two {@link DesignState}s: the one saved with the last build and the current one.
 *
 * Gives, in plain words: screens added, removed or renamed; per changed screen the concrete
 * changes (texts, layers added/removed/renamed, fills, strokes, typography, layout, sizes,
 * component swaps, images, visibility, animations, navigation from the screen); token changes;
 * flow changes; a switch of the connected design system. Pure: no I/O.
 */
export class ChangeDetector {
    /** Most items listed per screen; the rest is counted in `more`. */
    public static readonly MAX_ITEMS_PER_SCREEN = 30;

    /** Longest text quoted in an item. */
    private static readonly MAX_QUOTE = 80;

    /**
     * Compares the build's state with the current one.
     *
     * @param previous - state saved with the last build
     * @param current - state of the design now
     */
    public compare(previous: DesignState, current: DesignState): ChangeSet {
        const screens: ScreenChange[] = [];
        for (const [boardId, board] of Object.entries(current.boards)) {
            const before = previous.boards[boardId];
            if (before === undefined) {
                screens.push({ boardId, name: board.name, status: "added", items: [], more: 0 });
                continue;
            }
            const items = [...this.layerChanges(before, board), ...this.navigationChanges(boardId, previous, current)];
            const renamed = before.name !== board.name;
            if (items.length === 0 && !renamed) {
                continue;
            }
            const max = ChangeDetector.MAX_ITEMS_PER_SCREEN;
            screens.push({
                boardId,
                name: board.name,
                status: items.length === 0 ? "renamed" : "changed",
                ...(renamed ? { previousName: before.name } : {}),
                items: items.slice(0, max),
                more: Math.max(0, items.length - max),
            });
        }
        for (const [boardId, board] of Object.entries(previous.boards)) {
            if (current.boards[boardId] === undefined) {
                screens.push({ boardId, name: board.name, status: "removed", items: [], more: 0 });
            }
        }
        return ChangeSets.of(
            screens,
            this.tokenChanges(previous.tokens, current.tokens),
            this.flowChanges(previous, current),
            this.designSystemChange(previous, current),
            "state"
        );
    }

    // screens ---------------------------------------------------------------------------------

    private layerChanges(before: BoardState, after: BoardState): ChangeItem[] {
        const items: ChangeItem[] = [];
        for (const [id, layer] of Object.entries(after.layers)) {
            const old = before.layers[id];
            if (old === undefined) {
                // a layer inside an added group is part of that addition
                if (layer.parentId === null || before.layers[layer.parentId] !== undefined) {
                    items.push(this.item("layer-added", { layer: layer.name }, `Added "${layer.name}"`));
                }
                continue;
            }
            items.push(...this.propertyChanges(old, layer));
        }
        for (const [id, layer] of Object.entries(before.layers)) {
            if (after.layers[id] === undefined) {
                if (layer.parentId === null || after.layers[layer.parentId] !== undefined) {
                    items.push(this.item("layer-removed", { layer: layer.name }, `Removed "${layer.name}"`));
                }
            }
        }
        return items;
    }

    private propertyChanges(old: LayerState, layer: LayerState): ChangeItem[] {
        const items: ChangeItem[] = [];
        const name = layer.name;
        if (old.name !== layer.name) {
            items.push(
                this.item(
                    "layer-renamed",
                    { before: old.name, after: layer.name },
                    `Renamed "${old.name}" to "${layer.name}"`
                )
            );
        }
        const textChanged = old.text !== layer.text;
        if (textChanged) {
            const before = ChangeDetector.quote(old.text ?? "");
            const after = ChangeDetector.quote(layer.text ?? "");
            items.push(
                this.item(
                    "text-changed",
                    { layer: name, before, after },
                    `Text of "${name}" changed from "${before}" to "${after}"`
                )
            );
        }
        if (old.typography !== layer.typography) {
            items.push(this.item("typography-changed", { layer: name }, `New text style on "${name}"`));
        }
        if (old.images !== layer.images) {
            items.push(this.item("image-changed", { layer: name }, `New image in "${name}"`));
        } else if (old.fills !== layer.fills) {
            items.push(this.item("fill-changed", { layer: name }, `New fill color on "${name}"`));
        }
        if (old.strokes !== layer.strokes) {
            items.push(this.item("stroke-changed", { layer: name }, `New border on "${name}"`));
        }
        if (old.layout !== layer.layout) {
            items.push(this.item("layout-changed", { layer: name }, `New layout (spacing or alignment) in "${name}"`));
        }
        // a text box grows with its text: that size change says nothing new
        if (old.size !== layer.size && !(textChanged && layer.type === "text")) {
            items.push(
                this.item(
                    "size-changed",
                    { layer: name, before: old.size, after: layer.size },
                    `"${name}" resized from ${ChangeDetector.size(old.size)} to ${ChangeDetector.size(layer.size)}`
                )
            );
        }
        if (old.component !== layer.component) {
            items.push(
                this.item(
                    "component-swapped",
                    { layer: name, before: old.component, after: layer.component },
                    `"${name}" now uses the component "${layer.component || "none"}"`
                )
            );
        }
        if (old.visible !== layer.visible) {
            items.push(
                this.item(
                    "visibility-changed",
                    { layer: name, visible: layer.visible },
                    layer.visible ? `"${name}" is shown again` : `"${name}" is hidden`
                )
            );
        }
        if (old.animation !== layer.animation) {
            const change = layer.animation === "" ? "removed" : old.animation === "" ? "added" : "changed";
            items.push(this.item("animation-changed", { layer: name, change }, `Animation of "${name}" ${change}`));
        }
        return items;
    }

    private navigationChanges(boardId: string, previous: DesignState, current: DesignState): ChangeItem[] {
        const key = (edge: EdgeState) => `${edge.to}\u0000${edge.trigger}\u0000${edge.sourceName}`;
        const before = new Map(previous.edges.filter((e) => e.from === boardId).map((e) => [key(e), e]));
        const after = new Map(current.edges.filter((e) => e.from === boardId).map((e) => [key(e), e]));
        const nameOf = (id: string) => current.boards[id]?.name ?? previous.boards[id]?.name ?? "another screen";
        const items: ChangeItem[] = [];
        for (const [k, edge] of after) {
            if (!before.has(k)) {
                const target = nameOf(edge.to);
                items.push(
                    this.item(
                        "navigation-added",
                        { source: edge.sourceName, target, trigger: edge.trigger },
                        `"${edge.sourceName}" now opens "${target}" (${edge.trigger})`
                    )
                );
            }
        }
        for (const [k, edge] of before) {
            if (!after.has(k)) {
                const target = nameOf(edge.to);
                items.push(
                    this.item(
                        "navigation-removed",
                        { source: edge.sourceName, target },
                        `"${edge.sourceName}" no longer opens "${target}"`
                    )
                );
            }
        }
        return items;
    }

    // tokens, flows, design system ------------------------------------------------------------

    private tokenChanges(before: Record<string, string>, after: Record<string, string>): ChangeItem[] {
        const items: ChangeItem[] = [];
        for (const name of Object.keys(after).sort()) {
            if (!Object.hasOwn(before, name)) {
                items.push(
                    this.item("token-added", { name, value: after[name] }, `New token "${name}" (${after[name]})`)
                );
            } else if (before[name] !== after[name]) {
                items.push(
                    this.item(
                        "token-changed",
                        { name, before: before[name], after: after[name] },
                        `Token "${name}" changed from ${before[name]} to ${after[name]}`
                    )
                );
            }
        }
        for (const name of Object.keys(before).sort()) {
            if (!Object.hasOwn(after, name)) {
                items.push(this.item("token-removed", { name }, `Token "${name}" removed`));
            }
        }
        return items;
    }

    private flowChanges(previous: DesignState, current: DesignState): ChangeItem[] {
        const items: ChangeItem[] = [];
        const nameOf = (id: string) => current.boards[id]?.name ?? previous.boards[id]?.name ?? "a screen";
        for (const name of Object.keys(current.flows).sort()) {
            const start = current.flows[name];
            if (!Object.hasOwn(previous.flows, name)) {
                items.push(
                    this.item(
                        "flow-added",
                        { name, screen: nameOf(start) },
                        `New flow "${name}" starting at "${nameOf(start)}"`
                    )
                );
            } else if (previous.flows[name] !== start) {
                items.push(
                    this.item(
                        "flow-start-changed",
                        { name, screen: nameOf(start) },
                        `Flow "${name}" now starts at "${nameOf(start)}"`
                    )
                );
            }
        }
        for (const name of Object.keys(previous.flows).sort()) {
            if (!Object.hasOwn(current.flows, name)) {
                items.push(this.item("flow-removed", { name }, `Flow "${name}" removed`));
            }
        }
        return items;
    }

    private designSystemChange(previous: DesignState, current: DesignState): ChangeItem | null {
        const ids = (state: DesignState) => state.libraries.map((library) => library.id).join("\u0000");
        if (ids(previous) === ids(current)) {
            return null;
        }
        const names = (state: DesignState) => state.libraries.map((library) => library.name).join(", ") || "none";
        return this.item(
            "design-system-changed",
            { before: names(previous), after: names(current) },
            `Design system changed from ${names(previous)} to ${names(current)}`
        );
    }

    // helpers ---------------------------------------------------------------------------------

    private item(code: ChangeItem["code"], params: ChangeItem["params"], text: string): ChangeItem {
        return ChangeSets.item(code, params, text);
    }

    private static quote(text: string): string {
        const clean = text.replace(/\s+/g, " ").trim();
        return clean.length > ChangeDetector.MAX_QUOTE ? `${clean.slice(0, ChangeDetector.MAX_QUOTE - 1)}…` : clean;
    }

    private static size(size: string): string {
        return size.replace("x", "×");
    }
}
