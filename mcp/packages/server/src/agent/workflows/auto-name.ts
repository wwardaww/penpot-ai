import type { Attachment, WorkflowContext, WorkflowToolResult, Workflow } from "@penpot/mcp-common";

/**
 * Auto-naming of layers (W16): gives layers with default names ("Board 4", "Rectangle 12",
 * "Frame 5") names that say what they are.
 *
 * The workflow is user-triggered only. It reads the layers of the selection, the page or the whole
 * file through `execute_code`, keeps the ones with a default name, asks Claude for names in batches
 * (with context and a small screenshot of the board) and reports the proposals as a `result`
 * event. The browser shows them for review and applies the accepted ones itself (one undo step).
 * With `apply: true` the workflow applies them too, one undo block per page; the cleanup workflow
 * (W17) reuses {@link autoName} that way.
 */

/** Which layers to look at. */
export type AutoNameScope = "selection" | "page" | "file";

/** Naming style of the new names. */
export type NamingConvention = "title" | "kebab" | "bem";

/** Params of the `auto-name` workflow. */
export interface AutoNameParams {
    /** default: `selection` when `nodeIds` are given, else `page` */
    scope?: AutoNameScope;
    /** layers of the `selection` scope (their descendants are included) */
    nodeIds?: string[];
    /** page of the `page` scope; default: the tab's page */
    pageId?: string;
    /** default `title` */
    convention?: NamingConvention;
    /** also rename component main roots and layers of component copies (default false) */
    includeComponents?: boolean;
    /** apply the names in the design as well (default false: only report them) */
    apply?: boolean;
    /** layers per Claude turn (default 50, max 80) */
    batchSize?: number;
    /** most layers named in one run (default 400) */
    maxNodes?: number;
    /** attach a small screenshot of the boards (default true) */
    screenshots?: boolean;
}

/** Layer as read from the design. */
export interface LayerRecord {
    id: string;
    pageId: string;
    pageName: string;
    name: string;
    type: string;
    parentId: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
    /** text content (first characters) of text layers */
    text?: string;
    /** component role: root of a main component, inside a main, inside a copy */
    component: "main" | "main-child" | "copy" | null;
    /** variant containers and variant mains carry generated names; never renamed */
    variant: boolean;
    /** `flex-row`, `flex-column`, `grid` for boards with a layout */
    layout: string | null;
    children: string[];
}

/** One proposed rename. */
export interface AutoNameRename {
    nodeId: string;
    pageId: string;
    type: string;
    oldName: string;
    newName: string;
}

/** Outcome of {@link autoName}. */
export interface AutoNameResult {
    scope: AutoNameScope;
    convention: NamingConvention;
    /** layers looked at */
    scanned: number;
    /** layers with a default name that may be renamed */
    candidates: number;
    /** default-named layers left alone because they belong to components */
    skippedComponents: number;
    /** candidates beyond `maxNodes`, not named in this run */
    remaining: number;
    renames: AutoNameRename[];
    /** true when the renames were applied in the design */
    applied: boolean;
    /** renames applied (only with `apply`) */
    appliedCount: number;
}

/**
 * Detection of default layer names, as given by Penpot, Figma, Sketch and Adobe XD, in English and
 * in the languages Penpot's UI is translated to.
 */
