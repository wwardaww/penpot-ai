import { createHash } from "crypto";
import type {
    CleanupNode,
    CleanupScan,
    ComponentProposal,
    FlexPlan,
    GridPlan,
    JunkProposal,
    LayoutProposal,
    Padding,
} from "./types";

/** Axis-aligned box. */
export interface Box {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Options of the heuristics. */
export interface HeuristicOptions {
    /** largest difference (px) still counted as equal for gaps and alignment */
    tolerance?: number;
    /** look-alike layers needed for a component */
    minRepeats?: number;
    /** most components proposed in one run */
    maxComponents?: number;
}

/** Stack (flex) found among boxes, before paddings. */
export interface StackMatch {
    dir: "row" | "column";
    gap: number;
    align: "start" | "center" | "end";
    order: string[];
}

/** Grid found among boxes, before paddings. */
export interface GridMatch {
    columns: number[];
    rows: number[];
    columnGap: number;
    rowGap: number;
    columnStarts: number[];
    rowStarts: number[];
    cells: { id: string; row: number; column: number }[];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Deterministic tidy-up heuristics (W17): finds junk layers, absolute-positioned containers whose
 * children form a row, a column or a grid, and repeated look-alike items.
 *
 * Works on a {@link CleanupScan}; proposals reference layer ids of that scan.
 */
export class CleanupHeuristics {
    public static readonly DEFAULT_TOLERANCE = 1;
    public static readonly DEFAULT_MIN_REPEATS = 2;
    public static readonly DEFAULT_MAX_COMPONENTS = 20;
    /** small items (fewer layers) need this many look-alikes to become a component */
    private static readonly SMALL_ITEM_REPEATS = 3;
    private static readonly SMALL_ITEM_SIZE = 3;

    private readonly tolerance: number;
    private readonly minRepeats: number;
    private readonly maxComponents: number;
    private readonly unitOf = new Map<string, string>();
    private readonly depthOf = new Map<string, number>();
    private readonly componentized = new Set<string>();
    private readonly signatures = new Map<string, string>();
    private readonly sizes = new Map<string, number>();
    private readonly unitOrder = new Map<string, number>();
    private readonly ownData = new Map<string, boolean>();

    constructor(
        private readonly scan: CleanupScan,
        options: HeuristicOptions = {}
    ) {
        this.tolerance = options.tolerance ?? CleanupHeuristics.DEFAULT_TOLERANCE;
        this.minRepeats = Math.max(2, options.minRepeats ?? CleanupHeuristics.DEFAULT_MIN_REPEATS);
        this.maxComponents = options.maxComponents ?? CleanupHeuristics.DEFAULT_MAX_COMPONENTS;
        scan.units.forEach((unitId, index) => {
            this.unitOrder.set(unitId, index);
            this.walk(unitId, unitId, 0, false);
        });
    }

    /** The unit (top-level layer) a layer belongs to. */
    public unit(id: string): string | undefined {
        return this.unitOf.get(id);
    }

    /** True when the layer is, or is inside, a component main, copy or variant. */
    public isComponentized(id: string): boolean {
        return this.componentized.has(id);
    }

    /** Pinned constraints (right, center, stretched): a layout would stop them following resizes. */
    public static pinned(constraints: string): boolean {
        const [h, v] = (constraints ?? "").split("/");
        return ["right", "leftright", "center"].includes(h) || ["bottom", "topbottom", "center"].includes(v);
    }

    /**
     * True when the layer or a layer inside it has something a component copy would not keep or
     * a removal would lose: prototype interactions, export settings, comment threads, or texts
     * with styles that change inside them.
     */
    public carriesOwnData(id: string): boolean {
        const cached = this.ownData.get(id);
        if (cached !== undefined) {
            return cached;
        }
        const node = this.node(id);
        const own =
            !node ||
            node.interactions > 0 ||
            (node.exports ?? 0) > 0 ||
            this.scan.commented.has(id) ||
            node.text?.mixed === true ||
            node.children.some((child) => this.carriesOwnData(child));
        this.ownData.set(id, own);
        return own;
    }

    // --- Junk

