import { z } from "zod";
import type { WorkflowContext } from "@penpot/mcp-common";
import { DesignStateReader } from "../changes/DesignStateReader";
import { LinkedToolFilter } from "./LinkedToolFilter";
import { RedesignScreens, type ScreenBoard } from "./RedesignScreens";

/**
 * Kind of something the design has and the app does not: `component` has UI state only (menu,
 * drawer, tabs, accordion, modal, carousel, tooltip), `feature` needs data, an API, routes, business
 * logic, storage or sign-in.
 */
export type GapKind = "component" | "feature";

/** Something the design has and the app does not. */
export interface DesignGap {
    /** stable name of the item between runs, `[a-z0-9-]+` */
    key: string;
    name: string;
    kind: GapKind;
    /** names of the boards that show it */
    screens: string[];
    /** what it is */
    what: string;
    /** why it is not just a restyle */
    why: string;
}

/** The user's decision about an item, kept in `redesign.json`. */
export interface RedesignDecision extends DesignGap {
    /** Penpot file the item belongs to */
    fileId: string;
    /** build it (true) or leave it out */
    build: boolean;
    /** files that implement it, as the runs reported them */
    files: string[];
    decidedAt: string;
}

/** Item of the checklist the user decides before a run. */
export interface ChecklistItem extends DesignGap {
    /** state of the checkbox: the earlier decision, else on for components and off for features */
    checked: boolean;
    /** decided in an earlier run */
    decided: boolean;
}

/** Checklist of a Re-Design plan. */
export type Checklist = { state: "ready"; items: ChecklistItem[] } | { state: "failed"; message: string };

/** Cached comparison: valid for the design revision and the app's commit it was made from. */
interface GapCache {
    fileId: string;
    root: string;
    head: string;
    revn: number;
    items: DesignGap[];
}

/** Git facts of the app folder at plan time. */
export interface GapsGitState {
    head: string | null;
    dirty: boolean;
}

/**
 * Comparison of the design with the app before a Re-Design (W35): one read-only Claude turn lists
 * what the boards have and the app does not, and the user decides every item before code is written.
 */
export class DesignGaps {
    /** last plan's items, read by the run that follows it */
    public static readonly PLAN_FILE = "redesign-gaps.json";
    private static readonly MAX_ITEMS = 40;

    private static readonly ReplySchema = z.object({
        items: z
            .array(
                z.object({
                    key: z.string().max(200).default(""),
                    name: z.string().min(1).max(200),
                    kind: z.string().max(40).default("feature"),
                    screens: z.array(z.string().max(200)).max(60).default([]),
                    what: z.string().max(1000).default(""),
                    why: z.string().max(1000).default(""),
                })
            )
            .max(200),
    });

    /**
     * @param ctx - the workflow context
     * @param root - the linked app folder
     */
    constructor(
        private readonly ctx: WorkflowContext,
        private readonly root: string
    ) {}

    /**
     * Makes the checklist of a plan. Never guesses: a comparison that fails gives `failed`.
     *
     * @param screens - screen boards of the design
     * @param decisions - earlier decisions of this Penpot file
     * @param git - git facts of the app folder
     */
    public async checklist(
        screens: ScreenBoard[],
        decisions: RedesignDecision[],
        git: GapsGitState
    ): Promise<Checklist> {
        let items: DesignGap[];
        try {
            items = (await this.cached(git)) ?? (await this.compare(screens, decisions, git));
        } catch (error) {
            if (this.ctx.signal.aborted) {
                throw error;
            }
            return { state: "failed", message: error instanceof Error ? error.message : String(error) };
        }
        return { state: "ready", items: DesignGaps.merge(items, decisions) };
    }

    /**
     * Gets the items the last plan showed for this file and folder.
     */
    public async planned(): Promise<DesignGap[]> {
        const cache = await this.readCache();
        return cache?.items ?? [];
    }

    /**
     * Joins the comparison with the earlier decisions: new items first, then the decided ones.
     *
     * @param items - items of the comparison
     * @param decisions - earlier decisions of the file
     */
    public static merge(items: DesignGap[], decisions: RedesignDecision[]): ChecklistItem[] {
        const decided = new Map(decisions.map((decision) => [decision.key, decision]));
        const fresh = items
            .filter((item) => !decided.has(item.key))
            .map((item) => ({ ...item, checked: item.kind === "component", decided: false }));
        const known = decisions.map((decision) => {
            const { key, name, kind, screens, what, why } = items.find((item) => item.key === decision.key) ?? decision;
            return { key, name, kind, screens, what, why, checked: decision.build, decided: true };
        });
        return [...fresh, ...known];
    }

