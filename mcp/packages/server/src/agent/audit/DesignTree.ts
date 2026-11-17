import type { AuditPoint } from "./AuditFinding";

/** Fill or stroke paint of a node snapshot (`get_node_properties` format). */
export interface PaintSnapshot {
    color?: string | null;
    opacity?: number;
    gradient?: unknown;
    image?: unknown;
    colorRef?: unknown;
}

/** Text span of a node snapshot. */
export interface SpanSnapshot {
    start: number;
    end: number;
    text: string;
    fontSize?: number | string | null;
    fontWeight?: number | string | null;
    lineHeight?: number | string | null;
    fills?: PaintSnapshot[] | "mixed";
}

/**
 * Node snapshot as returned by the `get_node_properties` tool (architecture §6).
 *
 * Only the fields the audit reads are typed. Children are full snapshots or, at the depth limit,
 * summaries (`{id, name, type, visible}`, recognizable by the missing `geometry`).
 */
export interface NodeSnapshot {
    pageId?: string;
    id: string;
    name: string;
    type: string;
    parentId?: string | null;
    visible?: boolean;
    geometry?: { x: number; y: number; width: number; height: number; rotation?: number };
    opacity?: number;
    fills?: PaintSnapshot[] | "mixed";
    strokes?: PaintSnapshot[];
    layout?: {
        type: string;
        clipContent?: boolean;
        rowGap?: number;
        columnGap?: number;
        padding?: { top: number; right: number; bottom: number; left: number };
    } | null;
    text?: {
        content: string;
        growType?: string | null;
        typography?: Record<string, unknown>;
        spans?: SpanSnapshot[];
    } | null;
    tokens?: Record<string, string>;
    component?: {
        isInstance?: boolean;
        isMainInstance?: boolean;
        isVariantContainer?: boolean;
        componentId?: string | null;
        componentName?: string | null;
    } | null;
    interactions?: unknown[];
    childCount?: number;
    children?: NodeSnapshot[];
}

/** Axis-aligned rectangle in page coordinates. */
export class Bounds {
    constructor(
        public readonly x: number,
        public readonly y: number,
        public readonly width: number,
        public readonly height: number
    ) {}

    public get right(): number {
        return this.x + this.width;
    }

    public get bottom(): number {
        return this.y + this.height;
    }

    public center(): AuditPoint {
        return { x: this.x + this.width / 2, y: this.y + this.height / 2 };
    }

    public containsPoint(point: AuditPoint): boolean {
        return point.x >= this.x && point.x <= this.right && point.y >= this.y && point.y <= this.bottom;
    }

    /**
     * Tells whether another rectangle sticks out of this one by more than a tolerance.
     *
     * @param other - the other rectangle
     * @param tolerance - allowed overflow in pixels
     */
    public overflowedBy(other: Bounds, tolerance: number): boolean {
        return (
            other.x < this.x - tolerance ||
            other.y < this.y - tolerance ||
            other.right > this.right + tolerance ||
            other.bottom > this.bottom + tolerance
        );
    }
}

/**
 * Node of a {@link DesignTree}: a full snapshot with links to its parent and children.
 */
export class TreeNode {
    public readonly children: TreeNode[] = [];
    /** position in the paint order of its board (0 = painted first) */
    public paintIndex = 0;
    /**
     * roots only: ancestors outside the audited tree, nearest first (set when only some nodes
     * are audited, so their visibility, opacity and fills are known)
     */
    public outer: NodeSnapshot[] = [];

    constructor(
        public readonly snapshot: NodeSnapshot,
        public readonly parent: TreeNode | null,
        public readonly board: TreeNode | null
    ) {}

    public get id(): string {
        return this.snapshot.id;
    }

    public get name(): string {
        return this.snapshot.name ?? "";
    }

    public get type(): string {
        return this.snapshot.type;
    }

    /** Top-level board (or root) holding this node; itself for roots. */
    public get root(): TreeNode {
        return this.board ?? this;
    }

    public bounds(): Bounds {
        const g = this.snapshot.geometry ?? { x: 0, y: 0, width: 0, height: 0 };
        return new Bounds(g.x, g.y, g.width, g.height);
    }

    /** Visible, including every ancestor. */
    public isVisible(): boolean {
        for (let node: TreeNode | null = this; node; node = node.parent) {
            if (node.snapshot.visible === false) {
                return false;
            }
        }
        return this.root.outer.every((ancestor) => ancestor.visible !== false);
    }

