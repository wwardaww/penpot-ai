import { FakeComponent, type FakeShape } from "../../../designmd/testing/FakePenpot";
import { strokeIcon } from "../../../icons/testing/archives";
import { FakeDesignSystemPenpot, FakeNode, FakePage } from "../../testing/FakeDesignSystemPenpot";

/** Layer of a project file: what the inventory reads on screens. */
export class ProjectNode extends FakeNode {
    public visible = true;
    public shadows: unknown[] = [];
    public flex: Record<string, number> | null = null;
    public fontFamily = "Inter";
    public fontWeight = "400";
    public lineHeight = "1.2";
    public letterSpacing = "0";
    /** set when this layer is the main of a component */
    public mainOf: FakeComponent | null = null;
    /** set when this layer is a copy (head) of a component */
    public copyOf: FakeComponent | null = null;
    public variantContainer = false;

    constructor(type: string, width: number, height: number, name?: string, characters = "") {
        super(type, width, height, characters);
        if (name) {
            this.name = name;
        }
    }

    isComponentMainInstance(): boolean {
        return this.mainOf !== null;
    }

    isComponentCopyInstance(): boolean {
        return this.copyOf !== null;
    }

    isComponentHead(): boolean {
        return this.copyOf !== null;
    }

    isVariantContainer(): boolean {
        return this.variantContainer;
    }

    component(): FakeComponent | null {
        return this.mainOf ?? this.copyOf;
    }

    /** Adds children and returns this layer (test setup). */
    with(...children: FakeNode[]): this {
        children.forEach((child) => this.appendChild(child));
        return this;
    }
}

/** Page with lookup by id and removal. */
export class ProjectPage extends FakePage {
    constructor(
        name: string,
        private readonly owner: FakeProjectPenpot
    ) {
        super(name);
        const page = this;
        const append = this.root.appendChild.bind(this.root);
        this.root.appendChild = (child: FakeNode) => {
            if (owner.currentPage !== page) {
                throw new Error("Cannot modify a page that is not currently active");
            }
            append(child);
        };
    }

    getShapeById(id: string): FakeNode | null {
        const find = (node: FakeNode): FakeNode | null => {
            if (node.id === id) {
                return node;
            }
            for (const child of node.children) {
                const found = find(child);
                if (found) {
                    return found;
                }
            }
            return null;
        };
        return find(this.root);
    }

    remove(): void {
        const pages = this.owner.pages;
        if (pages.length <= 1) {
            throw new Error("Cannot remove the last page of the file");
        }
        pages.splice(pages.indexOf(this), 1);
        for (const node of this.all()) {
            const main = (node as ProjectNode).mainOf;
            if (main) {
                this.owner.dropComponent(main);
            }
        }
    }

    /** Every layer of the page. */
    all(): FakeNode[] {
        const out: FakeNode[] = [];
        const walk = (node: FakeNode) => {
            for (const child of node.children) {
                out.push(child);
                walk(child);
            }
        };
        walk(this.root);
        return out;
    }
}

/**
 * {@link FakeDesignSystemPenpot} with a project canvas: pages of screens, main components and
 * their copies, variant containers, library items that can be removed, `generateMarkup` and
 * `penpotUtils.createVariantContainer`. Writes to a page that is not open fail, as in Penpot.
 */
export class FakeProjectPenpot extends FakeDesignSystemPenpot {
    /** SVG markup returned for icon candidates */
    public markup = (_node: FakeNode) => strokeIcon("M4 4h16");
    /** variant containers made through `penpotUtils` */
    public readonly containers: ProjectNode[] = [];

    constructor(fileName: string = "Shop") {
        super(fileName);
        this.pages.splice(0, this.pages.length, new ProjectPage("Page 1", this));
        this.currentPage = this.pages[0];
        const library = this.library.local as unknown as Record<string, unknown>;
        library.createComponent = (shapes: FakeNode[]) => this.makeComponent(shapes[0]);
        const createColor = this.library.local.createColor.bind(this.library.local);
        library.createColor = () => {
            const color = createColor();
            Object.assign(color, {
                remove: () => this.library.local.colors.splice(this.library.local.colors.indexOf(color), 1),
            });
            return color;
        };
        const createTypography = this.library.local.createTypography.bind(this.library.local);
        library.createTypography = () => {
            const typography = createTypography();
            Object.assign(typography, {
                remove: () =>
                    this.library.local.typographies.splice(this.library.local.typographies.indexOf(typography), 1),
            });
            return typography;
        };
    }