    /**
     * Layers that draw nothing: empty groups and boards, zero-size layers, and (`hidden` /
     * `transparent`, removed only when the user asks) hidden or fully transparent layers without
     * children. Units, masks, layers in components and layers with interactions, exports or
     * comment threads are kept; children of a junk layer are not listed (removing the parent
     * removes them). Ids are `J:<layer id>`.
     */
    public junk(): JunkProposal[] {
        const proposals: JunkProposal[] = [];
        for (const unitId of this.scan.units) {
            const stack = [...(this.node(unitId)?.children ?? [])].reverse();
            while (stack.length > 0) {
                const id = stack.pop()!;
                const node = this.node(id);
                if (!node) {
                    continue;
                }
                const reason = this.scan.scope.has(id) ? this.junkReason(node) : null;
                if (reason || (this.scan.scope.has(id) && this.isHiddenLayer(node))) {
                    if (!reason) {
                        // a hidden layer that must stay: nothing inside it is junk either
                        continue;
                    }
                    proposals.push({
                        id: `J:${id}`,
                        kind: "junk",
                        unitId,
                        nodeId: id,
                        name: node.name,
                        reason,
                    });
                    continue;
                }
                for (let i = node.children.length - 1; i >= 0; i--) {
                    stack.push(node.children[i]);
                }
            }
        }
        return proposals;
    }

    /**
     * Hidden or fully transparent layers in the scope (outside components), top-most only: what a
     * report lists as kept unless the user asks to remove them.
     */
    public hiddenLayers(): CleanupNode[] {
        const out: CleanupNode[] = [];
        for (const unitId of this.scan.units) {
            const stack = [...(this.node(unitId)?.children ?? [])];
            while (stack.length > 0) {
                const node = this.node(stack.pop()!);
                if (!node) {
                    continue;
                }
                if (this.scan.scope.has(node.id) && this.isHiddenLayer(node)) {
                    out.push(node);
                    continue;
                }
                stack.push(...node.children);
            }
        }
        return out;
    }

    private isHiddenLayer(node: CleanupNode): boolean {
        return !this.componentized.has(node.id) && (!node.visible || node.opacity < 0.01);
    }

    private junkReason(node: CleanupNode): JunkProposal["reason"] | null {
        if (this.componentized.has(node.id) || this.isMaskShape(node) || this.carriesOwnData(node.id)) {
            return null;
        }
        if (!node.visible || node.opacity < 0.01) {
            // hidden states (hover, error, alternatives) are common in imports: only leaves
            return node.children.length === 0 ? (node.visible ? "transparent" : "hidden") : null;
        }
        if (node.children.length > 0) {
            return null;
        }
        if (node.type === "group" || node.type === "boolean") {
            return "empty-group";
        }
        if (node.type === "board") {
            return !node.painted && node.strokes === "" && node.effects === "" ? "empty-board" : null;
        }
        if (node.type === "text") {
            return node.text && node.text.content.trim() === "" ? "zero-size" : null;
        }
        const thin = node.width < 0.5 || node.height < 0.5;
        const dot = node.width < 0.01 && node.height < 0.01;
        if (dot || (thin && node.strokes === "" && node.effects === "")) {
            return "zero-size";
        }
        return null;
    }

    /** The first child of a mask group is its mask. */
    private isMaskShape(node: CleanupNode): boolean {
        const parent = node.parentId ? this.node(node.parentId) : undefined;
        return !!parent?.mask && parent.children[0] === node.id;
    }

    // --- Layouts

    /**
     * Containers (boards without a layout, plain groups) whose visible children line up as a row,
     * a column or a grid, deepest first. Children that cover all others from below (a background)
     * stay absolute.
     *
     * @param skip - layers not to touch (junk about to be removed)
     */
    public layouts(skip: ReadonlySet<string> = new Set()): LayoutProposal[] {
        const proposals: LayoutProposal[] = [];
        for (const [id, node] of this.scan.nodes) {
            if (!this.scan.scope.has(id) || skip.has(id) || !this.unitOf.has(id)) {
                continue;
            }
            const proposal = this.layoutFor(node, skip);
            if (proposal) {
                proposals.push(proposal);
            }
        }
        proposals.sort(
            (a, b) =>
                (this.unitOrder.get(a.unitId) ?? 0) - (this.unitOrder.get(b.unitId) ?? 0) ||
                b.depth - a.depth ||
                a.nodeId.localeCompare(b.nodeId)
        );
        proposals.forEach((proposal) => (proposal.id = `L:${proposal.nodeId}`));
        return proposals;
    }

