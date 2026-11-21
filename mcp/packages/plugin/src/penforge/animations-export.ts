import type { Page, Shape } from "@penpot/plugin-types";
import { AnimationReader } from "./animations.ts";
import type { AnimatedLayer } from "./animations.ts";
import type { NodeLocator } from "./locate.ts";
import type { JsonObject } from "./serialize.ts";

/**
 * Reads the animation specs (W31) of a file for the `get_animations` and `get_animation_spec`
 * tools: animated layers with their screen (top-level board), resolved smart animate links and
 * hints for code (identifier names, component).
 */
export class AnimationExporter {
    /** Version of the `get_animation_spec` document (architecture §6). */
    public static readonly SPEC_VERSION = 1;

    private readonly locator: NodeLocator;

    /**
     * @param locator - finds pages and shapes of the current file
     */
    constructor(locator: NodeLocator) {
        this.locator = locator;
    }

    /**
     * Animated layers of some nodes (and what is inside them), of one board, or of a whole page.
     *
     * @param params - `nodeIds`, else `boardId`, else `pageId` (the current page by default)
     * @param currentPage - the page used when nothing else is given
     */
    public layers(
        params: { nodeIds?: string[]; boardId?: string; pageId?: string },
        currentPage: Page | null
    ): JsonObject {
        if (params.nodeIds && params.nodeIds.length > 0) {
            const seen = new Set<string>();
            const layers: JsonObject[] = [];
            for (const nodeId of params.nodeIds) {
                const located = this.locator.require(nodeId);
                for (const layer of this.layersUnder(located.page, located.shape)) {
                    if (!seen.has(layer.nodeId as string)) {
                        seen.add(layer.nodeId as string);
                        layers.push(layer);
                    }
                }
            }
            return { layers, count: layers.length };
        }
        if (params.boardId) {
            const located = this.locator.require(params.boardId);
            const layers = this.layersUnder(located.page, located.shape);
            return { pageId: located.page.id, layers, count: layers.length };
        }
        const page = params.pageId ? this.locator.page(params.pageId) : currentPage;
        if (!page) {
            throw new Error("No page is open");
        }
        const layers = AnimationExporter.topLevel(page).flatMap((top) =>
            AnimationExporter.describe(page, top, AnimationReader.collect(top))
        );
        return { pageId: page.id, layers, count: layers.length };
    }

    /**
     * The animation spec of the whole file for the build (W35): every page with its screens and
     * their animated layers, in file and layer order. Pages and screens without animations are
     * left out.
     *
     * @param file - id and name of the current file
     */
    public spec(file: { id: string | null; name: string | null }): JsonObject {
        const pages: JsonObject[] = [];
        let layerCount = 0;
        for (const page of this.locator.pages()) {
            const boards: JsonObject[] = [];
            const otherLayers: JsonObject[] = [];
            for (const top of AnimationExporter.topLevel(page)) {
                const layers = AnimationExporter.describe(page, top, AnimationReader.collect(top)).map((layer) => {
                    const { pageId: _pageId, boardId: _boardId, boardName: _boardName, ...rest } = layer;
                    return rest;
                });
                if (layers.length === 0) {
                    continue;
                }
                layerCount += layers.length;
                if (top.type === "board") {
                    boards.push({
                        boardId: top.id,
                        boardName: top.name,
                        componentName: AnimationExporter.pascalCase(top.name),
                        layers,
                    });
                } else {
                    otherLayers.push(...layers);
                }
            }
            if (boards.length > 0 || otherLayers.length > 0) {
                pages.push({ pageId: page.id, pageName: page.name, boards, otherLayers });
            }
        }
        return {
            version: AnimationExporter.SPEC_VERSION,
            fileId: file.id,
            fileName: file.name,
            layerCount,
            pages,
        };
    }

    /** Animated layers of `node` and its descendants, described with their screen. */
    private layersUnder(page: Page, node: Shape): JsonObject[] {
        const top = AnimationExporter.topLevelOf(node);
        const inside = new Set<string>();
        const walk = (shape: Shape): void => {
            inside.add(shape.id);
            for (const child of AnimationExporter.children(shape)) {
                walk(child);
            }
        };
        walk(node);
        const layers = AnimationReader.collect(top).filter((layer) => inside.has(layer.nodeId));
        return AnimationExporter.describe(page, top, layers);
    }