    /** Product of the opacities of the node and its ancestors. */
    public effectiveOpacity(): number {
        let opacity = 1;
        for (let node: TreeNode | null = this; node; node = node.parent) {
            opacity *= TreeNode.opacity(node.snapshot);
        }
        for (const ancestor of this.root.outer) {
            opacity *= TreeNode.opacity(ancestor);
        }
        return opacity;
    }

    /** Opacity of a snapshot (1 when missing). */
    public static opacity(snapshot: NodeSnapshot): number {
        return typeof snapshot.opacity === "number" ? snapshot.opacity : 1;
    }

    /** Whether the node is a top-level board (or other top-level layer) of its page. */
    public isTopLevel(): boolean {
        return this.parent === null && this.outer.length === 0;
    }

    /** Ancestors, nearest first. */
    public ancestors(): TreeNode[] {
        const result: TreeNode[] = [];
        for (let node = this.parent; node; node = node.parent) {
            result.push(node);
        }
        return result;
    }

    /** Names of the applied design tokens' properties, normalized (`row-gap` / `rowGap` → `rowgap`). */
    public tokenProperties(): Set<string> {
        return new Set(Object.keys(this.snapshot.tokens ?? {}).map(TreeNode.normalizeKey));
    }

    /**
     * Point where a canvas comment about this node goes.
     *
     * Leaves get their center, so the comment hit-tests to the node itself. Containers get a point
     * just inside their top-left corner, so the comment does not land on a centered child.
     */
    public anchor(): AuditPoint {
        const b = this.bounds();
        if (this.children.length === 0) {
            return TreeNode.rounded(b.center());
        }
        return TreeNode.rounded({ x: b.x + Math.min(4, b.width / 2), y: b.y + Math.min(4, b.height / 2) });
    }

    /** Walks this node and its descendants in paint order. */
    public *walk(): Generator<TreeNode> {
        yield this;
        for (const child of this.children) {
            yield* child.walk();
        }
    }

    private static normalizeKey(key: string): string {
        return key.replace(/[-_]/g, "").toLowerCase();
    }

    private static rounded(point: AuditPoint): AuditPoint {
        return { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
    }
}

/**
 * Tree of the audited nodes, built from full snapshots.
 *
 * Roots are the audited boards (or nodes). Children keep the order of the snapshot, which is the
 * paint order (bottom first) with the plugin's natural child ordering.
 */
export class DesignTree {
    public readonly roots: TreeNode[] = [];
    private readonly byId = new Map<string, TreeNode>();
    private readonly paintOrders = new Map<string, TreeNode[]>();

    /**
     * @param snapshots - full snapshots of the roots, with full descendants
     * @param ancestry - ancestors of the roots outside the tree, by root id, nearest first
     */
    constructor(snapshots: NodeSnapshot[], ancestry: Map<string, NodeSnapshot[]> = new Map()) {
        for (const snapshot of snapshots) {
            if (this.byId.has(snapshot.id)) {
                continue;
            }
            const root = this.add(snapshot, null, null);
            root.outer = ancestry.get(snapshot.id) ?? [];
            this.roots.push(root);
            const order = [...root.walk()];
            order.forEach((node, index) => (node.paintIndex = index));
            this.paintOrders.set(root.id, order);
        }
    }

    /** Gets a node by id. */
    public get(nodeId: string): TreeNode | undefined {
        return this.byId.get(nodeId);
    }

    /** Number of nodes. */
    public get size(): number {
        return this.byId.size;
    }

    /** All nodes, root by root, in paint order. */
    public *nodes(): Generator<TreeNode> {
        for (const root of this.roots) {
            yield* root.walk();
        }
    }

    /** Visible nodes, root by root, in paint order. */
    public *visibleNodes(): Generator<TreeNode> {
        for (const node of this.nodes()) {
            if (node.isVisible()) {
                yield node;
            }
        }
    }

    /**
     * Nodes painted before the given one in its root, nearest (top-most) first.
     *
     * @param node - the node
     */
    public paintedBelow(node: TreeNode): TreeNode[] {
        const order = this.paintOrders.get(node.root.id) ?? [];
        return order.slice(0, node.paintIndex).reverse();
    }

    private add(snapshot: NodeSnapshot, parent: TreeNode | null, board: TreeNode | null): TreeNode {
        const node = new TreeNode(snapshot, parent, board);
        this.byId.set(snapshot.id, node);
        const childBoard = board ?? node;
        for (const child of snapshot.children ?? []) {
            if (child.geometry && !this.byId.has(child.id)) {
                node.children.push(this.add(child, node, childBoard));
            }
        }
        return node;
    }
}
