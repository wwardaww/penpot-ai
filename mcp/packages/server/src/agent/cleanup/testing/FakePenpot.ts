import { createHash } from "crypto";
import sharp from "sharp";

/**
 * Small stand-in for the Plugin API as `execute_code` sees it (natural child ordering on), for
 * running the tidy-up scripts in tests. Geometry is absolute; layouts do not move anything (the
 * scripts keep every layer where it was), so a rendering changes only when visibility, styles,
 * texts or positions change.
 */
export const ROOT_ID = "00000000-0000-0000-0000-000000000000";

type Fill = { fillColor?: string; fillOpacity?: number; fillImage?: { id: string } };

let nextId = 1;
const newId = () => `s-${String(nextId++).padStart(4, "0")}`;

export class FakeLayout {
    public dir = "row";
    public wrap = "nowrap";
    public alignItems = "start";
    public justifyContent = "start";
    public justifyItems = "start";
    public rowGap = 0;
    public columnGap = 0;
    public topPadding = 0;
    public rightPadding = 0;
    public bottomPadding = 0;
    public leftPadding = 0;
    public horizontalSizing = "fix";
    public verticalSizing = "fix";
    public rows: { type: string; value: number }[] = [];
    public columns: { type: string; value: number }[] = [];
    public cells = new Map<string, [number, number]>();

    constructor(
        private readonly board: FakeShape,
        public readonly kind: "flex" | "grid"
    ) {}

    public remove(): void {
        if (this.kind === "flex") {
            this.board.flex = null;
        } else {
            this.board.grid = null;
        }
    }

    public addRow(type: string, value = 0): void {
        this.rows.push({ type, value });
    }

    public addColumn(type: string, value = 0): void {
        this.columns.push({ type, value });
    }

    public removeRow(index: number): void {
        this.rows.splice(index, 1);
    }

    public removeColumn(index: number): void {
        this.columns.splice(index, 1);
    }

    public appendChild(child: FakeShape, row: number, column: number): void {
        if (row < 1 || column < 1 || row > this.rows.length || column > this.columns.length) {
            throw new Error(`no cell ${row}/${column}`);
        }
        this.cells.set(child.id, [row, column]);
    }
}

export class FakeComponent {
    public readonly id = `c-${newId()}`;

    constructor(
        private readonly penpot: FakePenpot,
        public name: string,
        private main: FakeShape | null
    ) {}

    public mainInstance(): FakeShape | null {
        return this.main;
    }

    public instance(): FakeShape {
        if (!this.main) {
            throw new Error("deleted component");
        }
        const copy = this.main.deepClone((shape) => {
            shape.mainOf = null;
            shape.copyOf = this;
        });
        copy.copyHead = true;
        this.penpot.page.root.appendChild(copy);
        copy.x = 0;
        copy.y = 0;
        return copy;
    }

    public remove(): void {
        this.main?.remove();
        this.main = null;
        this.penpot.components = this.penpot.components.filter((component) => component !== this);
    }
}

export class FakeShape {
    public parent: FakeShape | null = null;
    public visible = true;
    public opacity = 1;
    public fills: Fill[] = [];
    public strokes: unknown[] = [];
    public shadows: unknown[] = [];
    public blur: unknown = null;
    public rotation = 0;
    public flipX = false;
    public flipY = false;
    public interactions: unknown[] = [];
    public clipContent = true;
    public characters?: string;
    public growType = "fixed";
    public fontFamily = "Inter";
    public fontSize = "14";
    public constraintsHorizontal = "left";
    public constraintsVertical = "top";
    public flex: FakeLayout | null = null;
    public grid: FakeLayout | null = null;
    public mainOf: FakeComponent | null = null;
    public copyOf: FakeComponent | null = null;
    public copyHead = false;
    public mask = false;
    public absolute = false;
    /** bottom to top */
    public items: FakeShape[] = [];
    private _x: number;
    private _y: number;

    constructor(
        public type: string,
        public name: string,
        x: number,
        y: number,
        public width: number,
        public height: number,
        public readonly id = newId()
    ) {
        this._x = x;
        this._y = y;
    }

