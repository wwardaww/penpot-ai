import type { SourceMap } from "../extract/SourceMap";
import type { Fix, FixOp, RawLayer, SystemCatalog } from "./types";

/**
 * Fixes that link a project to the design system made from it (W36 `source-map.json`): copies
 * and mains of the project's components become the system's (kept components have the same id
 * in both files), the repeated layers the extraction turned into components become instances, and
 * fills that used the project's library colors use the system's. 1:1, no guessing; values follow
 * through the normal check afterwards.
 */
export function sourceMapFixes(map: SourceMap, layers: RawLayer[], catalog: SystemCatalog, fileId: string): Fix[] {
    const systemComponents = new Set(catalog.components.map((component) => component.id));
    const systemColors = new Set(catalog.colors.map((color) => color.id));
    const byId = new Map(layers.map((layer) => [layer.id, layer]));
    const replaced = new Set<string>();
    const fixes: Fix[] = [];
    const under = (layer: RawLayer): boolean => {
        let parentId = layer.parentId;
        for (let guard = 0; parentId && guard < 200; guard++) {
            if (replaced.has(parentId)) {
                return true;
            }
            parentId = byId.get(parentId)?.parentId ?? null;
        }
        return false;
    };
    const fix = (layer: RawLayer, code: Fix["code"], name: string, text: string, ops: FixOp[]): Fix => ({
        code,
        pageId: layer.pageId,
        layerId: layer.id,
        layerName: layer.name,
        boardName: layer.boardName,
        params: { layer: layer.name, board: layer.boardName, name },
        text,
        ops,
        quiet: false,
    });

    for (const layer of layers) {
        if (under(layer) || layer.topLevel) {
            continue;
        }
        const link = layer.component;
        const own = link && (link.libraryId === null || link.libraryId === fileId);
        if (link && own && (link.copy || link.main) && !(layer.insideCopy && !link.copy)) {
            const entry = map.components[link.id];
            if (entry?.componentId && systemComponents.has(entry.componentId)) {
                const op: FixOp = link.copy
                    ? { op: "swap", layerId: layer.id, componentId: entry.componentId }
                    : { op: "replace", layerId: layer.id, componentId: entry.componentId };
                fixes.push(
                    fix(
                        layer,
                        link.copy ? "swap" : "component",
                        entry.name,
                        `"${layer.name}" now uses the system's "${entry.name}".`,
                        [op]
                    )
                );
                if (op.op === "replace") {
                    replaced.add(layer.id);
                }
                continue;
            }
        }
        const drawn = map.layers[layer.id];
        if (drawn && systemComponents.has(drawn.componentId) && !layer.insideCopy) {
            fixes.push(
                fix(
                    layer,
                    "component",
                    drawn.name,
                    `"${layer.name}" now is an instance of the system's "${drawn.name}".`,
                    [{ op: "replace", layerId: layer.id, componentId: drawn.componentId }]
                )
            );
            replaced.add(layer.id);
            continue;
        }
        if (layer.insideCopy) {
            continue;
        }
        for (const [kind, paints] of [
            ["fill", layer.fills],
            ["stroke", layer.strokes],
        ] as const) {
            for (const paint of paints) {
                const entry = paint.refId && paint.refFile !== catalog.libraryId ? map.colors[paint.refId] : undefined;
                if (entry?.colorId && systemColors.has(entry.colorId)) {
                    const color = catalog.colors.find((c) => c.id === entry.colorId)!;
                    fixes.push({
                        ...fix(
                            layer,
                            "color-linked",
                            color.name,
                            `"${layer.name}" now uses the system color ${color.name}.`,
                            [
                                {
                                    op: kind,
                                    layerId: layer.id,
                                    index: paint.index,
                                    colorId: color.id,
                                    token: entry.token,
                                    hex: color.hex,
                                },
                            ]
                        ),
                        quiet: true,
                    });
                }
            }
        }
    }
    return fixes;
}