    private layoutFor(node: CleanupNode, skip: ReadonlySet<string>): LayoutProposal | null {
        const convert = node.type === "group";
        if (node.type !== "board" && !convert) {
            return null;
        }
        if (
            node.layout !== null ||
            node.mask ||
            node.transformed ||
            !node.visible ||
            this.componentized.has(node.id) ||
            (convert && (node.interactions > 0 || node.opacity < 1 || node.effects !== "" || (node.exports ?? 0) > 0))
        ) {
            return null;
        }
        const children = node.children.map((id) => this.node(id));
        if (children.some((child) => !child)) {
            return null; // not fully read
        }
        const visible = (children as CleanupNode[]).filter((child) => child.visible && !skip.has(child.id));
        if (visible.length < 2 || visible.some((child) => child.transformed || child.absolute)) {
            return null;
        }
        // a layout drops the children's constraints: keep containers whose children are pinned
        if ((children as CleanupNode[]).some((child) => CleanupHeuristics.pinned(child.constraints))) {
            return null;
        }
        const below: string[] = [];
        let flow = visible;
        while (flow.length > 2 && this.covers(flow[0], flow.slice(1)) && flow[0].type !== "text") {
            below.push(flow[0].id);
            flow = flow.slice(1);
        }
        const boxes = flow.map(CleanupHeuristics.box);
        const container = CleanupHeuristics.box(node);
        let layout: FlexPlan | GridPlan | null = null;
        const stack = CleanupHeuristics.stack(boxes, this.tolerance);
        if (stack) {
            layout = { type: "flex", ...stack, padding: CleanupHeuristics.stackPadding(container, boxes, stack) };
        } else {
            const grid = CleanupHeuristics.grid(boxes, this.tolerance);
            if (grid) {
                layout = {
                    type: "grid",
                    columns: grid.columns,
                    rows: grid.rows,
                    columnGap: grid.columnGap,
                    rowGap: grid.rowGap,
                    cells: grid.cells,
                    padding: CleanupHeuristics.gridPadding(container, grid),
                };
            }
        }
        if (!layout) {
            return null;
        }
        return {
            id: "",
            kind: "layout",
            unitId: this.unitOf.get(node.id)!,
            nodeId: node.id,
            name: node.name,
            convert,
            depth: this.depthOf.get(node.id) ?? 0,
            layout,
            absoluteBelow: below,
            absoluteAbove: [],
            sizing: convert ? "auto" : "fix",
        };
    }

    /** True when `under` contains every box of `others`. */
    private covers(under: CleanupNode, others: CleanupNode[]): boolean {
        const t = this.tolerance;
        return others.every(
            (other) =>
                other.x >= under.x - t &&
                other.y >= under.y - t &&
                other.x + other.width <= under.x + under.width + t &&
                other.y + other.height <= under.y + under.height + t
        );
    }

    /**
     * Finds a row or a column: boxes that do not overlap along the axis, with equal gaps and a
     * common cross-axis alignment (start, center or end). Columns are tried first.
     */
    public static stack(boxes: Box[], tolerance = CleanupHeuristics.DEFAULT_TOLERANCE): StackMatch | null {
        if (boxes.length < 2) {
            return null;
        }
        return (
            CleanupHeuristics.axisStack(boxes, "column", tolerance) ??
            CleanupHeuristics.axisStack(boxes, "row", tolerance)
        );
    }

    private static axisStack(boxes: Box[], dir: "row" | "column", t: number): StackMatch | null {
        const start = (b: Box) => (dir === "row" ? b.x : b.y);
        const size = (b: Box) => (dir === "row" ? b.width : b.height);
        const cross = (b: Box) => (dir === "row" ? b.y : b.x);
        const crossSize = (b: Box) => (dir === "row" ? b.height : b.width);
        const sorted = [...boxes].sort((a, b) => start(a) - start(b));
        const gaps: number[] = [];
        for (let i = 1; i < sorted.length; i++) {
            const gap = start(sorted[i]) - (start(sorted[i - 1]) + size(sorted[i - 1]));
            if (gap < -t) {
                return null;
            }
            gaps.push(gap);
        }
        const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
        if (gaps.some((gap) => Math.abs(gap - mean) > t)) {
            return null;
        }
        const align = CleanupHeuristics.alignment(sorted, cross, crossSize, t);
        if (!align) {
            return null;
        }
        return { dir, gap: CleanupHeuristics.clean(Math.max(0, mean)), align, order: sorted.map((b) => b.id) };
    }

