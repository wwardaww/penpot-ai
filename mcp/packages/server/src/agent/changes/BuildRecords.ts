import { rm } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { type DesignState, DesignStates } from "./DesignState";

/** One successful build (`.penforge/builds.json`). */
export const BuildRecordSchema = z.object({
    /** sequence number, 1 for the first build */
    n: z.number().int().min(1),
    /** `build <n>`, also the label of the W19 checkpoint */
    label: z.string(),
    at: z.string(),
    /** `full`, `incremental` (screens rebuilt) or `tokens` (theme only, no Claude turn) */
    mode: z.enum(["full", "incremental", "tokens"]),
    fileId: z.string(),
    /** Penpot file revision at the build, or null when the design could not be read */
    revn: z.number().nullable(),
    /** W19 checkpoint saved after the build, or null when it could not be saved */
    checkpointId: z.string().nullable(),
    /** Penpot version saved with the checkpoint */
    fileVersion: z.object({ fileId: z.string(), label: z.string(), createdAt: z.string().nullable() }).nullable(),
    /** commits of `design/` and `app-src/` (from the checkpoint) */
    designSha: z.string().nullable(),
    appSha: z.string().nullable(),
    /** design hash of each top-level board (`map.json`) */
    boardHashes: z.record(z.string(), z.string()),
    tokensHash: z.string().nullable(),
    prototypeHash: z.string().nullable(),
    animationsHash: z.string().nullable(),
    designSystemHash: z.string().nullable(),
    /** change request the build worked from (`CR-<n>`), null for a first build */
    changeRequest: z.string().nullable(),
    /** instructions for the AI given with this build (one-time and kept) */
    instructions: z.string().nullable(),
    /** design state saved with the build, relative to `.penforge/`; null when not saved */
    state: z.string().nullable(),
});

export type BuildRecord = z.infer<typeof BuildRecordSchema>;

/** Content of `.penforge/builds.json`. */
export const BuildsFileSchema = z.object({
    schemaVersion: z.literal(1),
    lastBuild: BuildRecordSchema.nullable(),
    builds: z.array(BuildRecordSchema),
});

export type BuildsFile = z.infer<typeof BuildsFileSchema>;

/**
 * Store of the build history: `.penforge/builds.json` (`lastBuild` + every build) and the design
 * state of the latest builds in `.penforge/builds/build-<n>.json`, the baseline of the next
 * change request.
 *
 * An invalid file counts as empty, so a broken file means "no build recorded" (the next update
 * compares by board hashes) instead of a failure.
 */
export class BuildRecords {
    public static readonly FILE = "builds.json";
    public static readonly STATE_DIR = "builds";
    /** Design states kept on disk (older ones are deleted; their records stay). */
    public static readonly KEPT_STATES = 5;

    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /** The build history; empty when none is recorded. */
    public async read(): Promise<BuildsFile> {
        let raw: unknown;
        try {
            raw = await this.workspace.readJson<unknown>(BuildRecords.FILE, null);
        } catch {
            raw = null;
        }
        const parsed = BuildsFileSchema.safeParse(raw);
        return parsed.success ? parsed.data : { schemaVersion: 1, lastBuild: null, builds: [] };
    }

    /** The last build, or null. */
    public async last(): Promise<BuildRecord | null> {
        return (await this.read()).lastBuild;
    }

    /** Number of the next build. */
    public async nextNumber(): Promise<number> {
        const file = await this.read();
        return Math.max(0, ...file.builds.map((build) => build.n)) + 1;
    }

    /** Design state saved with a build, or null. */
    public async state(record: BuildRecord): Promise<DesignState | null> {
        if (record.state === null) {
            return null;
        }
        try {
            return DesignStates.parse(await this.workspace.readJson<unknown>(record.state, null));
        } catch {
            return null;
        }
    }

    /**
     * Records a build as the last one, with its design state.
     *
     * @param record - the build, without `state` (set here)
     * @param state - design state at the build, or null when it could not be read
     */
    public async add(record: Omit<BuildRecord, "state">, state: DesignState | null): Promise<BuildRecord> {
        let statePath: string | null = null;
        if (state !== null) {
            statePath = `${BuildRecords.STATE_DIR}/build-${record.n}.json`;
            await this.workspace.writeJson(statePath, state);
        }
        const full: BuildRecord = { ...record, state: statePath };
        const file = await this.read();
        const builds = [...file.builds.filter((build) => build.n !== full.n), full].sort((a, b) => a.n - b.n);
        await this.workspace.writeJson(BuildRecords.FILE, { schemaVersion: 1, lastBuild: full, builds });
        await this.pruneStates(builds);
        return full;
    }

    /** Deletes the design states of all but the latest builds. */
    private async pruneStates(builds: BuildRecord[]): Promise<void> {
        const old = builds.filter((build) => build.state !== null).slice(0, -BuildRecords.KEPT_STATES);
        for (const build of old) {
            try {
                await rm(this.workspace.resolve(join(this.workspace.metaDir, ...build.state!.split("/"))), {
                    force: true,
                });
            } catch {
                // a state that cannot be deleted only costs disk space
            }
        }
    }
}
