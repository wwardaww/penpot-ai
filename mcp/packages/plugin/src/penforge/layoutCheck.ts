/** Box of a shape in page coordinates. */
interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Checker of the layout a script drew.
 *
 * Models that cannot judge a screenshot well make the same mistakes over and over: children without
 * gap or padding, layers on top of each other or outside their board, tiny or pale text, empty boards
 * left by a failed script. The check names them in one line each, with the id to fix.
 */
export class LayoutCheck {
    private static readonly MAX_PROBLEMS = 12;
    private static readonly MAX_BOARDS = 3;
    private static readonly MAX_SHAPES = 600;
    /** differences thinner than this (in px) are rounding */
    private static readonly TOLERANCE = 2;
    /** text closer than this (in px) to the edge of a visible box touches it */
    private static readonly MIN_INSET = 4;
    private static readonly MIN_FONT_SIZE = 14;
    private static readonly MIN_CONTRAST = 4.5;

    private readonly penpot: any;
    private readonly lines: string[] = [];
    private readonly boxes = new Map<string, Box>();

    /**
     * @param penpotApi - the Penpot plugin API object
     */
    constructor(penpotApi: any) {
        this.penpot = penpotApi;
    }

    /**
     * Checks boards and the top level of the page.
     *
     * @param boards - top-level boards to look into, the most recent last
     * @param added - shapes the script added
     * @returns one line per problem
     */
    public run(boards: any[], added: any[]): string[] {
        const top = LayoutCheck.children(this.penpot.root);
        const addedIds = new Set(added.map((shape) => shape.id));
        for (const shape of top) {
            if (shape.type !== "board" && addedIds.has(shape.id)) {
                this.add(shape, "lies on the page, outside every board");
            }
        }
        for (const board of boards.slice(-LayoutCheck.MAX_BOARDS)) {
            this.checkTopLevel(board, top);
            this.checkInside(board);
        }
        if (this.lines.length <= LayoutCheck.MAX_PROBLEMS) {
            return this.lines;
        }
        const rest = this.lines.length - LayoutCheck.MAX_PROBLEMS;
        return [...this.lines.slice(0, LayoutCheck.MAX_PROBLEMS), `and ${rest} more problems`];
    }

    private checkTopLevel(board: any, top: any[]): void {
        if (LayoutCheck.children(board).length === 0) {
            this.add(board, "is empty; remove it by id if a failed script left it");
        }
        const twin = top.find((shape) => shape.id !== board.id && shape.name === board.name);
        if (twin) {
            this.add(board, `has the same name as ${twin.type} ${twin.id}; work with ids`);
        }
    }

    private checkInside(board: any): void {
        const shapes: any[] = [];
        const walk = (shape: any) => {
            for (const child of LayoutCheck.children(shape)) {
                if (!child.hidden && shapes.length < LayoutCheck.MAX_SHAPES) {
                    shapes.push(child);
                    walk(child);
                }
            }
        };
        walk(board);
        for (const shape of shapes) {
            this.checkGap(shape);
            this.checkInset(shape, board);
            if (this.isOut(shape, shape.parent) || this.isOut(shape, board)) {
                this.add(shape, "sticks out of its board");
            }
            this.checkText(shape, board);
        }
        this.checkOverlaps(shapes);
    }

    private checkGap(shape: any): void {
        const flex = shape.flex;
        if (!flex) {
            return;
        }
        const isRow = String(flex.dir).startsWith("row");
        const gap = isRow ? flex.columnGap : flex.rowGap;
        const inFlow = LayoutCheck.children(shape).filter((child) => !child.hidden && !child.layoutChild?.absolute);
        if (inFlow.length > 1 && !gap && !String(flex.justifyContent).startsWith("space")) {
            this.add(shape, `has no gap between its ${inFlow.length} children: set ${isRow ? "columnGap" : "rowGap"}`);
        }
    }