    private static alignment(
        boxes: Box[],
        cross: (b: Box) => number,
        crossSize: (b: Box) => number,
        t: number
    ): StackMatch["align"] | null {
        const same = (values: number[]) => values.every((value) => Math.abs(value - values[0]) <= t);
        if (same(boxes.map(cross))) {
            return "start";
        }
        if (same(boxes.map((b) => cross(b) + crossSize(b) / 2))) {
            return "center";
        }
        if (same(boxes.map((b) => cross(b) + crossSize(b)))) {
            return "end";
        }
        return null;
    }

    /**
     * Paddings that keep the boxes where they are inside the container, for a stack.
     */
    public static stackPadding(container: Box, boxes: Box[], stack: StackMatch): Padding {
        const row = stack.dir === "row";
        const main0 = row ? container.x : container.y;
        const mainSize = row ? container.width : container.height;
        const cross0 = row ? container.y : container.x;
        const crossSize = row ? container.height : container.width;
        const start = (b: Box) => (row ? b.x : b.y);
        const size = (b: Box) => (row ? b.width : b.height);
        const c = (b: Box) => (row ? b.y : b.x);
        const cs = (b: Box) => (row ? b.height : b.width);
        const first = Math.min(...boxes.map(start));
        const last = Math.max(...boxes.map((b) => start(b) + size(b)));
        const mainStart = Math.max(0, first - main0);
        const mainEnd = Math.max(0, main0 + mainSize - last);
        let crossStart = 0;
        let crossEnd = 0;
        if (stack.align === "start") {
            crossStart = Math.max(0, Math.min(...boxes.map(c)) - cross0);
            crossEnd = Math.max(0, cross0 + crossSize - Math.max(...boxes.map((b) => c(b) + cs(b))));
        } else if (stack.align === "end") {
            crossEnd = Math.max(0, cross0 + crossSize - Math.max(...boxes.map((b) => c(b) + cs(b))));
            crossStart = Math.max(0, Math.min(...boxes.map(c)) - cross0);
        } else {
            // center of the content box = center of the boxes
            const center = c(boxes[0]) + cs(boxes[0]) / 2 - cross0;
            const diff = 2 * center - crossSize; // = crossStart - crossEnd
            crossStart = Math.max(0, diff);
            crossEnd = Math.max(0, -diff);
        }
        const clean = CleanupHeuristics.clean;
        return row
            ? { top: clean(crossStart), right: clean(mainEnd), bottom: clean(crossEnd), left: clean(mainStart) }
            : { top: clean(mainStart), right: clean(crossEnd), bottom: clean(mainEnd), left: clean(crossStart) };
    }

