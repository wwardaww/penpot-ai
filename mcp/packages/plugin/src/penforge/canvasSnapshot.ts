/**
 * Shapes of the open page at one moment, to tell later which shapes a script added.
 */
export class CanvasSnapshot {
    /**
     * Most shapes listed; above it only the top-level shapes are compared, so that a script does not
     * wait for a huge page to be read.
     */
    private static readonly MAX_SHAPES = 500;

    private readonly pageId: string | undefined;
    private readonly ids: ReadonlySet<string>;
    private readonly complete: boolean;

    private constructor(pageId: string | undefined, ids: ReadonlySet<string>, complete: boolean) {
        this.pageId = pageId;
        this.ids = ids;
        this.complete = complete;
    }

    /**
     * Lists the shapes of the open page.
     *
     * @param penpotApi - the Penpot plugin API object
     */
    public static take(penpotApi: any): CanvasSnapshot {
        const ids = new Set<string>();
        const complete = CanvasSnapshot.collect(CanvasSnapshot.children(penpotApi.root), ids);
        return new CanvasSnapshot(penpotApi.currentPage?.id, ids, complete);
    }

    /**
     * Finds the shapes added since, without those inside another added shape. A shape that only moved
     * is not added; after a change of page nothing is known.
     *
     * @param penpotApi - the Penpot plugin API object
     */
    public added(penpotApi: any): any[] {
        if (penpotApi.currentPage?.id !== this.pageId) {
            return [];
        }
        const found: any[] = [];
        const walk = (shapes: any[]) => {
            for (const shape of shapes) {
                if (!this.ids.has(shape.id)) {
                    found.push(shape);
                } else if (this.complete) {
                    walk(CanvasSnapshot.children(shape));
                }
            }
        };
        walk(CanvasSnapshot.children(penpotApi.root));
        return found;
    }

    /** Adds the ids level by level; false when it stopped at the limit. */
    private static collect(top: any[], ids: Set<string>): boolean {
        let level = top;
        while (level.length > 0) {
            level.forEach((shape) => ids.add(shape.id));
            if (ids.size > CanvasSnapshot.MAX_SHAPES) {
                top.forEach((shape) => ids.add(shape.id));
                return false;
            }
            level = level.flatMap((shape) => CanvasSnapshot.children(shape));
        }
        return true;
    }

    private static children(shape: any): any[] {
        return shape && "children" in shape && shape.children ? [...shape.children] : [];
    }
}
