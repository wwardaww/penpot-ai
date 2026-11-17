import type { WorkflowToolResult, WorkflowToolsApi } from "@penpot/mcp-common";

/**
 * In-memory stand-in for the parts of the Penpot Plugin API that the DESIGN.md scripts use
 * (`penpot.library.local`, `penpot.fonts`, `penpot.currentFile`). Tests run the scripts' plain
 * JavaScript against it, the way the MCP plugin runs them in the browser.
 */
export class FakePenpot {
    public readonly library: { local: FakeLibrary };
    public readonly fonts = new FakeFonts();
    public readonly currentFile: { name: string; versions: string[]; saveVersion(label: string): Promise<object> };
    public failSaveVersion = false;

    constructor(fileName: string = "Acme") {
        this.library = { local: new FakeLibrary() };
        const fake = this;
        this.currentFile = {
            name: fileName,
            versions: [],
            async saveVersion(label: string) {
                if (fake.failSaveVersion) {
                    throw new Error("versions are disabled");
                }
                this.versions.push(label);
                return { label };
            },
        };
    }

    /** Runs plugin code the way the `execute_code` task does (body of an async function). */
    public async execute(code: string): Promise<unknown> {
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
            ...args: string[]
        ) => (...values: unknown[]) => Promise<unknown>;
        return new AsyncFunction("penpot", code)(this);
    }

    /** Tools API whose `execute_code` runs against this fake; records the tool calls. */
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

let nextId = 1;
const newId = () => `id-${nextId++}`;

class PluginDataHolder {
    private readonly data = new Map<string, string>();

    getSharedPluginData(namespace: string, key: string): string {
        return this.data.get(`${namespace}/${key}`) ?? "";
    }

    setSharedPluginData(namespace: string, key: string, value: string): void {
        this.data.set(`${namespace}/${key}`, value);
    }
}

export class FakeColor extends PluginDataHolder {
    public readonly id = newId();
    public name = "Color";
    public path = "";
    public color: string | undefined = "#000000";
    public opacity: number | undefined = 1;
    public gradient: unknown = undefined;
    public image: unknown = undefined;
}

export class FakeTypography extends PluginDataHolder {
    public readonly id = newId();
    public name = "Typography";
    public path = "";
    public fontId = "sourcesanspro";
    public fontFamily = "sourcesanspro";
    public fontVariantId = "regular";
    public fontSize = "14";
    public fontWeight = "400";
    public fontStyle: string | null = "normal";
    public lineHeight = "1.2";
    public letterSpacing = "0";

    setFont(font: FakeFont, variant?: FakeFontVariant): void {
        this.fontId = font.fontId;
        this.fontFamily = font.fontFamily;
        const chosen = variant ?? font.variants[0];
        this.fontVariantId = chosen.fontVariantId;
        this.fontWeight = chosen.fontWeight;
        this.fontStyle = chosen.fontStyle;
    }
}

export interface FakeShape {
    type: string;
    width: number;
    height: number;
    borderRadius?: number;
    fills?: { fillColor?: string; fillOpacity?: number; fillColorRefId?: string }[];
    tokens?: Record<string, string>;
    flex?: { topPadding: number; rightPadding: number; bottomPadding: number; leftPadding: number };
    children?: FakeShape[];
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    lineHeight?: string;
    letterSpacing?: string;
}

export class FakeComponent extends PluginDataHolder {
    public readonly id = newId();

    constructor(
        public name: string,
        public path: string,
        private readonly main: FakeShape | null
    ) {
        super();
    }

    mainInstance(): FakeShape | null {
        return this.main;
    }
}

export class FakeToken {
    public readonly id = newId();
    public description = "";

    constructor(
        private readonly owner: FakeTokenSet,
        public readonly type: string,
        public name: string,
        public value: unknown
    ) {}

    remove(): void {
        this.owner.tokens.splice(this.owner.tokens.indexOf(this), 1);
    }
}

export class FakeTokenSet {
    public readonly id = newId();
    public readonly tokens: FakeToken[] = [];

    constructor(
        public name: string,
        public active: boolean
    ) {}

    addToken({ type, name, value }: { type: string; name: string; value: unknown }): FakeToken {
        if (this.tokens.some((token) => token.name === name)) {
            throw new Error(`token ${name} exists`);
        }
        const token = new FakeToken(this, type, name, typeof value === "number" ? String(value) : value);
        this.tokens.push(token);
        return token;
    }

    toggleActive(): void {
        this.active = !this.active;
    }
}

export class FakeTokenTheme {
    public readonly id = newId();
    public readonly externalId = undefined;
    public active = false;
    public readonly activeSets: FakeTokenSet[] = [];

    constructor(
        public group: string,
        public name: string
    ) {}

    addSet(set: FakeTokenSet): void {
        this.activeSets.push(set);
    }
}

export class FakeTokenCatalog {
    public isEditableTokens = true;
    public readonly sets: FakeTokenSet[] = [];
    public readonly themes: FakeTokenTheme[] = [];

    addSet({ name, active }: { name: string; active?: boolean }): FakeTokenSet {
        const set = new FakeTokenSet(name, active ?? false);
        this.sets.push(set);
        return set;
    }

    addTheme({ group, name }: { group: string; name: string }): FakeTokenTheme {
        const theme = new FakeTokenTheme(group, name);
        this.themes.push(theme);
        return theme;
    }
}

export class FakeLibrary {
    public readonly colors: FakeColor[] = [];
    public readonly typographies: FakeTypography[] = [];
    public readonly components: FakeComponent[] = [];
    public readonly tokens = new FakeTokenCatalog();

    createColor(): FakeColor {
        const color = new FakeColor();
        this.colors.push(color);
        return color;
    }

    createTypography(): FakeTypography {
        const typography = new FakeTypography();
        this.typographies.push(typography);
        return typography;
    }

    color(name: string): FakeColor | undefined {
        return this.colors.find((color) => color.name === name);
    }

    typography(name: string): FakeTypography | undefined {
        return this.typographies.find((typography) => typography.name === name);
    }
}

export interface FakeFontVariant {
    name: string;
    fontVariantId: string;
    fontWeight: string;
    fontStyle: "normal" | "italic";
}

export interface FakeFont {
    name: string;
    fontId: string;
    fontFamily: string;
    variants: FakeFontVariant[];
}

export class FakeFonts {
    private readonly fonts: FakeFont[] = ["Work Sans", "Inter", "Source Sans Pro"].map((family) => ({
        name: family,
        fontId: `gfont-${family.toLowerCase().replace(/\s+/g, "-")}`,
        fontFamily: family,
        variants: ["300", "400", "500", "600", "700"].map((weight) => ({
            name: weight,
            fontVariantId: weight === "400" ? "regular" : weight,
            fontWeight: weight,
            fontStyle: "normal" as const,
        })),
    }));

    findByName(name: string): FakeFont | null {
        return this.fonts.find((font) => font.name.toLowerCase() === name.toLowerCase()) ?? null;
    }
}