    /**
     * Finds a grid: boxes whose left edges form columns and top edges rows, every cell used at
     * most once, only the last row partly filled, with equal column gaps and equal row gaps.
     */
    public static grid(boxes: Box[], t = CleanupHeuristics.DEFAULT_TOLERANCE): GridMatch | null {
        if (boxes.length < 4) {
            return null;
        }
        const columnStarts = CleanupHeuristics.clusters(
            boxes.map((b) => b.x),
            t
        );
        const rowStarts = CleanupHeuristics.clusters(
            boxes.map((b) => b.y),
            t
        );
        const cols = columnStarts.length;
        const rows = rowStarts.length;
        if (cols < 2 || rows < 2 || boxes.length > cols * rows || boxes.length <= (rows - 1) * cols) {
            return null;
        }
        const index = (starts: number[], value: number) => starts.findIndex((start) => Math.abs(start - value) <= t);
        const taken = new Set<string>();
        const cells: GridMatch["cells"] = [];
        const widths = new Array<number>(cols).fill(0);
        const heights = new Array<number>(rows).fill(0);
        for (const box of boxes) {
            const column = index(columnStarts, box.x);
            const row = index(rowStarts, box.y);
            const key = `${row}:${column}`;
            if (column < 0 || row < 0 || taken.has(key)) {
                return null;
            }
            taken.add(key);
            cells.push({ id: box.id, row: row + 1, column: column + 1 });
            widths[column] = Math.max(widths[column], box.width);
            heights[row] = Math.max(heights[row], box.height);
        }
        // only the last row may have holes, at its end
        for (let row = 0; row < rows - 1; row++) {
            for (let column = 0; column < cols; column++) {
                if (!taken.has(`${row}:${column}`)) {
                    return null;
                }
            }
        }
        const gapsOf = (starts: number[], sizes: number[]) =>
            starts.slice(1).map((start, i) => start - (starts[i] + sizes[i]));
        const columnGaps = gapsOf(columnStarts, widths);
        const rowGaps = gapsOf(rowStarts, heights);
        const equal = (gaps: number[]) => gaps.every((gap) => gap >= -t && Math.abs(gap - gaps[0]) <= t);
        if (!equal(columnGaps) || !equal(rowGaps)) {
            return null;
        }
        const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
        const clean = CleanupHeuristics.clean;
        return {
            columns: widths.map(clean),
            rows: heights.map(clean),
            columnGap: clean(Math.max(0, mean(columnGaps))),
            rowGap: clean(Math.max(0, mean(rowGaps))),
            columnStarts,
            rowStarts,
            cells,
        };
    }

    /** Paddings that keep a grid where it is inside the container. */
    public static gridPadding(container: Box, grid: GridMatch): Padding {
        const clean = CleanupHeuristics.clean;
        const width = grid.columns.reduce((sum, w) => sum + w, 0) + grid.columnGap * (grid.columns.length - 1);
        const height = grid.rows.reduce((sum, h) => sum + h, 0) + grid.rowGap * (grid.rows.length - 1);
        const left = Math.max(0, grid.columnStarts[0] - container.x);
        const top = Math.max(0, grid.rowStarts[0] - container.y);
        return {
            top: clean(top),
            left: clean(left),
            right: clean(Math.max(0, container.x + container.width - (container.x + left + width))),
            bottom: clean(Math.max(0, container.y + container.height - (container.y + top + height))),
        };
    }

    /** Sorted cluster starts of values that lie within `t` of the cluster's first value. */
    private static clusters(values: number[], t: number): number[] {
        const sorted = [...values].sort((a, b) => a - b);
        const starts: number[] = [];
        for (const value of sorted) {
            if (starts.length === 0 || value - starts[starts.length - 1] > t) {
                starts.push(value);
            }
        }
        return starts;
    }

    /** Rounds to 2 decimals, snapping to whole pixels within 0.05. */
    public static clean(value: number): number {
        const whole = Math.round(value);
        return Math.abs(value - whole) <= 0.05 ? whole : round2(value);
    }

    private static box(node: CleanupNode): Box {
        return { id: node.id, x: node.x, y: node.y, width: node.width, height: node.height };
    }

    // --- Components

    /**
     * Groups of look-alike boards or groups (same structure, sizes, positions and styles; text
     * contents and images may differ). Outer items win over items nested in them.
     */
    public components(): ComponentProposal[] {
        const groups = new Map<string, string[]>();
        for (const [id, node] of this.scan.nodes) {
            if (!this.isComponentCandidate(node)) {
                continue;
            }
            const signature = this.signature(id);
            const members = groups.get(signature) ?? [];
            members.push(id);
            groups.set(signature, members);
        }
        const ranked = [...groups.values()]
            .filter((members) => members.length >= this.minRepeats)
            .sort((a, b) => (this.sizes.get(b[0]) ?? 0) - (this.sizes.get(a[0]) ?? 0) || b.length - a.length);
        const claimed = new Set<string>();
        const proposals: ComponentProposal[] = [];
        for (const members of ranked) {
            const free = members.filter((id) => !claimed.has(id));
            const size = this.sizes.get(members[0]) ?? 1;
            const needed =
                size < CleanupHeuristics.SMALL_ITEM_SIZE
                    ? Math.max(this.minRepeats, CleanupHeuristics.SMALL_ITEM_REPEATS)
                    : this.minRepeats;
            if (free.length < needed) {
                continue;
            }
            free.sort((a, b) => this.readingOrder(a, b));
            free.forEach((id) => this.claim(id, claimed));
            const first = this.node(free[0])!;
            proposals.push({
                id: `C:${free[0]}`,
                kind: "component",
                memberIds: free,
                unitIds: [...new Set(free.map((id) => this.unitOf.get(id)!))],
                name: first.name,
                width: first.width,
                height: first.height,
                size,
            });
            if (proposals.length >= this.maxComponents) {
                break;
            }
        }
        return proposals;
    }