export class DefaultNames {
    /** Base default names per shape type; the union is checked for every layer. */
    public static readonly BASE_NAMES: Readonly<Record<string, readonly string[]>> = {
        frame: [
            "Board",
            "Frame",
            "Artboard",
            "Section",
            "Slice",
            "Bord",
            "Mesa de trabajo",
            "Obszar kompozycji",
            "Papan",
            "Plan de travail",
            "Planșă de lucru",
            "Ploča",
            "Plātne",
            "Prancheta",
            "Quadro",
            "Tableau",
            "Tablero",
            "Tablă",
            "Taboleiro",
            "Tabule",
            "Tauler",
            "Tavla",
            "Tavola da disegno",
            "Zeichenfläche",
            "Çalışma yüzeyi",
            "Τραπέζι εργασίας",
            "Доска",
            "Кадр",
            "Рамка",
            "Табла",
            "לוח",
            "آرت‌برد",
            "آرت‌بورد",
            "لوح الرسم",
            "لوحة",
            "बोर्ड",
            "บอร์ด",
            "ボード",
            "フレーム",
            "画板",
            "畫板",
            "보드",
            "프레임",
            "Marco",
        ],
        rect: [
            "Rectangle",
            "Rect",
            "Dikdörtgen",
            "Dreptunghi",
            "Obdélník",
            "Persegi Panjang",
            "Pravokutnik",
            "Prostokąt",
            "Rechteck",
            "Rechthoek",
            "Rectángulo",
            "Rectângulo",
            "Rektangel",
            "Rettangolo",
            "Retângulo",
            "Taisnstūris",
            "Ορθογώνιο",
            "Ορθωγώνιο",
            "Правоугаоник",
            "Прямокутник",
            "Прямоугольник",
            "מרובע",
            "مستطيل",
            "مستطیل",
            "आयत",
            "矩形",
            "長方形",
            "사각형",
        ],
        circle: [
            "Ellipse",
            "Oval",
            "Circle",
            "Cerc",
            "Cerchio",
            "Cercle",
            "Cirkel",
            "Círculo",
            "Daire",
            "Elips",
            "Elipsa",
            "Elipse",
            "Elipsă",
            "Ellips",
            "Ellisse",
            "Kreis",
            "Krug",
            "Kruh",
            "Lingkaran",
            "Okrąg",
            "Κύκλος",
            "Елипса",
            "Еліпс",
            "Коло",
            "Круг",
            "Эллипс",
            "אליפסה",
            "עיגול",
            "دائرة",
            "دایره",
            "بیضی",
            "चक्र",
            "अंडाकार",
            "円",
            "楕円",
            "圆",
            "椭圆",
            "圓形",
            "橢圓",
            "원",
            "타원",
        ],
        group: [
            "Group",
            "Groep",
            "Groupe",
            "Grup",
            "Grupa",
            "Grupo",
            "Grupp",
            "Gruppe",
            "Gruppo",
            "Kelompok",
            "Skupina",
            "Ομάδα",
            "Група",
            "Группа",
            "קבוצה",
            "مجموعة",
            "گروه",
            "समूह",
            "グループ",
            "编组",
            "群組",
            "그룹",
            "Mask",
            "Maschera",
            "Mască",
            "Maska",
            "Maske",
            "Masker",
            "Masque",
            "Màscara",
            "Máscara",
            "Маска",
            "מסכה",
            "قناع",
            "ماسک",
            "मास्क",
            "マスク",
            "蒙版",
            "遮罩",
            "마스크",
        ],
        path: [
            "Path",
            "Vector",
            "Line",
            "Arrow",
            "Polygon",
            "Star",
            "Shape",
            "Combined Shape",
            "Caminho",
            "Chemin",
            "Cesta",
            "Pfad",
            "Pad",
            "Ruta",
            "Trazado",
            "Tracciato",
            "Tracé",
            "Ścieżka",
            "Контур",
            "Путања",
            "נתיב",
            "مسار",
            "مسیر",
            "पथ",
            "パス",
            "路径",
            "路徑",
            "경로",
        ],
        bool: [
            "Bool",
            "Boolean",
            "Union",
            "Subtract",
            "Difference",
            "Intersect",
            "Intersection",
            "Exclude",
            "Exclusion",
            "Flatten",
        ],
        image: [
            "Image",
            "Bitmap",
            "Afbeelding",
            "Bild",
            "Gambar",
            "Görsel",
            "Imagem",
            "Imagen",
            "Imagine",
            "Imatge",
            "Immagine",
            "Obraz",
            "Obrázek",
            "Slika",
            "Εικόνα",
            "Зображення",
            "Изображение",
            "Слика",
            "תמונה",
            "تصویر",
            "صورة",
            "छवि",
            "图片",
            "影像",
            "画像",
            "이미지",
        ],
        text: [
            "Text",
            "Metin",
            "Teks",
            "Tekst",
            "Testo",
            "Texte",
            "Texto",
            "Κείμενο",
            "Текст",
            "טקסט",
            "متن",
            "نص",
            "पाठ",
            "テキスト",
            "文字",
            "文本",
            "텍스트",
        ],
        other: ["Layer", "Component", "Instance", "Svg", "SVG", "Untitled"],
    };