    get x(): number {
        return this._x;
    }

    set x(value: number) {
        const dx = value - this._x;
        this._x = value;
        this.items.forEach((child) => (child.x = child.x + dx));
    }

    get y(): number {
        return this._y;
    }

    set y(value: number) {
        const dy = value - this._y;
        this._y = value;
        this.items.forEach((child) => (child.y = child.y + dy));
    }

    get children(): FakeShape[] {
        return this.flex ? [...this.items].reverse() : [...this.items];
    }

    set children(list: FakeShape[]) {
        const ids = new Set(list.map((shape) => shape.id));
        if (ids.size !== this.items.length || this.items.some((item) => !ids.has(item.id))) {
            throw new Error("Not all children are present in the input");
        }
        this.items = this.flex ? [...list].reverse() : [...list];
    }

    get layoutChild(): { absolute: boolean } | undefined {
        if (!this.parent || (!this.parent.flex && !this.parent.grid)) {
            return undefined;
        }
        const self = this;
        return {
            get absolute() {
                return self.absolute;
            },
            set absolute(value: boolean) {
                self.absolute = value;
            },
        };
    }

    public add(...children: FakeShape[]): this {
        children.forEach((child) => {
            child.detach();
            child.parent = this;
            this.items.push(child);
        });
        return this;
    }

    public appendChild(child: FakeShape): void {
        child.detach();
        child.parent = this;
        if (this.flex) {
            this.items.unshift(child);
        } else {
            this.items.push(child);
        }
    }

    public insertChild(index: number, child: FakeShape): void {
        child.detach();
        child.parent = this;
        const at = this.flex ? this.items.length - index : index;
        this.items.splice(Math.max(0, Math.min(at, this.items.length)), 0, child);
    }

    public detach(): void {
        if (this.parent) {
            this.parent.items = this.parent.items.filter((item) => item !== this);
            this.parent = null;
        }
    }

    public remove(): void {
        this.detach();
    }

    public resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
    }

    public clone(): FakeShape {
        const copy = this.deepClone(() => undefined);
        const parent = this.parent!;
        copy.parent = parent;
        parent.items.splice(parent.items.indexOf(this) + 1, 0, copy);
        return copy;
    }

    public deepClone(mark: (shape: FakeShape) => void): FakeShape {
        const copy = new FakeShape(this.type, this.name, this._x, this._y, this.width, this.height);
        for (const key of [
            "visible",
            "opacity",
            "rotation",
            "clipContent",
            "characters",
            "growType",
            "fontFamily",
            "fontSize",
            "mask",
            "absolute",
        ] as const) {
            (copy as any)[key] = (this as any)[key];
        }
        copy.fills = this.fills.map((fill) => ({ ...fill }));
        copy.mainOf = this.mainOf;
        copy.copyOf = this.copyOf;
        if (this.flex) {
            copy.flex = Object.assign(new FakeLayout(copy, "flex"), { ...this.flex, board: copy });
        }
        mark(copy);
        for (const item of this.items) {
            const child = item.deepClone(mark);
            child.parent = copy;
            copy.items.push(child);
        }
        return copy;
    }

    public addFlexLayout(): FakeLayout {
        if (this.type !== "board") {
            throw new Error("not a board");
        }
        this.flex = new FakeLayout(this, "flex");
        return this.flex;
    }

    public addGridLayout(): FakeLayout {
        if (this.type !== "board") {
            throw new Error("not a board");
        }
        this.grid = new FakeLayout(this, "grid");
        return this.grid;
    }

    public isMask(): boolean {
        return this.mask;
    }

    public isComponentMainInstance(): boolean {
        return this.mainOf !== null;
    }

    public isComponentCopyInstance(): boolean {
        return this.copyOf !== null;
    }

    public isComponentInstance(): boolean {
        return this.copyOf !== null || this.mainOf !== null;
    }

    public isComponentHead(): boolean {
        return this.copyHead || (this.mainOf !== null && this.mainOf.mainInstance() === this);
    }

    public isVariantContainer(): boolean {
        return false;
    }

    public isVariantHead(): boolean {
        return false;
    }

    public component(): FakeComponent | null {
        return this.copyOf ?? this.mainOf;
    }

    /** Every shape of the subtree, this one first. */
    public all(): FakeShape[] {
        return [this, ...this.items.flatMap((item) => item.all())];
    }
}

