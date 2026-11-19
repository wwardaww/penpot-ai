import {
    FakeColor,
    FakeComponent,
    FakePenpot,
    FakeToken,
    FakeTypography,
    type FakeShape,
} from "../../designmd/testing/FakePenpot";

let nextId = 1;
const newId = () => `ds-${nextId++}`;

/** Shape of the fake canvas (boards, rectangles, texts, SVG groups). */
export class FakeNode {
    public readonly id = newId();
    public name: string;
    public x = 0;
    public y = 0;
    public width: number;
    public height: number;
    public fills: { fillColor?: string; fillOpacity?: number }[] = [];
    public strokes: { strokeColor?: string }[] = [];
    public children: FakeNode[] = [];
    public parent: FakeNode | null = null;
    public growType = "fixed";
    public fontSize = "14";
    public borderRadius = 0;
    public clipContent = true;
    public readonly tokens: Record<string, string> = {};
    public typography: string | null = null;
    public removed = false;
    private readonly data = new Map<string, string>();

    constructor(
        public readonly type: string,
        width: number,
        height: number,
        public characters = ""
    ) {
        this.name = type;
        this.width = width;
        this.height = height;
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
    }

    appendChild(child: FakeNode): void {
        child.parent?.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = this;
        this.children.push(child);
    }

    remove(): void {
        this.removed = true;
        if (this.parent) {
            this.parent.children.splice(this.parent.children.indexOf(this), 1);
            this.parent = null;
        }
    }

    applyToken(token: { name: string }, properties: string[]): void {
        for (const property of properties) {
            this.tokens[property] = token.name;
        }
    }

    getSharedPluginData(namespace: string, key: string): string {
        return this.data.get(`${namespace}/${key}`) ?? "";
    }

    setSharedPluginData(namespace: string, key: string, value: string): void {
        this.data.set(`${namespace}/${key}`, value);
    }
}

/** Page of the fake file. */
export class FakePage {
    public readonly id = newId();
    public readonly root = new FakeNode("root", 0, 0);

    constructor(public name: string) {}
}

/**
 * {@link FakePenpot} plus the canvas parts the design system scripts use: pages, boards,
 * rectangles, texts, SVG import, components from shapes, undo blocks and file plugin data.
 */
export class FakeDesignSystemPenpot extends FakePenpot {
    public readonly pages: FakePage[] = [new FakePage("Page 1")];
    public currentPage: FakePage = this.pages[0];
    /** undo blocks: opened, closed */
    public readonly undo = { opened: 0, closed: 0, open: 0 };
    /** SVG strings given to `createShapeFromSvg` */
    public readonly svgs: string[] = [];
    public failSvg = (svg: string) => svg.includes("unreadable");
    private readonly fileData = new Map<string, string>();

    public readonly history = {
        undoBlockBegin: () => {
            this.undo.opened++;
            this.undo.open++;
            return Symbol("block");
        },
        undoBlockFinish: (_block: symbol) => {
            this.undo.closed++;
            this.undo.open--;
        },
    };

    constructor(fileName: string = "Acme DS") {
        super(fileName);
        const file = this.currentFile as unknown as Record<string, unknown>;
        file.pages = this.pages;
        file.getSharedPluginData = (namespace: string, key: string) => this.fileData.get(`${namespace}/${key}`) ?? "";
        file.setSharedPluginData = (namespace: string, key: string, value: string) =>
            this.fileData.set(`${namespace}/${key}`, value);
        const library = this.library.local as unknown as Record<string, unknown>;
        library.createComponent = (shapes: FakeNode[]) => {
            const main = shapes[0];
            const component = new FakeComponent(main.name, "", main as unknown as FakeShape);
            Object.assign(component, { mainNode: main });
            this.library.local.components.push(component);
            return component;
        };
    }

    /** File-level shared plugin data. */
    public fileDataOf(namespace: string, key: string): string {
        return this.fileData.get(`${namespace}/${key}`) ?? "";
    }

    /** Page by name. */
    public page(name: string): FakePage | undefined {
        return this.pages.find((page) => page.name === name);
    }

    createPage(): FakePage {
        const page = new FakePage(`Page ${this.pages.length + 1}`);
        this.pages.push(page);
        return page;
    }

    async openPage(page: FakePage): Promise<void> {
        this.currentPage = page;
    }

    createBoard(): FakeNode {
        return this.add(new FakeNode("board", 100, 100));
    }

    createRectangle(): FakeNode {
        return this.add(new FakeNode("rectangle", 100, 100));
    }

    createText(text: string): FakeNode | null {
        return this.add(new FakeNode("text", text.length * 7, 18, text));
    }

    createShapeFromSvg(svg: string): FakeNode | null {
        this.svgs.push(svg);
        if (this.failSvg(svg)) {
            return null;
        }
        const viewBox = svg.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/);
        const group = this.add(
            new FakeNode("group", viewBox ? Number(viewBox[1]) : 24, viewBox ? Number(viewBox[2]) : 24)
        );
        const path = new FakeNode("path", group.width, group.height);
        if (/stroke="#/.test(svg)) {
            path.strokes = [{ strokeColor: "#000000" }];
        }
        if (/fill="#/.test(svg)) {
            path.fills = [{ fillColor: "#000000", fillOpacity: 1 }];
        }
        group.appendChild(path);
        return group;
    }

    private add(node: FakeNode): FakeNode {
        if (this.undo.open <= 0) {
            throw new Error("canvas change outside an undo block");
        }
        this.currentPage.root.appendChild(node);
        return node;
    }
}

// The overview scripts call these on library entries and tokens; W22's fake has no canvas.
Object.assign(FakeColor.prototype, {
    asFill(this: FakeColor) {
        return { fillColor: this.color, fillOpacity: this.opacity ?? 1 };
    },
});
Object.assign(FakeTypography.prototype, {
    applyToText(this: FakeTypography, text: FakeNode) {
        text.typography = this.name;
    },
});
Object.defineProperty(FakeToken.prototype, "resolvedValueString", {
    get(this: FakeToken) {
        return typeof this.value === "string" ? this.value : undefined;
    },
});
Object.assign(FakeToken.prototype, {
    applyToShapes(this: FakeToken, shapes: FakeNode[], properties: string[]) {
        for (const shape of shapes) {
            shape.applyToken(this, properties);
        }
    },
});