    private static readonly PATTERN = DefaultNames.buildPattern();

    /**
     * Tells whether a layer name is a default name: a base name, optionally followed by a number
     * (`Board 4`, `Rectangle-12`, `Artboard – 1`) and a copy suffix (`Frame 5 copy 2`).
     *
     * @param name - the layer name
     */
    public static isDefault(name: string | null | undefined): boolean {
        if (typeof name !== "string") {
            return true;
        }
        const trimmed = name.normalize("NFC").trim();
        return trimmed.length === 0 || DefaultNames.PATTERN.test(trimmed);
    }

    private static buildPattern(): RegExp {
        const bases = [...new Set(Object.values(DefaultNames.BASE_NAMES).flat())]
            .sort((a, b) => b.length - a.length)
            .map((base) =>
                base
                    .normalize("NFC")
                    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                    .replace(/ /g, "\\s+")
            );
        const number = "(?:[\\s_\\-–—#.]*\\d+)?";
        const copy = "(?:[\\s_\\-]*\\(?(?:copy|copia|copie|kopie|cópia)\\)?(?:[\\s_\\-]*\\d+)?)*";
        return new RegExp(`^(?:${bases.join("|")})${number}${copy}$`, "iu");
    }
}

/**
 * Formatting of names in a naming convention.
 */
export class NameFormatter {
    private static readonly MAX_LENGTH = 64;

    /**
     * Cleans a name proposed by Claude: drops quotes, control characters and extra spaces.
     *
     * @param raw - the proposed name
     * @returns the cleaned name, or null if nothing usable is left
     */
    public static clean(raw: unknown): string | null {
        if (typeof raw !== "string") {
            return null;
        }
        const cleaned = raw
            .normalize("NFC")
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, "")
            .replace(/\s+/g, " ")
            .trim();
        if (cleaned.length === 0) {
            return null;
        }
        return cleaned.length > NameFormatter.MAX_LENGTH ? cleaned.slice(0, NameFormatter.MAX_LENGTH).trim() : cleaned;
    }

    /**
     * Splits a name into words: at spaces, `-`, `_`, `/`, `.` and camelCase boundaries.
     *
     * @param name - the name
     */
    public static words(name: string): string[] {
        return name
            .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
            .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
            .split(/[^\p{L}\p{N}&+]+/u)
            .filter((word) => word.length > 0);
    }

    /**
     * Formats a name in a convention.
     *
     * @param name - a cleaned name
     * @param convention - the naming style
     */
    public static format(name: string, convention: NamingConvention): string {
        switch (convention) {
            case "kebab":
                return NameFormatter.kebab(name) || name;
            case "bem":
                return NameFormatter.bem(name) || name;
            default:
                return NameFormatter.title(name) || name;
        }
    }

    private static title(name: string): string {
        return NameFormatter.words(name)
            .map((word) =>
                /^[\p{Lu}\p{N}]{2,5}$/u.test(word) || /\p{N}/u.test(word.charAt(0))
                    ? word
                    : word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase()
            )
            .join(" ");
    }

    private static kebab(name: string): string {
        return NameFormatter.words(name)
            .map((word) => word.toLocaleLowerCase())
            .join("-");
    }

    private static bem(name: string): string {
        const match = /^(.*?)(?:__(.*?))?(?:--(.*))?$/su.exec(name.trim());
        if (!match || (match[2] === undefined && match[3] === undefined)) {
            return NameFormatter.kebab(name);
        }
        const [, block, element, modifier] = match;
        let result = NameFormatter.kebab(block);
        if (element !== undefined && NameFormatter.kebab(element)) {
            result += `__${NameFormatter.kebab(element)}`;
        }
        if (modifier !== undefined && NameFormatter.kebab(modifier)) {
            result += `--${NameFormatter.kebab(modifier)}`;
        }
        return result;
    }
}

/** Layer as described to Claude. */
interface LayerBrief {
    id: string;
    type: string;
    page?: string;
    parent?: string;
    board?: string;
    size: string;
    position?: string;
    text?: string;
    layout?: string;
    hidden?: true;
    children?: string;
}

