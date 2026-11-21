import type { WorkflowToolResult, WorkflowToolsApi } from "@penpot/mcp-common";

let nextId = 1;
const newId = (prefix: string) => `${prefix}-${nextId++}`;

/** Token of a fake catalog. */
export interface FakeToken {
    name: string;
    type: string;
    value: string;
    resolvedValue?: string | number;
}

/** Layer of the fake file: the Plugin API fields the W30 scripts read and write. */
export class FakeLayer {
    public id = newId("layer");
    public children: FakeLayer[] = [];
    public parent: FakeLayer | null = null;
    public fills: Record<string, unknown>[] = [];
    public strokes: Record<string, unknown>[] = [];
    public borderRadius = 0;
    public flex: Record<string, number> | null = null;
    public grid: Record<string, number> | null = null;
    public shadows: Record<string, unknown>[] = [];
    public tokens: Record<string, string> = {};
    public fontFamily = "Inter";
    public fontSize: string = "16";
    public fontWeight = "400";
    public characters = "";
    public x = 0;
    public y = 0;
    public width = 100;
    public height = 40;
    public mainOf: FakeLibComponent | null = null;
    public copyOf: FakeLibComponent | null = null;
    public removed = false;
    public typographyApplied: string | null = null;
    private readonly pluginData = new Map<string, string>();

    constructor(
        public type: string,
        public name: string
    ) {}

    isComponentMainInstance(): boolean {
        return this.mainOf !== null;
    }

    isComponentCopyInstance(): boolean {
        return this.copyOf !== null;
    }

    component(): FakeLibComponent | null {
        return this.mainOf ?? this.copyOf;
    }

    appendChild(child: FakeLayer): void {
        child.parent?.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = this;
        this.children.push(child);
    }

    insertChild(index: number, child: FakeLayer): void {
        child.parent?.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = this;
        this.children.splice(index, 0, child);
    }

    remove(): void {
        this.removed = true;
        this.parent?.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
    }

    applyToken(token: FakeToken, properties: string[]): void {
        for (const property of properties) {
            this.tokens[property] = token.name;
        }
        const value = token.resolvedValue ?? token.value;
        if (properties.includes("fill")) {
            this.fills = [{ fillColor: value, fillOpacity: 1 }];
        }
        if (properties.some((p) => p.startsWith("borderRadius"))) {
            this.borderRadius = Number(value);
        }
        const layout = this.flex ?? this.grid;
        const map: Record<string, string> = {
            rowGap: "rowGap",
            columnGap: "columnGap",
            paddingTop: "topPadding",
            paddingRight: "rightPadding",
            paddingBottom: "bottomPadding",
            paddingLeft: "leftPadding",
        };
        for (const property of properties) {
            if (layout && map[property]) {
                layout[map[property]] = Number(value);
            }
        }
    }

    swapComponent(component: FakeLibComponent): void {
        this.copyOf = component;
        this.name = component.name;
    }

    getSharedPluginData(namespace: string, key: string): string {
        return this.pluginData.get(`${namespace}/${key}`) ?? "";
    }

    setSharedPluginData(namespace: string, key: string, value: string): void {
        this.pluginData.set(`${namespace}/${key}`, value);
    }

    /** Adds children and returns this layer (test setup). */
    with(...children: FakeLayer[]): this {
        children.forEach((child) => this.appendChild(child));
        return this;
    }

    /** Deep copy with new ids (instances of components). */
    clone(): FakeLayer {
        const copy = new FakeLayer(this.type, this.name);
        Object.assign(copy, {
            fills: this.fills.map((f) => ({ ...f })),
            strokes: this.strokes.map((s) => ({ ...s })),
            borderRadius: this.borderRadius,
            flex: this.flex ? { ...this.flex } : null,
            fontFamily: this.fontFamily,
            fontSize: this.fontSize,
            fontWeight: this.fontWeight,
            characters: this.characters,
            width: this.width,
            height: this.height,
        });
        this.children.forEach((child) => copy.appendChild(child.clone()));
        return copy;
    }