    /** Text at the very edge of the box that is drawn around it. */
    private checkInset(shape: any, board: any): void {
        if (shape.type !== "text") {
            return;
        }
        const around = LayoutCheck.drawnAncestor(shape, board);
        const text = this.box(shape);
        const box = this.box(around);
        const left = text.x - box.x;
        const top = text.y - box.y;
        const atTop = top < LayoutCheck.MIN_INSET && box.height > 2 * text.height;
        if (left < LayoutCheck.MIN_INSET || atTop) {
            this.add(shape, `touches the edge of "${around.name}": give ${around.id} padding`);
        }
    }

    private checkText(shape: any, board: any): void {
        if (shape.type !== "text") {
            return;
        }
        const size = Number(shape.fontSize);
        if (size < LayoutCheck.MIN_FONT_SIZE) {
            this.add(shape, `is tiny (${size}px)`);
        }
        const color = LayoutCheck.fill(shape);
        const ground = LayoutCheck.fill(LayoutCheck.drawnAncestor(shape, board, true));
        if (color && ground) {
            const [dark, light] = [color, ground].map(LayoutCheck.luminance).sort((a, b) => a - b);
            const contrast = light / dark;
            if (contrast < LayoutCheck.MIN_CONTRAST) {
                this.add(shape, `has weak contrast (${contrast.toFixed(1)}:1, ${color} on ${ground})`);
            }
        }
    }

    private checkOverlaps(shapes: any[]): void {
        shapes.forEach((shape, index) => {
            for (const other of shapes.slice(index + 1)) {
                const texts = shape.type === "text" && other.type === "text";
                const siblings =
                    shape.type === "board" && other.type === "board" && shape.parent?.id === other.parent?.id;
                if ((texts || siblings) && LayoutCheck.hit(this.box(shape), this.box(other))) {
                    this.add(shape, `overlaps "${other.name}" ${other.id}`);
                }
            }
        });
    }

    private isOut(shape: any, around: any): boolean {
        const [a, b] = [this.box(shape), this.box(around)];
        const room = Math.min(a.x - b.x, a.y - b.y, b.x + b.width - a.x - a.width, b.y + b.height - a.y - a.height);
        return room < -LayoutCheck.TOLERANCE;
    }

    /** Bounds of a shape; of a text, where its letters are. */
    private box(shape: any): Box {
        let box = this.boxes.get(shape.id);
        if (!box) {
            const letters = shape.type === "text" ? shape.textBounds : null;
            box = (letters?.width ? letters : shape.bounds) as Box;
            this.boxes.set(shape.id, box);
        }
        return box;
    }

    private add(shape: any, problem: string): void {
        this.lines.push(`${shape.type} "${shape.name}" ${shape.id} ${problem}`);
    }

    private static hit(a: Box, b: Box): boolean {
        const shared = Math.min(a.x + a.width - b.x, b.x + b.width - a.x, a.y + a.height - b.y, b.y + b.height - a.y);
        return shared > LayoutCheck.TOLERANCE;
    }

    /** The nearest board around a shape that shows its box: by a fill, or also by a stroke. */
    private static drawnAncestor(shape: any, board: any, fillOnly = false): any {
        let around = shape.parent;
        while (around && around.id !== board.id) {
            if (LayoutCheck.fill(around) || (!fillOnly && around.strokes?.length > 0)) {
                return around;
            }
            around = around.parent;
        }
        return board;
    }

    private static fill(shape: any): string | undefined {
        const fill = Array.isArray(shape.fills) ? shape.fills[0] : undefined;
        // a faint fill hardly changes the ground below it
        return fill && (fill.fillOpacity ?? 1) >= 0.5 ? fill.fillColor : undefined;
    }

    private static luminance(hex: string): number {
        return [0.2126, 0.7152, 0.0722].reduce((sum, share, index) => {
            const channel = parseInt(hex.slice(2 * index + 1, 2 * index + 3), 16) / 255;
            return sum + share * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
        }, 0.05);
    }

    private static children(shape: any): any[] {
        return shape && "children" in shape && shape.children ? [...shape.children] : [];
    }
}