/**
 * The auto-naming run: reading layers, choosing candidates, asking Claude, applying.
 */
export class AutoNamer {
    public static readonly DEFAULT_BATCH_SIZE = 50;
    public static readonly MAX_BATCH_SIZE = 80;
    public static readonly DEFAULT_MAX_NODES = 400;
    private static readonly SCAN_LIMIT = 20000;
    private static readonly SCREENSHOT_WIDTH = 768;
    private static readonly SCREENSHOTS_PER_BATCH = 2;
    private static readonly MAX_CHILD_ITEMS = 8;
    private static readonly TYPE_LABELS: Record<string, string> = {
        frame: "board",
        rect: "rectangle",
        circle: "ellipse",
        bool: "boolean",
        "svg-raw": "svg",
    };

    private readonly records = new Map<string, LayerRecord>();
    /** names proposed so far, used as context for later batches */
    private readonly proposed = new Map<string, string>();
    private readonly screenshots = new Map<string, Attachment | null>();

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly params: AutoNameParams
    ) {}

    /** Scope of the run. */
    public get scope(): AutoNameScope {
        return this.params.scope ?? (this.params.nodeIds && this.params.nodeIds.length > 0 ? "selection" : "page");
    }

    /** Naming convention of the run. */
    public get convention(): NamingConvention {
        const convention = this.params.convention;
        return convention === "kebab" || convention === "bem" ? convention : "title";
    }

    /**
     * Runs auto-naming.
     */
    public async run(): Promise<AutoNameResult> {
        this.validate();
        this.progress("scan", 0, 0);
        const layers = await this.readLayers();
        for (const layer of layers) {
            this.records.set(layer.id, layer);
        }
        const { candidates, skippedComponents } = AutoNamer.selectCandidates(layers, {
            includeComponents: this.params.includeComponents === true,
        });
        const maxNodes = Math.max(1, Math.floor(this.params.maxNodes ?? AutoNamer.DEFAULT_MAX_NODES));
        const ordered = this.order(candidates).slice(0, maxNodes);
        const batchSize = Math.min(
            AutoNamer.MAX_BATCH_SIZE,
            Math.max(1, Math.floor(this.params.batchSize ?? AutoNamer.DEFAULT_BATCH_SIZE))
        );

        const renames: AutoNameRename[] = [];
        this.progress("name", 0, ordered.length);
        for (let start = 0; start < ordered.length; start += batchSize) {
            this.checkAborted();
            const batch = ordered.slice(start, start + batchSize);
            const names = await this.nameBatch(batch);
            for (const layer of batch) {
                const newName = names.get(layer.id);
                if (newName && newName !== layer.name) {
                    this.proposed.set(layer.id, newName);
                    renames.push({
                        nodeId: layer.id,
                        pageId: layer.pageId,
                        type: layer.type,
                        oldName: layer.name,
                        newName,
                    });
                }
            }
            this.progress("name", Math.min(start + batch.length, ordered.length), ordered.length);
        }

        let appliedCount = 0;
        if (this.params.apply === true && renames.length > 0) {
            this.checkAborted();
            this.progress("apply", 0, renames.length);
            appliedCount = await this.applyRenames(renames);
            this.progress("apply", appliedCount, renames.length);
        }

        return {
            scope: this.scope,
            convention: this.convention,
            scanned: layers.length,
            candidates: candidates.length,
            skippedComponents,
            remaining: candidates.length - ordered.length,
            renames,
            applied: this.params.apply === true,
            appliedCount,
        };
    }

    /**
     * Picks the layers that may be renamed: default-named, not variants, and (unless
     * `includeComponents`) neither component main roots nor layers of component copies.
     *
     * @param layers - layers in scope
     * @param options - selection options
     */
    public static selectCandidates(
        layers: LayerRecord[],
        options: { includeComponents: boolean }
    ): { candidates: LayerRecord[]; skippedComponents: number } {
        const candidates: LayerRecord[] = [];
        let skippedComponents = 0;
        for (const layer of layers) {
            if (layer.variant || !DefaultNames.isDefault(layer.name)) {
                continue;
            }
            // a text layer named after its own content ("Image" saying "Image") is named
            if (layer.type === "text" && layer.text && layer.text.trim() === layer.name.trim()) {
                continue;
            }
            if (!options.includeComponents && (layer.component === "main" || layer.component === "copy")) {
                skippedComponents++;
                continue;
            }
            candidates.push(layer);
        }
        return { candidates, skippedComponents };
    }

    /**
     * Parses Claude's answer: a JSON object `{nodeId: name}` (optionally in a code fence), or an
     * array of `{id, name}`.
     *
     * @param text - Claude's answer
     * @returns the names by node id
     */
    public static parseAnswer(text: string): Map<string, string> {
        const names = new Map<string, string>();
        const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
        const body = fenced ? fenced[1] : text;
        const start = body.search(/[[{]/);
        if (start < 0) {
            return names;
        }
        const close = body[start] === "{" ? "}" : "]";
        const end = body.lastIndexOf(close);
        if (end <= start) {
            return names;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(body.slice(start, end + 1));
        } catch {
            return names;
        }
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                const id = item?.id ?? item?.nodeId;
                if (typeof id === "string" && typeof item?.name === "string") {
                    names.set(id, item.name);
                }
            }
        } else if (parsed && typeof parsed === "object") {
            const source =
                (parsed as any).names && typeof (parsed as any).names === "object" ? (parsed as any).names : parsed;
            for (const [id, name] of Object.entries(source)) {
                if (typeof name === "string") {
                    names.set(id, name);
                }
            }
        }
        return names;
    }

    /**
     * Builds the Claude prompt of one batch.
     *
     * @param batch - the layers to name
     */
    public buildPrompt(batch: LayerRecord[], screenshotBoards: string[]): string {
        const multiPage = new Set(batch.map((layer) => layer.pageId)).size > 1 || this.scope === "file";
        const briefs = batch.map((layer) => this.brief(layer, multiPage));
        const style = {
            title: 'Title Case words separated by spaces ("Primary Button")',
            kebab: 'lowercase words joined by hyphens ("primary-button")',
            bem: 'BEM: block__element--modifier in lowercase kebab-case ("card__title", "button--primary")',
        }[this.convention];
        const lines = [
            `Name these ${batch.length} layers. Naming style: ${style}.`,
            "Answer with only a JSON object that maps every layer id to its new name, nothing else.",
        ];
        if (screenshotBoards.length > 0) {
            lines.push(
                `The images show the boards ${screenshotBoards.map((name) => JSON.stringify(name)).join(", ")}, in that order.`
            );
        }
        lines.push("", "Layers (one JSON object per line):", ...briefs.map((brief) => JSON.stringify(brief)));
        return lines.join("\n");
    }

    private validate(): void {
        const scope = this.params.scope;
        if (scope !== undefined && scope !== "selection" && scope !== "page" && scope !== "file") {
            throw new Error(`Unknown scope ${JSON.stringify(scope)}`);
        }
        if (this.scope === "selection") {
            const ids = this.params.nodeIds;
            if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string")) {
                throw new Error("The selection scope needs nodeIds");
            }
        }
    }

    private async readLayers(): Promise<LayerRecord[]> {
        const params = {
            scope: this.scope,
            nodeIds: this.scope === "selection" ? this.params.nodeIds : [],
            pageId: this.params.pageId ?? this.ctx.context.pageId ?? null,
            limit: AutoNamer.SCAN_LIMIT,
        };
        const result = await this.ctx.tools.call("execute_code", { code: AutoNamer.readScript(params) });
        const data = AutoNamer.codeResult(result) as { layers?: LayerRecord[] } | null;
        if (!data || !Array.isArray(data.layers)) {
            throw new Error("Could not read the layers of the design");
        }
        return data.layers;
    }

    private async applyRenames(renames: AutoNameRename[]): Promise<number> {
        const byPage = new Map<string, [string, string, string][]>();
        for (const rename of renames) {
            const items = byPage.get(rename.pageId) ?? [];
            items.push([rename.nodeId, rename.oldName, rename.newName]);
            byPage.set(rename.pageId, items);
        }
        const groups = [...byPage.entries()].map(([pageId, items]) => ({ pageId, items }));
        const result = await this.ctx.tools.call("execute_code", { code: AutoNamer.applyScript(groups) });
        const data = AutoNamer.codeResult(result) as { applied?: number } | null;
        return typeof data?.applied === "number" ? data.applied : 0;
    }

    private async nameBatch(batch: LayerRecord[]): Promise<Map<string, string>> {
        const { attachments, boards } = await this.batchScreenshots(batch);
        this.checkAborted();
        const answer = await this.ctx.runner.run({
            prompt: this.buildPrompt(batch, boards),
            promptName: "auto-name",
            attachments,
        });
        const raw = AutoNamer.parseAnswer(answer.text);
        const names = new Map<string, string>();
        for (const layer of batch) {
            const cleaned = NameFormatter.clean(raw.get(layer.id));
            if (!cleaned) {
                continue;
            }
            const formatted = NameFormatter.format(cleaned, this.convention);
            if (!DefaultNames.isDefault(formatted)) {
                names.set(layer.id, formatted);
            }
        }
        return names;
    }

    private async batchScreenshots(batch: LayerRecord[]): Promise<{ attachments: Attachment[]; boards: string[] }> {
        const attachments: Attachment[] = [];
        const boards: string[] = [];
        if (this.params.screenshots === false) {
            return { attachments, boards };
        }
        const counts = new Map<string, number>();
        for (const layer of batch) {
            const board = this.topBoard(layer);
            if (board) {
                counts.set(board.id, (counts.get(board.id) ?? 0) + 1);
            }
        }
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, AutoNamer.SCREENSHOTS_PER_BATCH);
        for (const [boardId] of ranked) {
            const image = await this.screenshot(boardId);
            if (image) {
                attachments.push(image);
                boards.push(this.currentName(boardId));
            }
        }
        return { attachments, boards };
    }

    private async screenshot(boardId: string): Promise<Attachment | null> {
        if (this.screenshots.has(boardId)) {
            return this.screenshots.get(boardId)!;
        }
        let image: Attachment | null = null;
        const board = this.records.get(boardId);
        const scale = Math.min(1, Math.max(0.25, AutoNamer.SCREENSHOT_WIDTH / Math.max(1, board?.width ?? 1)));
        try {
            const result = await this.ctx.tools.call("capture_node_screenshot", {
                nodeId: boardId,
                scale: Math.round(scale * 100) / 100,
                format: "jpeg",
            });
            const block = result.isError
                ? undefined
                : (result.content as any[]).find((part) => part?.type === "image" && typeof part.data === "string");
            if (block) {
                image = { kind: "image", mime: block.mimeType ?? "image/jpeg", base64: block.data };
            }
        } catch {
            image = null;
        }
        this.screenshots.set(boardId, image);
        return image;
    }

    /** Orders candidates top-down (parents before children), then by page and position. */
    private order(candidates: LayerRecord[]): LayerRecord[] {
        const depth = (layer: LayerRecord): number => {
            let level = 0;
            let parentId = layer.parentId;
            const seen = new Set<string>();
            while (parentId && !seen.has(parentId)) {
                seen.add(parentId);
                level++;
                parentId = this.records.get(parentId)?.parentId ?? null;
            }
            return level;
        };
        return candidates
            .map((layer, index) => ({ layer, index, depth: depth(layer) }))
            .sort((a, b) => a.depth - b.depth || a.index - b.index)
            .map((entry) => entry.layer);
    }

    private topBoard(layer: LayerRecord): LayerRecord | null {
        let current: LayerRecord | undefined = layer;
        let top: LayerRecord | null = layer.type === "frame" ? layer : null;
        const seen = new Set<string>();
        while (current?.parentId && !seen.has(current.parentId)) {
            seen.add(current.parentId);
            current = this.records.get(current.parentId);
            if (current?.type === "frame") {
                top = current;
            }
        }
        return top;
    }

    private brief(layer: LayerRecord, multiPage: boolean): LayerBrief {
        const brief: LayerBrief = {
            id: layer.id,
            type: AutoNamer.TYPE_LABELS[layer.type] ?? layer.type,
            size: `${Math.round(layer.width)}x${Math.round(layer.height)}`,
        };
        if (multiPage) {
            brief.page = layer.pageName;
        }
        const parent = layer.parentId ? this.records.get(layer.parentId) : undefined;
        if (parent) {
            brief.parent = `${this.currentName(parent.id)} (${AutoNamer.TYPE_LABELS[parent.type] ?? parent.type})`;
        }
        const board = this.topBoard(layer);
        if (board && board.id !== layer.id) {
            brief.board = this.currentName(board.id);
            brief.position = `${Math.round(layer.x - board.x)},${Math.round(layer.y - board.y)}`;
        }
        if (layer.text) {
            brief.text = layer.text;
        }
        if (layer.layout) {
            brief.layout = layer.layout;
        }
        if (!layer.visible) {
            brief.hidden = true;
        }
        const children = this.childSummary(layer);
        if (children) {
            brief.children = children;
        }
        return brief;
    }

    private childSummary(layer: LayerRecord): string | undefined {
        const children = layer.children
            .map((id) => this.records.get(id))
            .filter((child): child is LayerRecord => !!child);
        if (children.length === 0) {
            return undefined;
        }
        const items = children.slice(0, AutoNamer.MAX_CHILD_ITEMS).map((child) => {
            const type = AutoNamer.TYPE_LABELS[child.type] ?? child.type;
            if (child.text) {
                return `${type} ${JSON.stringify(child.text.slice(0, 40))}`;
            }
            const name = this.currentName(child.id);
            return DefaultNames.isDefault(name) ? type : `${type} ${JSON.stringify(name)}`;
        });
        if (children.length > AutoNamer.MAX_CHILD_ITEMS) {
            items.push(`${children.length - AutoNamer.MAX_CHILD_ITEMS} more`);
        }
        return items.join(", ");
    }

    private currentName(id: string): string {
        return this.proposed.get(id) ?? this.records.get(id)?.name ?? id;
    }

    private progress(stage: "scan" | "name" | "apply", done: number, total: number): void {
        this.ctx.emit("progress", { stage, done, total });
    }

    private checkAborted(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }

    /**
     * Gets the value returned by `execute_code` code from the tool result.
     */
    private static codeResult(result: WorkflowToolResult): unknown {
        if (result.isError) {
            throw new Error(result.text || "execute_code failed");
        }
        let parsed: any;
        try {
            parsed = JSON.parse(result.text);
        } catch {
            throw new Error(`Unexpected execute_code output: ${result.text.slice(0, 200)}`);
        }
        return parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
    }

    /**
     * Plugin code reading the layers of a scope (runs in the browser through `execute_code`).
     */
    public static readScript(params: {
        scope: AutoNameScope;
        nodeIds?: string[];
        pageId: string | null;
        limit: number;
    }): string {
        return `
const P = ${JSON.stringify(params)};
const ZERO = "00000000-0000-0000-0000-000000000000";
const file = penpot.currentFile;
if (!file) { throw new Error("No Penpot file is open"); }
const safe = (fn, fallback) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } };
const pages = file.pages;
let roots = [];
if (P.scope === "file") {
  roots = pages.map((page) => ({ page, shapes: [page.root] }));
} else if (P.scope === "page") {
  const page = pages.find((p) => p.id === P.pageId) || penpot.currentPage;
  if (!page) { throw new Error("Page not found"); }
  roots = [{ page, shapes: [page.root] }];
} else {
  const current = penpot.currentPage;
  const ordered = current ? [current, ...pages.filter((p) => p.id !== current.id)] : pages;
  const byPage = new Map();
  for (const id of P.nodeIds) {
    for (const page of ordered) {
      const shape = page.getShapeById(id);
      if (shape) {
        if (!byPage.has(page.id)) { byPage.set(page.id, { page, shapes: [] }); }
        byPage.get(page.id).shapes.push(shape);
        break;
      }
    }
  }
  roots = [...byPage.values()];
}
const layers = [];
const seen = new Set();
const visit = (shape, page) => {
  if (!shape || seen.has(shape.id) || layers.length >= P.limit) { return; }
  seen.add(shape.id);
  const children = safe(() => shape.children, []) || [];
  if (shape.id !== ZERO) {
    const parent = safe(() => shape.parent, null);
    const copy = safe(() => shape.isComponentCopyInstance(), false);
    const main = safe(() => shape.isComponentMainInstance(), false);
    const head = safe(() => shape.isComponentHead(), false);
    const variant = safe(() => shape.isVariantContainer(), false) || safe(() => shape.isVariantHead(), false);
    const flex = shape.type === "board" ? safe(() => shape.flex, null) : null;
    const grid = shape.type === "board" ? safe(() => shape.grid, null) : null;
    const type = ({ board: "frame", rectangle: "rect", ellipse: "circle", boolean: "bool" })[shape.type] || shape.type;
    layers.push({
      id: shape.id,
      pageId: page.id,
      pageName: page.name,
      name: shape.name,
      type,
      parentId: parent && parent.id !== ZERO ? parent.id : null,
      x: Math.round(safe(() => shape.x, 0)),
      y: Math.round(safe(() => shape.y, 0)),
      width: Math.round(safe(() => shape.width, 0)),
      height: Math.round(safe(() => shape.height, 0)),
      visible: safe(() => shape.visible, true) !== false,
      text: shape.type === "text" ? String(safe(() => shape.characters, "")).slice(0, 120) : undefined,
      component: copy ? "copy" : (main && head ? "main" : (main ? "main-child" : null)),
      variant: !!variant,
      layout: flex ? "flex-" + flex.dir : (grid ? "grid" : null),
      children: children.map((child) => child.id),
    });
  }
  for (const child of children) { visit(child, page); }
};
for (const { page, shapes } of roots) {
  for (const shape of shapes) { visit(shape, page); }
}
return { layers };
`;
    }

    /**
     * Plugin code applying renames, one undo block per page, then going back to the page the user
     * was on. A layer is renamed only if it still has the name it had when it was read.
     */
    public static applyScript(groups: { pageId: string; items: [string, string, string][] }[]): string {
        return `
const G = ${JSON.stringify(groups)};
const file = penpot.currentFile;
if (!file) { throw new Error("No Penpot file is open"); }
const original = penpot.currentPage;
let applied = 0;
const skipped = [];
for (const group of G) {
  const page = file.pages.find((p) => p.id === group.pageId);
  if (!page) { skipped.push(...group.items.map((item) => item[0])); continue; }
  if (!penpot.currentPage || penpot.currentPage.id !== page.id) { await penpot.openPage(page); }
  const active = penpot.currentPage || page;
  const block = penpot.history.undoBlockBegin();
  try {
    for (const [id, oldName, newName] of group.items) {
      const shape = active.getShapeById(id);
      if (shape && shape.name === oldName) { shape.name = newName; applied++; } else { skipped.push(id); }
    }
  } finally {
    penpot.history.undoBlockFinish(block);
  }
}
if (original && penpot.currentPage && penpot.currentPage.id !== original.id) { await penpot.openPage(original); }
return { applied, skipped };
`;
    }
}

/**
 * Runs auto-naming with a workflow context. Reusable entry point for other workflows (W17 calls it
 * with `apply: true`).
 *
 * @param ctx - the workflow context
 * @param params - the run params
 */
export async function autoName(ctx: WorkflowContext, params: AutoNameParams = {}): Promise<AutoNameResult> {
    return new AutoNamer(ctx, params ?? {}).run();
}

/**
 * Summary line of a run, for `workflow.done`.
 */
export function describeResult(result: AutoNameResult): string {
    if (result.candidates === 0) {
        return "No layers with default names found";
    }
    const verb = result.applied ? `Renamed ${result.appliedCount}` : `Suggested names for ${result.renames.length}`;
    const more = result.remaining > 0 ? `; ${result.remaining} more left for another run` : "";
    return `${verb} of ${result.candidates} default-named layers${more}`;
}

/** The `auto-name` workflow. */
export const workflow: Workflow<AutoNameParams> = {
    name: "auto-name",
    description: 'Give layers with default names ("Board 4", "Rectangle 12") meaningful names.',
    run: async (ctx, params) => {
        const result = await autoName(ctx, params ?? {});
        ctx.emit("result", result);
        return { summary: describeResult(result) };
    },
};
