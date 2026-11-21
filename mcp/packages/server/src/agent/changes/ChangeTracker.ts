import { existsSync } from "fs";
import { join } from "path";
import type { WorkflowContext } from "@penpot/mcp-common";
import { BuildFiles } from "../build/BuildFiles";
import { DesignReader } from "../build/DesignReader";
import { Checkpoints } from "../checkpoints";
import { type BuildRecord, BuildRecords } from "./BuildRecords";
import { BuildInstructions, type InstructionsInput } from "./BuildInstructions";
import { ChangeDetector } from "./ChangeDetector";
import { type ChangeRequest, ChangeRequests } from "./ChangeRequests";
import { type ChangeItem, type ChangeSet, ChangeSets, type ScreenChange } from "./ChangeSet";
import { type DesignState, DesignStates } from "./DesignState";
import { DesignStateReader } from "./DesignStateReader";

/** What changed since the last build. */
export interface Detection {
    /** an app was built before (the Build button turns into Update) */
    hasBuild: boolean;
    /** last recorded build; null for no build or a build made before change requests */
    lastBuild: BuildRecord | null;
    changes: ChangeSet;
}

/** A build to record (see {@link ChangeTracker.recordBuild}). */
export interface FinishedBuild {
    mode: BuildRecord["mode"];
    /** design hash of each top-level board, as written to `map.json` */
    boardHashes: Record<string, string>;
    changeRequest: string | null;
    instructions: string | null;
}

/**
 * Change requests of a project (W34): the build checkpoint and design state saved after every
 * build, the detection of what changed since then and the change request files a build works
 * from. See `wiki/architecture.md` §7 (change requests).
 */
