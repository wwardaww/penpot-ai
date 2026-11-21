import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { ConformanceChecker } from "./ConformanceChecker";
import type { MissingItem, MissingKind } from "./types";

/** `.penforge/design-system-missing.json`. */
interface MissingFile {
    version: 1;
    /** the design system the list was made for (a switch starts a new list) */
    systemFileId: string;
    items: MissingItem[];
}

/** An item as the AI reports it (`penforge_design_system {action:"missing"}`). */
export interface ReportedItem {
    name: string;
    kind?: MissingKind;
    reason: string;
    componentId?: string;
    layerIds?: string[];
}

const KINDS: MissingKind[] = ["component", "color", "typography", "token", "icon"];

/**
 * The project's list of things its design system lacks (W30). The AI reports them while it
 * designs, the check adds the project's own components that have no system twin; the user then
 * decides once for all open items: "Add to design system" or "Don't add" (kept: the check leaves
 * them alone from then on).
 */
export class MissingItems {
    public static readonly FILE = "design-system-missing.json";
    /** Most items kept in the list. */
    public static readonly MAX_ITEMS = 100;

    constructor(
        private readonly workspace: WorkflowWorkspaceApi,
        private readonly systemFileId: string
    ) {}

    /** All items of the current design system. */
    public async all(): Promise<MissingItem[]> {
        const file = await this.workspace.readJson<MissingFile | null>(MissingItems.FILE, null);
        if (!file || file.systemFileId !== this.systemFileId || !Array.isArray(file.items)) {
            return [];
        }
        return file.items;
    }

    /** Items still waiting for the user's decision. */
    public async open(): Promise<MissingItem[]> {
        return (await this.all()).filter((item) => item.status === "open");
    }

    /** Local components the user chose to keep. */
    public async keptComponentIds(): Promise<Set<string>> {
        return new Set(
            (await this.all())
                .filter((item) => item.status === "kept" && item.componentId)
                .map((item) => item.componentId as string)
        );
    }

    /**
     * Adds items; one already listed under the same id keeps its status (a kept item stays kept)
     * and gets the newer reason when the AI wrote it.
     *
     * @returns the items that are new or open after the merge, in the order given
     */
    public async merge(incoming: MissingItem[]): Promise<MissingItem[]> {
        const items = await this.all();
        const byId = new Map(items.map((item) => [item.id, item]));
        const touched: MissingItem[] = [];
        for (const item of incoming) {
            const existing = byId.get(item.id);
            if (existing) {
                if (item.source === "ai" || existing.source === "check") {
                    existing.reason = item.reason || existing.reason;
                }
                existing.componentId ??= item.componentId;
                existing.layerIds = [...new Set([...(existing.layerIds ?? []), ...(item.layerIds ?? [])])].slice(0, 50);
                if (existing.status === "open") {
                    touched.push(existing);
                }
            } else {
                byId.set(item.id, item);
                items.push(item);
                touched.push(item);
            }
        }
        await this.save(items.slice(-MissingItems.MAX_ITEMS));
        return touched;
    }

    /** Sets the status of items (`kept`, `adding`, `added`, back to `open`). */
    public async setStatus(
        ids: string[],
        status: MissingItem["status"],
        extra: Record<string, Partial<MissingItem>> = {}
    ): Promise<MissingItem[]> {
        const wanted = new Set(ids);
        const items = await this.all();
        const changed: MissingItem[] = [];
        for (const item of items) {
            if (wanted.has(item.id)) {
                Object.assign(item, extra[item.id] ?? {}, { status });
                changed.push(item);
            }
        }
        await this.save(items);
        return changed;
    }

    /**
     * Items from the AI's report: names trimmed, kinds checked, ids derived from kind and name.
     */
    public static fromReport(reported: ReportedItem[], now: string): MissingItem[] {
        return reported
            .filter((item) => typeof item?.name === "string" && item.name.trim().length > 0)
            .slice(0, 30)
            .map((item) => {
                const kind = KINDS.includes(item.kind as MissingKind) ? (item.kind as MissingKind) : "component";
                const name = item.name.trim().slice(0, 80);
                return {
                    id: ConformanceChecker.missingId(kind, name),
                    kind,
                    name,
                    reason: String(item.reason ?? "")
                        .trim()
                        .slice(0, 300),
                    componentId: typeof item.componentId === "string" ? item.componentId : undefined,
                    layerIds: Array.isArray(item.layerIds)
                        ? item.layerIds.filter((id) => typeof id === "string").slice(0, 50)
                        : [],
                    status: "open" as const,
                    source: "ai" as const,
                    reportedAt: now,
                };
            });
    }

    private async save(items: MissingItem[]): Promise<void> {
        const file: MissingFile = { version: 1, systemFileId: this.systemFileId, items };
        await this.workspace.writeJson(MissingItems.FILE, file);
    }
}
