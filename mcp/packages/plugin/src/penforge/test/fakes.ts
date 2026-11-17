/**
 * Fake Penpot objects for the Penforge plugin tests.
 *
 * They implement only the members the Penforge helpers read or write, with plain fields, so tests
 * can assert on the state after a call.
 */

let nextId = 1;

/**
 * Returns a fresh id.
 */
export function newId(prefix: string = "shape"): string {
    return `${prefix}-${nextId++}`;
}

/**
 * Creates a fake shape with sensible defaults; `overrides` replaces any field.
 */
export function fakeShape(overrides: Record<string, any> = {}): any {
    const shape: any = {
        id: newId(),
        name: "Shape",
        type: "rectangle",
        parent: null,
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        parentX: 0,
        parentY: 0,
        rotation: 0,
        flipX: false,
        flipY: false,
        hidden: false,
        blocked: false,
        constraintsHorizontal: "left",
        constraintsVertical: "top",
        opacity: 1,
        blendMode: "normal",
        borderRadius: 0,
        borderRadiusTopLeft: 0,
        borderRadiusTopRight: 0,
        borderRadiusBottomRight: 0,
        borderRadiusBottomLeft: 0,
        fills: [],
        strokes: [],
        shadows: [],
        blur: undefined,
        layoutChild: undefined,
        layoutCell: undefined,
        tokens: {},
        interactions: [],
        appliedTokens: [] as [string, string[]][],
        resizeCalls: [] as [number, number][],
        isComponentInstance: () => false,
        isComponentMainInstance: () => false,
        isComponentCopyInstance: () => false,
        isComponentRoot: () => false,
        component: () => null,
        resize(width: number, height: number) {
            this.resizeCalls.push([width, height]);
            this.width = width;
            this.height = height;
        },
        applyToken(token: any, properties: string[]) {
            this.appliedTokens.push([token.name, properties]);
        },
        ...overrides,
    };
    if (Array.isArray(shape.children)) {
        for (const child of shape.children) {
            child.parent = shape;
        }
    }
    return shape;
}

/**
 * Creates a fake board.
 */
export function fakeBoard(overrides: Record<string, any> = {}): any {
    return fakeShape({
        type: "board",
        name: "Board",
        clipContent: true,
        horizontalSizing: "fix",
        verticalSizing: "fix",
        children: [],
        flex: undefined,
        grid: undefined,
        isVariantContainer: () => false,
        addFlexLayout() {
            this.flex = fakeLayout("row");
            const board = this;
            this.flex.remove = () => {
                board.flex = undefined;
            };
            return this.flex;
        },
        addGridLayout() {
            this.grid = { ...fakeLayout("column"), rows: [], columns: [] };
            const board = this;
            this.grid.remove = () => {
                board.grid = undefined;
            };
            return this.grid;
        },
        ...overrides,
    });
}

/**
 * Creates a fake flex/grid layout object.
 */
export function fakeLayout(dir: string, overrides: Record<string, any> = {}): any {
    return {
        dir,
        wrap: "nowrap",
        alignItems: "start",
        alignContent: undefined,
        justifyItems: undefined,
        justifyContent: "start",
        rowGap: 0,
        columnGap: 0,
        topPadding: 0,
        rightPadding: 0,
        bottomPadding: 0,
        leftPadding: 0,
        horizontalSizing: "fix",
        verticalSizing: "fix",
        remove() {},
        ...overrides,
    };
}

/**
 * One styled run of a fake text.
 */
export interface FakeRun {
    text: string;
    style: Record<string, any>;
}

/**
 * Creates a fake text shape whose `getRange` reports the style of the given runs.
 */
export function fakeText(runs: FakeRun[], overrides: Record<string, any> = {}): any {
    const content = runs.map((run) => run.text).join("");
    const styleAt = (index: number) => {
        let offset = 0;
        for (const run of runs) {
            if (index < offset + run.text.length) {
                return run.style;
            }
            offset += run.text.length;
        }
        return runs[runs.length - 1].style;
    };
    const keys = new Set(runs.flatMap((run) => Object.keys(run.style)));
    const shapeLevel: Record<string, any> = {};
    for (const key of keys) {
        const values = new Set(runs.map((run) => JSON.stringify(run.style[key])));
        shapeLevel[key] = values.size === 1 ? runs[0].style[key] : "mixed";
    }
    return fakeShape({
        type: "text",
        name: "Text",
        characters: content,
        growType: "auto-width",
        align: "left",
        verticalAlign: "top",
        direction: "ltr",
        ...shapeLevel,
        getRange(start: number, end: number) {
            return { characters: content.slice(start, end), ...styleAt(start) };
        },
        ...overrides,
    });
}

/**
 * Creates a fake page whose root holds the given top-level shapes.
 */
export function fakePage(name: string, children: any[], overrides: Record<string, any> = {}): any {
    const root = fakeShape({ type: "board", name: "Root", id: newId("root"), children });
    const page: any = {
        id: newId("page"),
        name,
        root,
        flows: [],
        threads: [] as any[],
        getShapeById(id: string) {
            const walk = (shape: any): any => {
                if (shape.id === id) {
                    return shape;
                }
                for (const child of shape.children ?? []) {
                    const found = walk(child);
                    if (found) {
                        return found;
                    }
                }
                return null;
            };
            return walk(root);
        },
        async findCommentThreads(criteria: { showResolved: boolean }) {
            return this.threads.filter((t: any) => criteria.showResolved || !t.resolved);
        },
        ...overrides,
    };
    return page;
}

/**
 * Creates a fake `penpot` API over the given pages; the first page is the current one.
 */
export function fakePenpot(pages: any[], overrides: Record<string, any> = {}): any {
    const calls: string[] = [];
    const api: any = {
        calls,
        currentPage: pages[0],
        currentFile: { pages },
        selection: [],
        get root() {
            return this.currentPage?.root ?? null;
        },
        library: { local: { tokens: { sets: [] } } },
        history: {
            undoBlockBegin() {
                calls.push("undoBlockBegin");
                return Symbol("block");
            },
            undoBlockFinish() {
                calls.push("undoBlockFinish");
            },
        },
        async openPage(page: any) {
            calls.push(`openPage:${page.id}`);
            api.currentPage = page;
        },
        generateMarkup(shapes: any[], options: any) {
            return `<div data-type="${options.type}">${shapes[0].name}</div>`;
        },
        generateStyle(shapes: any[], options: any) {
            return `/* ${options.type} prelude=${options.withPrelude} children=${options.includeChildren} */ .${shapes[0].name} {}`;
        },
        async generateFontFaces() {
            return "@font-face {}";
        },
        ...overrides,
    };
    return api;
}