export class FakePage {
    public readonly id = "page-1";
    public readonly name = "Page 1";
    public readonly root = new FakeShape("board", "Root", 0, 0, 0, 0, ROOT_ID);

    public getShapeById(id: string): FakeShape | null {
        return this.root.all().find((shape) => shape.id === id) ?? null;
    }
}

/** The `penpot` global. */
export class FakePenpot {
    public readonly page = new FakePage();
    public components: FakeComponent[] = [];
    public undoBlocks = 0;
    public openBlocks = 0;
    public readonly history = {
        undoBlockBegin: () => {
            this.openBlocks++;
            this.undoBlocks++;
            return Symbol("block");
        },
        undoBlockFinish: () => {
            this.openBlocks--;
        },
    };
    public readonly library = {
        local: {
            get components(): FakeComponent[] {
                return self.components;
            },
            createComponent: (shapes: FakeShape[]) => this.createComponent(shapes),
        },
    };
    public readonly currentFile = { pages: [this.page], saveVersion: undefined };

    constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        self = this;
    }

    get currentPage(): FakePage {
        return this.page;
    }

    public async openPage(): Promise<void> {}

    public createBoard(): FakeShape {
        const board = new FakeShape("board", "Board", 0, 0, 100, 100);
        board.fills = [{ fillColor: "#FFFFFF", fillOpacity: 1 }];
        this.page.root.appendChild(board);
        return board;
    }

    public group(shapes: FakeShape[]): FakeShape | null {
        if (shapes.length === 0) {
            return null;
        }
        const parent = shapes[0].parent!;
        const x = Math.min(...shapes.map((s) => s.x));
        const y = Math.min(...shapes.map((s) => s.y));
        const right = Math.max(...shapes.map((s) => s.x + s.width));
        const bottom = Math.max(...shapes.map((s) => s.y + s.height));
        const group = new FakeShape("group", "Group", x, y, right - x, bottom - y);
        const index = Math.max(...shapes.map((s) => parent.items.indexOf(s)));
        group.parent = parent;
        parent.items.splice(index + 1, 0, group);
        const ordered = [...shapes].sort((a, b) => parent.items.indexOf(a) - parent.items.indexOf(b));
        ordered.forEach((shape) => {
            shape.detach();
            shape.parent = group;
            group.items.push(shape);
        });
        return group;
    }

    private createComponent(shapes: FakeShape[]): FakeComponent {
        let main = shapes[0];
        if (main.type !== "board") {
            const board = new FakeShape("board", main.name, main.x, main.y, main.width, main.height);
            const parent = main.parent!;
            board.parent = parent;
            parent.items.splice(parent.items.indexOf(main), 1, board);
            main.parent = board;
            board.items.push(main);
            main = board;
        }
        const component = new FakeComponent(this, main.name, main);
        main.all().forEach((shape) => (shape.mainOf = component));
        this.components.push(component);
        return component;
    }

    /**
     * Runs `execute_code` code like the MCP plugin: an async function body. Layouts reflow before
     * (Penpot reflows them after each change, before the next call).
     */
    public async execute(code: string): Promise<unknown> {
        this.reflow();
        const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
        const fn = new AsyncFunction("penpot", code);
        return fn(this);
    }

    /**
     * Lays out flex boards (row/column, gaps, paddings, start/center/end alignment, fix/auto
     * sizing) and grid boards (fixed tracks, start alignment).
     */
    public reflow(): void {
        const flow = (board: FakeShape) => board.children.filter((child) => child.visible && !child.absolute);
        const size = (shape: FakeShape) => {
            shape.items.forEach(size);
            const layout = shape.flex;
            if (!layout) {
                return;
            }
            const items = flow(shape);
            const row = layout.dir === "row";
            const gap = row ? layout.columnGap : layout.rowGap;
            const main =
                items.reduce((sum, item) => sum + (row ? item.width : item.height), 0) +
                gap * Math.max(0, items.length - 1);
            const cross = Math.max(0, ...items.map((item) => (row ? item.height : item.width)));
            const width = row ? main : cross;
            const height = row ? cross : main;
            if (layout.horizontalSizing === "auto") {
                shape.width = layout.leftPadding + width + layout.rightPadding;
            }
            if (layout.verticalSizing === "auto") {
                shape.height = layout.topPadding + height + layout.bottomPadding;
            }
        };
        const place = (shape: FakeShape) => {
            const flex = shape.flex;
            if (flex) {
                const row = flex.dir === "row";
                let cursor = row ? shape.x + flex.leftPadding : shape.y + flex.topPadding;
                const crossStart = row ? shape.y + flex.topPadding : shape.x + flex.leftPadding;
                const crossSize = row
                    ? shape.height - flex.topPadding - flex.bottomPadding
                    : shape.width - flex.leftPadding - flex.rightPadding;
                for (const item of flow(shape)) {
                    const itemCross = row ? item.height : item.width;
                    const offset =
                        flex.alignItems === "center"
                            ? (crossSize - itemCross) / 2
                            : flex.alignItems === "end"
                              ? crossSize - itemCross
                              : 0;
                    if (row) {
                        item.x = cursor;
                        item.y = crossStart + offset;
                        cursor += item.width + flex.columnGap;
                    } else {
                        item.y = cursor;
                        item.x = crossStart + offset;
                        cursor += item.height + flex.rowGap;
                    }
                }
            }
            const grid = shape.grid;
            if (grid) {
                const start = (tracks: { value: number }[], gap: number, index: number) =>
                    tracks.slice(0, index - 1).reduce((sum, track) => sum + track.value + gap, 0);
                for (const item of flow(shape)) {
                    const cell = grid.cells.get(item.id);
                    if (cell) {
                        item.y = shape.y + grid.topPadding + start(grid.rows, grid.rowGap, cell[0]);
                        item.x = shape.x + grid.leftPadding + start(grid.columns, grid.columnGap, cell[1]);
                    }
                }
            }
            shape.items.forEach(place);
        };
        size(this.page.root);
        place(this.page.root);
    }

    /**
     * Renders a layer: visible leaves (and painted boards) as rectangles coloured from their fills
     * and texts, as a base64 PNG.
     */
    public async render(id: string, scale = 1): Promise<string> {
        this.reflow();
        const target = this.page.getShapeById(id);
        if (!target) {
            throw new Error("not found");
        }
        const width = Math.max(1, Math.round(target.width * scale));
        const height = Math.max(1, Math.round(target.height * scale));
        const data = Buffer.alloc(width * height * 4, 255);
        const paint = (shape: FakeShape) => {
            if (!shape.visible || shape.opacity < 0.01) {
                return;
            }
            const painted = shape.fills.some((fill) => (fill.fillOpacity ?? 1) > 0);
            if (painted && (shape.items.length === 0 || shape.type === "board")) {
                const key = JSON.stringify([shape.fills, shape.characters ?? ""]);
                const hash = createHash("sha1").update(key).digest();
                const x0 = Math.round((shape.x - target.x) * scale);
                const y0 = Math.round((shape.y - target.y) * scale);
                const x1 = Math.round((shape.x + shape.width - target.x) * scale);
                const y1 = Math.round((shape.y + shape.height - target.y) * scale);
                for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
                    for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
                        const i = (y * width + x) * 4;
                        data[i] = hash[0];
                        data[i + 1] = hash[1];
                        data[i + 2] = hash[2];
                        data[i + 3] = 255;
                    }
                }
            }
            shape.items.forEach(paint);
        };
        paint(target);
        const png = await sharp(data, { raw: { width, height, channels: 4 } })
            .png()
            .toBuffer();
        return png.toString("base64");
    }
}

// the library getter needs the instance
let self: FakePenpot;