    /** All layers below (and including) this one. */
    all(): FakeLayer[] {
        return [this, ...this.children.flatMap((child) => child.all())];
    }
}

/** Library color. */
export class FakeLibColor {
    public id = newId("color");
    public path = "";
    public opacity = 1;

    constructor(
        public name: string,
        public color: string,
        public libraryId: string
    ) {}

    asFill() {
        return {
            fillColor: this.color,
            fillOpacity: this.opacity,
            fillColorRefId: this.id,
            fillColorRefFile: this.libraryId,
        };
    }

    asStroke() {
        return {
            strokeColor: this.color,
            strokeOpacity: this.opacity,
            strokeColorRefId: this.id,
            strokeColorRefFile: this.libraryId,
        };
    }
}

/** Library text style. */
export class FakeLibTypography {
    public id = newId("typo");
    public path = "";

    constructor(
        public name: string,
        public fontFamily: string,
        public fontSize: string,
        public fontWeight: string
    ) {}

    applyToText(text: FakeLayer): void {
        text.fontFamily = this.fontFamily;
        text.fontSize = this.fontSize;
        text.fontWeight = this.fontWeight;
        text.typographyApplied = this.id;
    }
}

/** Library component. */
export class FakeLibComponent {
    public id = newId("component");
    public path = "";
    private readonly pluginData = new Map<string, string>();

    constructor(
        public name: string,
        public libraryId: string,
        public main: FakeLayer
    ) {
        main.mainOf = this;
        main.name = name;
    }

    instance(): FakeLayer {
        const copy = this.main.clone();
        copy.copyOf = this;
        return copy;
    }

    mainInstance(): FakeLayer {
        return this.main;
    }

    getSharedPluginData(namespace: string, key: string): string {
        return this.pluginData.get(`${namespace}/${key}`) ?? "";
    }
}

/** Library (local or linked). */
export class FakeLibrary {
    public colors: FakeLibColor[] = [];
    public typographies: FakeLibTypography[] = [];
    public components: FakeLibComponent[] = [];
    public tokens: { sets: { name: string; active: boolean; tokens: FakeToken[] }[] } = { sets: [] };

    constructor(
        public id: string,
        public name: string
    ) {}

    addColor(name: string, hex: string): FakeLibColor {
        const color = new FakeLibColor(name, hex, this.id);
        this.colors.push(color);
        return color;
    }

    addTypography(name: string, family: string, size: string, weight: string): FakeLibTypography {
        const typography = new FakeLibTypography(name, family, size, weight);
        this.typographies.push(typography);
        return typography;
    }

    addComponent(name: string, main: FakeLayer): FakeLibComponent {
        const component = new FakeLibComponent(name, this.id, main);
        this.components.push(component);
        return component;
    }

    addTokens(...tokens: FakeToken[]): void {
        let set = this.tokens.sets[0];
        if (!set) {
            set = { name: "DESIGN.md", active: true, tokens: [] };
            this.tokens.sets.push(set);
        }
        set.tokens.push(...tokens.map((token) => ({ ...token, resolvedValue: token.resolvedValue ?? token.value })));
    }

    /** `createComponent([shape])` as the Plugin API has it. */
    createComponent(shapes: FakeLayer[]): FakeLibComponent {
        return this.addComponent(shapes[0].name, shapes[0]);
    }
}

/** Page. */
export class FakePage {
    public id = newId("page");
    public root = new FakeLayer("board", "root");

    constructor(public name: string) {}

    getShapeById(id: string): FakeLayer | null {
        return this.root.all().find((layer) => layer.id === id && layer !== this.root) ?? null;
    }

    add(...layers: FakeLayer[]): void {
        layers.forEach((layer) => this.root.appendChild(layer));
    }
}

/**
 * In-memory stand-in for the Plugin API parts the W30 scripts use: pages and layers, the local
 * library, linked libraries (`connected`, `connectLibrary`, `tokensSource`), undo blocks and
 * `saveVersion`. Tests run the scripts' plain JavaScript against it.
 */
