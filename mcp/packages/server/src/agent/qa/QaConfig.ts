import { z } from "zod";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";

/** Settings of the visual QA of a project (`.penforge/qa.json`); every field has a default. */
export const QaSettingsSchema = z.object({
    /** score (0..100) a screen needs to count as matching the design */
    threshold: z.number().int().min(50).max(100).default(90),
    /** fix rounds per screen before the loop gives up */
    maxIterations: z.number().int().min(1).max(10).default(3),
    /** screens compared in one run; the others are reported as skipped */
    maxScreens: z.number().int().min(1).max(50).default(20),
    /** Claude turns in one run, all screens together */
    maxClaudeTurns: z.number().int().min(1).max(40).default(12),
    /** wall-clock limit of one run, in minutes (no new screen or fix starts after it) */
    maxMinutes: z.number().int().min(1).max(60).default(20),
    /** check the app against the design after every successful build */
    autoRunAfterBuild: z.boolean().default(false),
    /** colour tolerance of the pixel comparison, 0..1 (pixelmatch's `threshold`) */
    pixelThreshold: z.number().min(0).max(1).default(0.1),
    /** pause after the page loaded before the screenshot (fonts, images, animations) */
    settleMs: z.number().int().min(0).max(10_000).default(600),
    /** pause after a fix before the app is captured again (hot reload of the dev server) */
    reloadDelayMs: z.number().int().min(0).max(30_000).default(1500),
});

export type QaSettings = z.infer<typeof QaSettingsSchema>;

/** Settings the client may change (`visual-qa {mode:"settings"}`). */
export const QaSettingsPatchSchema = z.object({
    threshold: z.number().int().min(50).max(100).optional(),
    maxIterations: z.number().int().min(1).max(10).optional(),
    autoRunAfterBuild: z.boolean().optional(),
});

export type QaSettingsPatch = z.infer<typeof QaSettingsPatchSchema>;

/**
 * Store of `.penforge/qa.json`. An unreadable or invalid file counts as missing (defaults).
 */
export class QaConfig {
    public static readonly FILE = "qa.json";

    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    public async read(): Promise<QaSettings> {
        let raw: unknown = null;
        try {
            raw = await this.workspace.readJson<unknown>(QaConfig.FILE, null);
        } catch {
            raw = null;
        }
        const parsed = QaSettingsSchema.safeParse(raw ?? {});
        return parsed.success ? parsed.data : QaSettingsSchema.parse({});
    }

    /**
     * Changes some settings and saves them.
     *
     * @returns the new settings
     */
    public async update(patch: QaSettingsPatch): Promise<QaSettings> {
        const changes = Object.fromEntries(
            Object.entries(QaSettingsPatchSchema.parse(patch)).filter(([, value]) => value !== undefined)
        );
        const next = QaSettingsSchema.parse({ ...(await this.read()), ...changes });
        await this.workspace.writeJson(QaConfig.FILE, next);
        return next;
    }
}