export class ChangeTracker {
    private readonly records: BuildRecords;
    private readonly requests: ChangeRequests;
    private readonly files: BuildFiles;

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly reader: DesignStateReader = new DesignStateReader(ctx.tools),
        private readonly detector: ChangeDetector = new ChangeDetector()
    ) {
        this.records = new BuildRecords(ctx.workspace);
        this.requests = new ChangeRequests(ctx.workspace);
        this.files = new BuildFiles(ctx.workspace);
    }

    /** The kept build instructions ("" when none). */
    public keptInstructions(): Promise<string> {
        return new BuildInstructions(this.ctx.workspace).readKept();
    }

    /** True when an app was built from this project (a build the next one can update). */
    public async hasBuild(): Promise<boolean> {
        const hasApp = existsSync(join(this.ctx.workspace.appSrcDir, "package.json"));
        return hasApp && (await this.files.readMap()) !== null && (await this.files.readStack()) !== null;
    }

    /** Compares the design with the last build. Reads nothing from Penpot when there is no build. */
    public async detect(): Promise<Detection> {
        if (!(await this.hasBuild())) {
            return { hasBuild: false, lastBuild: null, changes: ChangeSets.empty() };
        }
        const lastBuild = await this.records.last();
        const baseline =
            lastBuild && lastBuild.fileId === this.ctx.context.fileId ? await this.records.state(lastBuild) : null;
        if (baseline !== null) {
            // nothing was saved since the build: no need to read the whole design
            if (baseline.revn > 0 && (await this.reader.readRevn(this.ctx.context.fileId)) === baseline.revn) {
                return { hasBuild: true, lastBuild, changes: ChangeSets.empty() };
            }
            const current = await this.reader.read(this.ctx.context.fileId);
            return { hasBuild: true, lastBuild, changes: this.detector.compare(baseline, current) };
        }
        return { hasBuild: true, lastBuild, changes: await this.compareHashes() };
    }

    /**
     * Writes a change request of the changes since the last build and the instructions of this
     * update (the kept instructions are updated first).
     *
     * @returns the request, or null when nothing changed and no new instruction was given (no
     *     file is written then)
     */
    public async createRequest(input: InstructionsInput | undefined): Promise<ChangeRequest | null> {
        const detection = await this.detect();
        const instructions = await new BuildInstructions(this.ctx.workspace).apply(input);
        if (detection.changes.count === 0 && instructions.text.length === 0) {
            return null;
        }
        return this.requests.create(
            this.ctx.context.fileId,
            detection.lastBuild?.n ?? 0,
            detection.changes,
            instructions
        );
    }

    /** Reads a change request of this file; null when missing, invalid or of another file. */
    public async readRequest(id: string): Promise<ChangeRequest | null> {
        const request = await this.requests.read(id);
        return request !== null && request.fileId === this.ctx.context.fileId ? request : null;
    }

    /**
     * Records a successful build: saves the design state, the W19 checkpoint `build <n>` and the
     * `builds.json` entry, and marks its change request as done. Never throws (except when the
     * run is cancelled): problems are reported as `log` events and leave parts empty.
     */
    public async recordBuild(build: FinishedBuild): Promise<BuildRecord | null> {
        try {
            const n = await this.records.nextNumber();
            const label = `build ${n}`;
            let state: DesignState | null = null;
            try {
                state = await this.reader.read(this.ctx.context.fileId);
            } catch (error) {
                this.log(`The design state of ${label} could not be read: ${ChangeTracker.describe(error)}`);
            }
            let checkpoint = null;
            try {
                checkpoint = await new Checkpoints(this.ctx).create({ label, workflow: "build-run" });
            } catch (error) {
                if (this.ctx.signal.aborted) {
                    throw error;
                }
                this.log(`No checkpoint saved for ${label}: ${ChangeTracker.describe(error)}`);
            }
            const hashes = state ? DesignStates.hashes(state) : null;
            const record = await this.records.add(
                {
                    n,
                    label,
                    at: new Date().toISOString(),
                    mode: build.mode,
                    fileId: this.ctx.context.fileId,
                    revn: state?.revn ?? null,
                    checkpointId: checkpoint?.id ?? null,
                    fileVersion: checkpoint?.fileVersion
                        ? {
                              fileId: checkpoint.fileVersion.fileId,
                              label: checkpoint.fileVersion.label,
                              createdAt: checkpoint.fileVersion.createdAt,
                          }
                        : null,
                    designSha: checkpoint?.designSha ?? null,
                    appSha: checkpoint?.appSha ?? null,
                    boardHashes: build.boardHashes,
                    tokensHash: hashes?.tokensHash ?? null,
                    prototypeHash: hashes?.prototypeHash ?? null,
                    animationsHash: hashes?.animationsHash ?? null,
                    designSystemHash: hashes?.designSystemHash ?? null,
                    changeRequest: build.changeRequest,
                    instructions: build.instructions,
                },
                state
            );
            if (build.changeRequest !== null) {
                const request = await this.requests.read(build.changeRequest);
                if (request !== null) {
                    await this.requests.markBuilt(request, n);
                }
            }
            return record;
        } catch (error) {
            if (this.ctx.signal.aborted) {
                throw error;
            }
            this.log(`The build could not be recorded: ${ChangeTracker.describe(error)}`);
            return null;
        }
    }

    /**
     * Changes by board hashes (`map.json` against `generate_code_hints`), for builds without a
     * saved design state.
     */
    private async compareHashes(): Promise<ChangeSet> {
        const map = await this.files.readMap();
        const design = await new DesignReader(this.ctx.tools).read();
        const known = map?.boards ?? {};
        const screens: ScreenChange[] = [];
        const changed: ChangeItem = ChangeSets.item("design-changed", {}, "The design of this screen changed");
        for (const board of design.boards) {
            const before = known[board.id];
            if (before === undefined) {
                screens.push({ boardId: board.id, name: board.name, status: "added", items: [], more: 0 });
            } else if (before.hash !== board.hash) {
                screens.push({
                    boardId: board.id,
                    name: board.name,
                    status: "changed",
                    ...(before.name !== board.name ? { previousName: before.name } : {}),
                    items: [changed],
                    more: 0,
                });
            } else if (before.name !== board.name) {
                screens.push({
                    boardId: board.id,
                    name: board.name,
                    status: "renamed",
                    previousName: before.name,
                    items: [],
                    more: 0,
                });
            }
        }
        const present = new Set(design.boards.map((board) => board.id));
        for (const [boardId, entry] of Object.entries(known)) {
            if (!present.has(boardId)) {
                screens.push({ boardId, name: entry.name, status: "removed", items: [], more: 0 });
            }
        }
        return ChangeSets.of(screens, [], [], null, "hashes");
    }

    private log(text: string): void {
        if (this.ctx.context.persona === "developer") {
            this.ctx.emit("log", { text });
        }
    }

    private static describe(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