    /** Layers as the tools return them; `top` is the top-level shape that holds them. */
    private static describe(page: Page, top: Shape, layers: AnimatedLayer[]): JsonObject[] {
        const board = top.type === "board" ? top : null;
        return layers.map((layer) => {
            const shape = page.getShapeById(layer.nodeId);
            const out: JsonObject = {
                nodeId: layer.nodeId,
                name: layer.name,
                type: layer.type,
                path: layer.path,
                parentId: layer.parentId,
                pageId: page.id,
                boardId: board ? board.id : null,
                boardName: board ? board.name : null,
                codeName: AnimationExporter.camelCase(layer.name),
                component: shape ? AnimationExporter.component(shape) : null,
                childCount: shape ? AnimationExporter.children(shape).length : 0,
                animations: layer.animations as unknown as JsonObject,
            };
            if (shape && layer.animations.smart && layer.animations.smart.length > 0) {
                out.smart = AnimationExporter.smartLinks(
                    shape,
                    layer.animations.smart.map((s) => s.index)
                );
            }
            return out;
        });
    }

    /** Smart animate entries that still match their interaction, with the destination resolved. */
    private static smartLinks(shape: Shape, indexes: number[]): JsonObject[] {
        const links: JsonObject[] = [];
        for (const index of indexes) {
            const entry = AnimationReader.smartFor(shape, index);
            const interaction: any = (shape.interactions ?? [])[index];
            const destination = interaction?.action?.destination;
            if (!entry || !destination) {
                continue;
            }
            const link: JsonObject = {
                index,
                trigger: interaction.trigger ?? null,
                actionType: interaction.action?.type ?? null,
                destinationId: destination.id,
                destinationName: destination.name ?? null,
            };
            if (entry.duration !== undefined) {
                link.duration = entry.duration;
            }
            if (entry.easing !== undefined) {
                link.easing = entry.easing as unknown as JsonObject;
            }
            links.push(link);
        }
        return links;
    }

    /** Main component of an instance (or of a main), as `{id, name}`. */
    private static component(shape: Shape): JsonObject | null {
        try {
            const component: any = typeof (shape as any).component === "function" ? (shape as any).component() : null;
            return component ? { id: component.id ?? null, name: component.name ?? null } : null;
        } catch {
            return null;
        }
    }

    private static topLevel(page: Page): Shape[] {
        const root: any = page.root;
        return root && Array.isArray(root.children) ? root.children : [];
    }

    /** The top-level shape (child of the page root) that holds `shape`. */
    private static topLevelOf(shape: Shape): Shape {
        let current: any = shape;
        while (current.parent && current.parent.parent) {
            current = current.parent;
        }
        return current;
    }

    private static children(shape: Shape): Shape[] {
        const children = (shape as any).children;
        return Array.isArray(children) ? children : [];
    }

    private static words(name: string): string[] {
        return name
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .split(/[^A-Za-z0-9]+/)
            .filter((word) => word.length > 0);
    }

    /**
     * Identifier hint for a layer: "Sign In Button" → "signInButton"; `layer` when the name has no
     * letters or digits; a leading digit gets a `layer` prefix.
     */
    public static camelCase(name: string): string {
        const words = AnimationExporter.words(name);
        if (words.length === 0) {
            return "layer";
        }
        const joined = words
            .map((word, i) =>
                i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
            )
            .join("");
        return /^[0-9]/.test(joined) ? `layer${joined}` : joined;
    }

    /**
     * Component name hint for a screen: "order summary" → "OrderSummary"; `Screen` when the name
     * has no letters or digits; a leading digit gets a `Screen` prefix.
     */
    public static pascalCase(name: string): string {
        const words = AnimationExporter.words(name);
        if (words.length === 0) {
            return "Screen";
        }
        const joined = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");
        return /^[0-9]/.test(joined) ? `Screen${joined}` : joined;
    }
}