    private isComponentCandidate(node: CleanupNode): boolean {
        if (node.type !== "board" && node.type !== "group") {
            return false;
        }
        if (!this.scan.scope.has(node.id) || !this.unitOf.has(node.id) || this.scan.units.includes(node.id)) {
            return false;
        }
        if (this.componentized.has(node.id) || !node.visible || node.children.length === 0 || node.mask) {
            return false;
        }
        // a copy would take the main's interactions, exports and texts; comments would lose their board
        if (node.transformed || this.carriesOwnData(node.id)) {
            return false;
        }
        // not fully read
        return this.complete(node.id);
    }

    private complete(id: string): boolean {
        const node = this.node(id);
        return !!node && node.children.every((child) => this.complete(child));
    }

    /**
     * Structure hash of a layer: type, styles, size (texts: font and grow type), and per child
     * its offset and own hash. Text contents and image fills are left out.
     */
    public signature(id: string): string {
        const cached = this.signatures.get(id);
        if (cached) {
            return cached;
        }
        const node = this.node(id);
        if (!node) {
            return "missing";
        }
        const r = (value: number) => Math.round(value);
        const parts: (string | number)[] = [
            node.type,
            node.visible ? 1 : 0,
            round2(node.opacity),
            node.fills,
            node.strokes,
            node.effects,
            node.radius,
            node.layout ?? "",
            node.mask ? "mask" : "",
            node.clip ? "clip" : "",
            node.component ?? "",
            node.componentRef ?? "",
        ];
        if (node.type === "text") {
            parts.push(node.text?.font ?? "", node.text?.grow ?? "");
            if ((node.text?.grow ?? "fixed") === "fixed") {
                parts.push(`${r(node.width)}x${r(node.height)}`);
            } else if (node.text?.grow === "auto-height") {
                parts.push(`${r(node.width)}`);
            }
        } else {
            parts.push(`${r(node.width)}x${r(node.height)}`);
        }
        let size = 1;
        for (const childId of node.children) {
            const child = this.node(childId);
            if (!child) {
                parts.push("missing");
                continue;
            }
            parts.push(`${r(child.x - node.x)},${r(child.y - node.y)}:${this.signature(childId)}`);
            size += this.sizes.get(childId) ?? 1;
        }
        const signature = createHash("sha1").update(parts.join("|")).digest("hex");
        this.signatures.set(id, signature);
        this.sizes.set(id, size);
        return signature;
    }

    private claim(id: string, claimed: Set<string>): void {
        claimed.add(id);
        for (const child of this.node(id)?.children ?? []) {
            this.claim(child, claimed);
        }
    }

    private readingOrder(a: string, b: string): number {
        const na = this.node(a)!;
        const nb = this.node(b)!;
        const ua = this.unitOrder.get(this.unitOf.get(a) ?? "") ?? 0;
        const ub = this.unitOrder.get(this.unitOf.get(b) ?? "") ?? 0;
        return ua - ub || na.y - nb.y || na.x - nb.x;
    }

    // --- Tree

    private node(id: string): CleanupNode | undefined {
        return this.scan.nodes.get(id);
    }

    private walk(id: string, unitId: string, depth: number, insideComponent: boolean): void {
        const node = this.node(id);
        if (!node) {
            return;
        }
        this.unitOf.set(id, unitId);
        this.depthOf.set(id, depth);
        const componentized = insideComponent || node.component !== null;
        if (componentized) {
            this.componentized.add(id);
        }
        for (const child of node.children) {
            this.walk(child, unitId, depth + 1, componentized);
        }
    }
}