    /** Runs the comparison turn. */
    private async compare(
        screens: ScreenBoard[],
        decisions: RedesignDecision[],
        git: GapsGitState
    ): Promise<DesignGap[]> {
        const toolFilter = new LinkedToolFilter(
            this.ctx.workspace.root,
            [this.root, this.ctx.workspace.root],
            null,
            true
        );
        const request = { promptName: "code-redesign-gaps", toolFilter };
        let answer = await this.ctx.runner.run({ ...request, prompt: this.prompt(screens, decisions) });
        let reply = DesignGaps.parse(answer.text);
        if (reply === null && !this.ctx.signal.aborted) {
            answer = await this.ctx.runner.run({
                ...request,
                prompt:
                    "Your answer did not end with a valid ```json block in the required shape. " +
                    "Answer again with only that block.",
                resumeSessionId: answer.sessionId,
            });
            reply = DesignGaps.parse(answer.text);
        }
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
        if (reply === null) {
            throw new Error("The comparison of the design with the app gave no valid list");
        }
        const items = DesignGaps.items(reply, screens);
        await this.ctx.workspace.writeJson(DesignGaps.PLAN_FILE, {
            fileId: this.ctx.context.fileId,
            root: this.root,
            head: git.dirty ? "" : (git.head ?? ""),
            revn: (await this.revn()) ?? -1,
            items,
        } satisfies GapCache);
        return items;
    }

    private prompt(screens: ScreenBoard[], decisions: RedesignDecision[]): string {
        const lines = [
            `Compare the Penpot design with the app in \`${this.root}\` and list what the design has and the app does not.`,
            "",
            "Screens (Penpot boards):",
            ...screens.map(
                (screen) => `- "${screen.name}" (boardId ${screen.boardId}, ${screen.width}×${screen.height})`
            ),
        ];
        if (decisions.length > 0) {
            lines.push(
                "",
                "Items the user already decided. When you find the same thing, use the same `key`:",
                ...decisions.map((item) => `- \`${item.key}\`: ${item.name} (${item.kind}). ${item.what}`)
            );
        }
        return lines.join("\n");
    }

    /** Items of the last comparison when neither the design nor the app changed since. */
    private async cached(git: GapsGitState): Promise<DesignGap[] | null> {
        const cache = await this.readCache();
        if (cache === null || git.dirty || git.head === null || cache.head !== git.head || cache.revn < 0) {
            return null;
        }
        return (await this.revn()) === cache.revn ? cache.items : null;
    }

    private async readCache(): Promise<GapCache | null> {
        const cache = await this.ctx.workspace
            .readJson<Partial<GapCache> | null>(DesignGaps.PLAN_FILE, null)
            .catch(() => null);
        if (
            cache === null ||
            typeof cache !== "object" ||
            cache.fileId !== this.ctx.context.fileId ||
            cache.root !== this.root ||
            !Array.isArray(cache.items)
        ) {
            return null;
        }
        return {
            fileId: cache.fileId,
            root: cache.root,
            head: typeof cache.head === "string" ? cache.head : "",
            revn: typeof cache.revn === "number" ? cache.revn : -1,
            items: cache.items.filter((item) => DesignGaps.isGap(item)),
        };
    }

    private async revn(): Promise<number | null> {
        return new DesignStateReader(this.ctx.tools).readRevn(this.ctx.context.fileId).catch(() => null);
    }

    private static parse(text: string): z.infer<typeof DesignGaps.ReplySchema> | null {
        const parsed = DesignGaps.ReplySchema.safeParse(RedesignScreens.lastJson(text));
        return parsed.success ? parsed.data : null;
    }

    /** Cleans the reply: known screens only, unique keys, features when the kind is not clear. */
    private static items(reply: z.infer<typeof DesignGaps.ReplySchema>, screens: ScreenBoard[]): DesignGap[] {
        const names = new Set(screens.map((screen) => screen.name));
        const keys = new Set<string>();
        const items: DesignGap[] = [];
        for (const item of reply.items.slice(0, DesignGaps.MAX_ITEMS)) {
            const key = DesignGaps.slug(item.key) || DesignGaps.slug(item.name) || `item-${items.length + 1}`;
            if (keys.has(key)) {
                continue;
            }
            keys.add(key);
            items.push({
                key,
                name: item.name.trim(),
                // only a clear "component" starts checked
                kind: item.kind === "component" ? "component" : "feature",
                screens: item.screens.filter((screen) => names.has(screen)),
                what: item.what.trim(),
                why: item.why.trim(),
            });
        }
        return items;
    }

    /** Tells whether a stored value is an item. */
    public static isGap(value: unknown): value is DesignGap {
        const item = value as Partial<DesignGap> | null;
        return (
            typeof item === "object" &&
            item !== null &&
            typeof item.key === "string" &&
            /^[a-z0-9-]{1,80}$/.test(item.key) &&
            typeof item.name === "string" &&
            (item.kind === "component" || item.kind === "feature") &&
            Array.isArray(item.screens) &&
            item.screens.every((screen) => typeof screen === "string") &&
            typeof item.what === "string" &&
            typeof item.why === "string"
        );
    }

    private static slug(text: string): string {
        return text
            .normalize("NFKD")
            .replace(/\p{Mn}/gu, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80)
            .replace(/-+$/, "");
    }
}
