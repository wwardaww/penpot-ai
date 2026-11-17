import type { Page, Penpot, Shape } from "@penpot/plugin-types";

/**
 * A shape together with the page that contains it.
 */
export class LocatedNode {
    public readonly shape: Shape;
    public readonly page: Page;

    constructor(shape: Shape, page: Page) {
        this.shape = shape;
        this.page = page;
    }
}

/**
 * Finds shapes and pages of the current file by id, and activates pages before writes.
 */
export class NodeLocator {
    private readonly penpot: Penpot;

    /**
     * @param penpotApi - the Penpot plugin API object
     */
    constructor(penpotApi: Penpot) {
        this.penpot = penpotApi;
    }

    /**
     * Returns the pages of the current file.
     */
    public pages(): Page[] {
        const file = this.penpot.currentFile;
        if (!file) {
            throw new Error("No Penpot file is open");
        }
        return file.pages;
    }

    /**
     * Returns the page with the given id.
     *
     * @param pageId - the page id
     */
    public page(pageId: string): Page {
        const page = this.pages().find((p) => p.id === pageId);
        if (!page) {
            throw new Error(`Page not found: ${pageId}`);
        }
        return page;
    }

    /**
     * Finds a shape by id on any page of the current file, current page first.
     *
     * @param nodeId - the shape id
     */
    public find(nodeId: string): LocatedNode | null {
        const current = this.penpot.currentPage;
        const pages = this.pages();
        const ordered = current ? [current, ...pages.filter((p) => p.id !== current.id)] : pages;
        for (const page of ordered) {
            const shape = page.getShapeById(nodeId);
            if (shape) {
                return new LocatedNode(shape, page);
            }
        }
        return null;
    }

    /**
     * Finds a shape by id or throws a descriptive error.
     *
     * @param nodeId - the shape id
     */
    public require(nodeId: string): LocatedNode {
        const located = this.find(nodeId);
        if (!located) {
            throw new Error(`Node not found in the current file: ${nodeId}`);
        }
        return located;
    }

    /**
     * Makes the page of the given node the active page (writes only work on the active page) and
     * returns the node as seen from that page.
     *
     * @param nodeId - the shape id
     */
    public async requireOnActivePage(nodeId: string): Promise<LocatedNode> {
        const located = this.require(nodeId);
        if (this.penpot.currentPage?.id !== located.page.id) {
            await this.penpot.openPage(located.page);
        }
        const page = this.penpot.currentPage ?? located.page;
        const shape = page.getShapeById(nodeId) ?? located.shape;
        return new LocatedNode(shape, page);
    }
}