    /** Page by name (project pages). */
    public projectPage(name: string): ProjectPage {
        const page = this.page(name);
        if (!(page instanceof ProjectPage)) {
            throw new Error(`no project page ${name}`);
        }
        return page;
    }

    createPage(): FakePage {
        const page = new ProjectPage(`Page ${this.pages.length + 1}`, this);
        this.pages.push(page);
        return page;
    }

    /** Adds a page with top-level layers (test setup). */
    public addPage(name: string, ...layers: FakeNode[]): ProjectPage {
        const page = new ProjectPage(name, this);
        this.pages.push(page);
        layers.forEach((layer) => FakeNode.prototype.appendChild.call(page.root, layer));
        return page;
    }

    /** Makes a layer the main of a new component (test setup and scripts). */
    public makeComponent(node: FakeNode, name?: string): FakeComponent {
        const component = new FakeComponent(name ?? node.name, "", node as unknown as FakeShape);
        const self = this;
        Object.assign(component, {
            mainNode: node,
            isVariant: () => node.parent instanceof ProjectNode && node.parent.variantContainer,
            remove() {
                self.dropComponent(component);
                node.remove();
            },
        });
        (node as ProjectNode).mainOf = component;
        this.library.local.components.push(component);
        return component;
    }

    /** Removes a component from the library. */
    public dropComponent(component: FakeComponent): void {
        const list = this.library.local.components;
        const index = list.indexOf(component);
        if (index >= 0) {
            list.splice(index, 1);
        }
    }

    /** A copy of a component (test setup). */
    public copyOf(component: FakeComponent, width = 40, height = 40): ProjectNode {
        const node = new ProjectNode("board", width, height, component.name);
        node.copyOf = component;
        return node;
    }

    generateMarkup(shapes: FakeNode[], _options?: { type?: string }): string {
        return this.markup(shapes[0]);
    }

    /** Runs plugin code with `penpot` and `penpotUtils` in scope. */
    public async execute(code: string): Promise<unknown> {
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
            ...args: string[]
        ) => (...values: unknown[]) => Promise<unknown>;
        const utils = {
            createVariantContainer: (entries: { shape: FakeNode; properties: Record<string, string> }[]) => {
                const first = entries[0].shape;
                const container = new ProjectNode("board", 0, 0, "Variants");
                container.variantContainer = true;
                const parent = first.parent!;
                parent.appendChild(container);
                for (const entry of entries) {
                    container.appendChild(entry.shape);
                    Object.assign(entry.shape, { variantProperties: entry.properties });
                }
                this.containers.push(container);
                return container;
            },
        };
        return new AsyncFunction("penpot", "penpotUtils", code)(this, utils);
    }
}

/** A text layer (test setup). */
export function text(characters: string, size = "16", weight = "400", color = "#111827"): ProjectNode {
    const node = new ProjectNode("text", characters.length * 7, Number(size) * 1.4, characters, characters);
    node.fontSize = size;
    node.fontWeight = weight;
    node.fills = [{ fillColor: color, fillOpacity: 1 }];
    return node;
}

/** A filled rectangle (test setup). */
export function rect(color: string, width = 100, height = 40, radius = 0): ProjectNode {
    const node = new ProjectNode("rectangle", width, height, "Rectangle");
    node.fills = [{ fillColor: color, fillOpacity: 1 }];
    node.borderRadius = radius;
    return node;
}

/** A small vector drawing (an icon, test setup). */
export function vector(name: string, size = 24): ProjectNode {
    const path = new ProjectNode("path", size, size, "Path");
    Object.assign(path, { content: `M0 0L${name.length} ${size}` });
    path.strokes = [{ strokeColor: "#111827" }];
    return new ProjectNode("group", size, size, name).with(path);
}