export class FakeBoundPenpot {
    public readonly pages: FakePage[] = [];
    public currentPage: FakePage;
    public readonly undoBlocks: number[] = [];
    public readonly versions: string[] = [];
    public readonly currentFile: {
        id: string;
        name: string;
        pages: FakePage[];
        saveVersion(label: string): Promise<object>;
    };
    public readonly library: {
        local: FakeLibrary;
        connected: FakeLibrary[];
        tokensSource: FakeLibrary;
        connectLibrary(id: string): Promise<FakeLibrary>;
    };
    /** libraries the file could link (the team's shared libraries) */
    public readonly available = new Map<string, FakeLibrary>();
    public readonly history = {
        undoBlockBegin: () => {
            this.undoBlocks.push(this.undoBlocks.length + 1);
            return this.undoBlocks.length;
        },
        undoBlockFinish: (_block: number) => undefined,
    };

    constructor(
        public readonly fileId: string,
        fileName = "Project"
    ) {
        const page = new FakePage("Page 1");
        this.pages.push(page);
        this.currentPage = page;
        const fake = this;
        this.currentFile = {
            id: fileId,
            name: fileName,
            pages: this.pages,
            async saveVersion(label: string) {
                fake.versions.push(label);
                return { label, createdAt: new Date() };
            },
        };
        const local = new FakeLibrary(fileId, fileName);
        let source: FakeLibrary = local;
        this.library = {
            local,
            connected: [],
            get tokensSource() {
                return source;
            },
            set tokensSource(lib: FakeLibrary) {
                if (lib !== local && !fake.library.connected.includes(lib)) {
                    throw new Error("not connected");
                }
                source = lib;
            },
            connectLibrary: async (id: string) => {
                const lib = fake.available.get(id);
                if (!lib) {
                    throw new Error("no such library");
                }
                if (!fake.library.connected.includes(lib)) {
                    fake.library.connected.push(lib);
                }
                return lib;
            },
        };
    }

    async openPage(page: FakePage): Promise<void> {
        this.currentPage = page;
    }

    addPage(name: string): FakePage {
        const page = new FakePage(name);
        this.pages.push(page);
        return page;
    }

    /** Runs plugin code the way the `execute_code` task does (body of an async function). */
    public async execute(code: string): Promise<unknown> {
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
            ...args: string[]
        ) => (...values: unknown[]) => Promise<unknown>;
        return new AsyncFunction("penpot", code)(this);
    }

    /** Tools API whose `execute_code` runs against this fake. */
    public tools(calls: string[] = []): WorkflowToolsApi {
        return {
            call: async (toolName: string, args: Record<string, unknown> = {}): Promise<WorkflowToolResult> => {
                calls.push(toolName);
                if (toolName !== "execute_code") {
                    return { isError: true, content: [], text: `unknown tool ${toolName}` };
                }
                try {
                    const result = await this.execute(String(args.code));
                    return { isError: false, content: [], text: JSON.stringify({ result, log: "" }) };
                } catch (error) {
                    return { isError: true, content: [], text: (error as Error).message };
                }
            },
            list: async () => ["execute_code"],
        };
    }
}

/** Text layer. */
export function textLayer(name: string, characters: string, size = "16", weight = "400", family = "Inter"): FakeLayer {
    const layer = new FakeLayer("text", name);
    Object.assign(layer, { characters, fontSize: size, fontWeight: weight, fontFamily: family });
    return layer;
}

/** Rectangle with a solid fill. */
export function rectLayer(name: string, hex: string, radius = 0): FakeLayer {
    const layer = new FakeLayer("rectangle", name);
    layer.fills = [{ fillColor: hex, fillOpacity: 1 }];
    layer.borderRadius = radius;
    return layer;
}

/** Board. */
export function boardLayer(name: string, ...children: FakeLayer[]): FakeLayer {
    return new FakeLayer("board", name).with(...children);
}
