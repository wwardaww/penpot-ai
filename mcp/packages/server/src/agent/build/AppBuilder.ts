import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { WorkflowContext, WorkflowResult } from "@penpot/mcp-common";
import { AppSourceGit } from "./AppSourceGit";
import { BuildFiles, type BuildMap, type Plan, type PlanScreen, type Stack, StackSchema } from "./BuildFiles";
import { BuildError } from "./BuildError";
import { BuildLock } from "./BuildLock";
import { type BuildStep, BuildText } from "./BuildText";
import { type CommandExecutor, type CommandOutcome, ProcessCommandExecutor } from "./CommandExecutor";
import { JsonReply } from "./JsonReply";
import { Routes } from "./Routes";
import { TokenThemeNote } from "../tokens/TokenThemeNote";
import { BuildInstructions, type BuildInstructionSet, type InstructionsInput } from "../changes/BuildInstructions";
import { type ChangeRequest, ChangeRequests } from "../changes/ChangeRequests";
import { ChangeTracker } from "../changes/ChangeTracker";
import { DesignReader, type DesignSnapshot } from "./DesignReader";

/** Developer edits of a plan, sent with `build-run`. */
export const BuildOverridesSchema = z.object({
    /** extra instructions for the build */
    notes: z.string().max(4000).optional(),
    /** stack wanted instead of the proposed one, e.g. "Next.js" */
    stackName: z.string().max(120).optional(),
    /** route per board id */
    routes: z.record(z.string(), z.string()).optional(),
});

export type BuildOverrides = z.infer<typeof BuildOverridesSchema>;

/** Params of `build-run`. */
export interface BuildRunParams {
    /** plan to build (from the `plan` event); defaults to the last plan */
    planId?: string;
    overrides?: BuildOverrides;
    /** instructions for the AI of this build (W34; first build and plan-based updates) */
    instructions?: InstructionsInput;
    /**
     * Update from the design changes since the last build (W34): writes a change request
     * `CR-<n>` first and builds from it. Carries the instructions of the update.
     */
    update?: InstructionsInput;
    /** Update from an existing change request (`CR-<n>`) of this file */
    changeRequest?: string;
}

/** Asset Claude used for an instruction (a sound, an image), named in the build result. */
export interface BuildAsset {
    file: string;
    source: string;
    license: string;
}

/**
 * Runner of the workflows listed in `stack.json` `preBuild`.
 *
 * A strategy, so the builder does not depend on the workflow registry.
 */
export interface PreBuildRunner {
    /**
     * Runs a workflow with the build's context.
     *
     * @returns false when no such workflow exists
     */
    run(workflowId: string, ctx: WorkflowContext): Promise<boolean>;
}

/** Collaborators of an {@link AppBuilder}. */
export interface AppBuilderOptions {
    executor?: CommandExecutor;
    preBuild?: PreBuildRunner;
    /** fix turns after a failed install or check before giving up */
    maxFixAttempts?: number;
    /** change requests and build records (W34) */
    tracker?: ChangeTracker;
}

/** Failed install or check command. */
interface CommandFailure {
    step: "install" | "check";
    command: string[];
    outcome: CommandOutcome;
}

/**
 * Builder of the app in `app-src/` from a confirmed plan (`build-run` workflow).
 *
 * Steps: pre-build workflows, scaffold (full builds), one Claude turn per screen to build, install
 * and check (typecheck, build) with autonomous fix turns, commit to the `app-src` git repository
 * and update `.penforge/map.json` (board → files). Incremental builds only regenerate new and
 * changed screens; edits a turn makes to files of other screens are reverted. Progress is reported
 * per step (`progress` events with `step`, `id`, `status`, …); technical output goes to
 * developers only (`log` events).
 */
export class AppBuilder {
    private static readonly INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
    private static readonly CHECK_TIMEOUT_MS = 10 * 60 * 1000;
    private static readonly MAX_PROMPT_OUTPUT_CHARS = 6000;
    private static readonly DEPENDENCY_FILES =
        /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

    private static readonly ScaffoldReplySchema = z.object({
        stack: StackSchema.omit({ platform: true, schemaVersion: true, preBuild: true }),
    });

    private static readonly ScreenReplySchema = z.object({
        files: z.array(z.string()).default([]),
    });

    /** Parts of any turn's reply about the instructions for the AI (W34). */
    private static readonly ExtrasReplySchema = z.object({
        conflicts: z.array(z.string().max(1000)).max(20).default([]),
        assets: z
            .array(
                z.object({
                    file: z.string().max(300),
                    source: z.string().max(500).default(""),
                    license: z.string().max(200).default(""),
                })
            )
            .max(50)
            .default([]),
    });

    private readonly text: BuildText;
    private readonly files: BuildFiles;
    private readonly git: AppSourceGit;
    private readonly executor: CommandExecutor;
    private readonly preBuild: PreBuildRunner | null;
    private readonly maxFixAttempts: number;
    /** Claude session shared by the turns of one build */
    private session: string | undefined;
    /** note on the generated design token theme, added to the build prompts (W21) */
    private themeNote = "";
    private readonly tracker: ChangeTracker;
    /** change request the build works from (W34), null for a first build */
    private request: ChangeRequest | null = null;
    /** instructions for the AI of this build (W34) */
    private instructions: BuildInstructionSet | null = null;
    /** route of each board of the last build (null: not a screen) */
    private screenRoutes = new Map<string, string | null>();
    /** Claude turns run so far */
    private turns = 0;
    /** instructions Claude did not follow because they conflict with the design */
    private readonly conflicts: { text: string }[] = [];
    /** assets Claude used for instructions */
    private readonly assets: BuildAsset[] = [];

    constructor(
        private readonly ctx: WorkflowContext,
        options: AppBuilderOptions = {}
    ) {
        this.text = new BuildText(ctx.context.persona);
        this.files = new BuildFiles(ctx.workspace);
        this.git = new AppSourceGit(ctx.workspace.appSrcDir);
        this.executor = options.executor ?? new ProcessCommandExecutor();
        this.preBuild = options.preBuild ?? null;
        this.maxFixAttempts = options.maxFixAttempts ?? 3;
        this.tracker = options.tracker ?? new ChangeTracker(ctx);
    }

    public async build(params: BuildRunParams = {}): Promise<WorkflowResult> {
        const release = BuildLock.tryAcquire(this.ctx.workspace.root);
        if (release === null) {
            throw new BuildError(this.text.busy(), "busy");
        }
        try {
            return await this.run(params);
        } finally {
            release();
        }
    }

    private async run(params: BuildRunParams): Promise<WorkflowResult> {
        const overrides = BuildOverridesSchema.safeParse(params.overrides ?? {});
        if (!overrides.success) {
            throw new Error(`Invalid overrides: ${overrides.error.message}`);
        }
        if (params.update !== undefined || params.changeRequest !== undefined) {
            return this.runUpdate(params, overrides.data);
        }
        const plan = await this.files.readPlan();
        const stalePlan =
            plan === null ||
            plan.mode === "none" ||
            plan.fileId !== this.ctx.context.fileId ||
            (params.planId !== undefined && plan.planId !== params.planId);
        if (stalePlan) {
            throw new BuildError(this.text.stalePlan(), "stale-plan");
        }
        const full = plan.mode === "full";
        const map = full ? null : await this.files.readMap();
        if (!full && map === null) {
            throw new BuildError(this.text.stalePlan(), "stale-plan");
        }
        if (full) {
            this.instructions = await new BuildInstructions(this.ctx.workspace).apply(params.instructions);
        } else {
            // from the second build on, every build is a change request (W34)
            this.request = await this.tryCreateRequest(params.instructions);
            this.instructions = this.request?.instructions ?? (await this.keptOnly());
        }
        const screens = AppBuilder.applyRoutes(plan.screens, overrides.data.routes);
        return this.carryOut(plan, screens, map, overrides.data);
    }

    /**
     * Update from a change request: the one given, or a new one of the changes since the last
     * build. Token-only changes are applied by the pre-build token sync without a Claude turn;
     * nothing to do means no turn at all.
     */
    private async runUpdate(params: BuildRunParams, overrides: BuildOverrides): Promise<WorkflowResult> {
        const map = await this.files.readMap();
        const stack = await this.files.readStack();
        if (map === null || stack === null || !(await this.tracker.hasBuild())) {
            throw new BuildError(this.text.noBuild(), "no-build");
        }
        this.step("changes", "running");
        let request: ChangeRequest | null;
        if (params.changeRequest !== undefined) {
            request = await this.tracker.readRequest(params.changeRequest);
            if (request === null || request.builtAs !== null) {
                throw new BuildError(this.text.stalePlan(), "stale-plan");
            }
        } else {
            request = await this.tracker.createRequest(params.update);
        }
        this.step("changes", "done");
        if (request === null || ChangeRequests.isEmpty(request)) {
            // nothing changed and no new instruction: no Claude turn, no new build
            this.ctx.emit("result", {
                mode: "none",
                changeRequest: request?.id ?? null,
                commit: null,
                screens: [],
                removed: [],
                tokenOnly: false,
                build: null,
                preview: false,
            });
            return { summary: this.text.nothingChanged() };
        }
        this.request = request;
        this.instructions = request.instructions;
        const design = await new DesignReader(this.ctx.tools).read();
        const plan = this.updatePlan(request, design, map, stack);
        const screens = AppBuilder.applyRoutes(plan.screens, overrides.routes);
        return this.carryOut(plan, screens, map, overrides);
    }

    /**
     * Builds a plan (full, or incremental from `map`), commits, records the build and emits
     * `result`.
     */
    private async carryOut(
        plan: Plan,
        screens: PlanScreen[],
        map: BuildMap | null,
        overrides: BuildOverrides
    ): Promise<WorkflowResult> {
        const full = plan.mode === "full";
        this.screenRoutes = new Map(Object.entries(map?.boards ?? {}).map(([id, board]) => [id, board.route]));
        this.step("prepare", "running");
        await this.git.ensureIgnores();
        this.step("prepare", "done");

        let stack = plan.stack;
        // pre-build workflows work on the app: on a full build they run once it is scaffolded
        if (!full) {
            await this.runPreBuild(AppBuilder.withTokenSync(stack, this.request));
        }
        const start = await this.git.snapshot();
        if (full) {
            stack = await this.scaffold(plan, screens, overrides);
            await this.runPreBuild(stack);
        }
        this.themeNote = await TokenThemeNote.forBuild(this.ctx.workspace);

        const targets = screens.filter((screen) =>
            full ? screen.status !== "removed" : screen.status === "new" || screen.status === "changed"
        );
        if (!full && this.request !== null && this.needsAppWideTurn(this.request)) {
            await this.applyChangeRequest(this.request, screens);
        }
        const owners = map === null ? new Map<string, string>() : AppBuilder.owners(map);
        const built = new Map<string, string[]>();
        for (const screen of targets) {
            const previous = map?.boards[screen.boardId]?.files ?? [];
            built.set(screen.boardId, await this.buildScreen(plan, screens, screen, previous, owners, overrides));
        }
        const removed = screens.filter((screen) => screen.status === "removed");
        if (removed.length > 0) {
            await this.removeScreens(removed, map!);
        }
        await this.settleConflicts();

        // a token-only update ran no Claude turn: the token sync checked the theme itself
        if (this.turns > 0) {
            await this.installAndCheck(stack, full || (await this.dependenciesChanged(start)));
        }

        this.step("save", "running");
        const names = targets.map((screen) => screen.name);
        const message = full
            ? `penforge(build): build ${names.join(", ")}`
            : `penforge(build): update ${[...names, ...removed.map((s) => `remove ${s.name}`)].join(", ") || "theme"}${this.request ? ` (${this.request.id})` : ""}`;
        const commit = await this.ctx.workspace.commitAll("app-src", AppBuilder.firstLine(message));
        const nextMap = this.nextMap(plan, screens, built, map, commit);
        await this.files.writeMap(nextMap);
        this.step("save", "done");

        // only the token sync changed the app (no Claude turn)
        const tokenOnly = !full && this.turns === 0 && (this.request?.changes.tokens.length ?? 0) > 0;
        const record = await this.tracker.recordBuild({
            mode: full ? "full" : tokenOnly ? "tokens" : "incremental",
            boardHashes: Object.fromEntries(Object.entries(nextMap.boards).map(([id, board]) => [id, board.hash])),
            changeRequest: this.request?.id ?? null,
            instructions: this.instructions ? BuildInstructions.record(this.instructions) : null,
        });

        this.ctx.emit("result", {
            planId: plan.planId,
            mode: plan.mode,
            commit,
            screens: names,
            removed: removed.map((screen) => screen.name),
            changeRequest: this.request?.id ?? null,
            build: record?.n ?? null,
            tokenOnly,
            assets: this.assets,
            conflicts: this.conflicts.map((conflict) => conflict.text),
            preview: true,
        });
        return {
            summary: this.text.isDeveloper
                ? `Built ${names.length} screen(s) with ${stack.name}${commit ? `; commit ${commit.slice(0, 10)}` : ""}.`
                : "Your app is ready.",
        };
    }

    // change requests -------------------------------------------------------------------------

    /** Change request of a `plan.json` update; null (logged) when the changes cannot be read. */
    private async tryCreateRequest(input: InstructionsInput | undefined): Promise<ChangeRequest | null> {
        try {
            return await this.tracker.createRequest(input);
        } catch (error) {
            if (this.ctx.signal.aborted) {
                throw error;
            }
            this.log(`No change request written: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    private async keptOnly(): Promise<BuildInstructionSet> {
        return { text: "", kept: await this.tracker.keptInstructions() };
    }

    /**
     * Incremental plan of a change request: its new, changed and removed screens; every other
     * screen stays. Board names and hashes come from the design now (for `map.json`).
     */
    private updatePlan(request: ChangeRequest, design: DesignSnapshot, map: BuildMap, stack: Stack): Plan {
        const routes = new Routes(Object.values(map.boards).flatMap((entry) => (entry.route ? [entry.route] : [])));
        const changes = new Map(request.changes.screens.map((screen) => [screen.boardId, screen]));
        const screens: PlanScreen[] = [];
        for (const board of design.boards) {
            const known = map.boards[board.id];
            const change = changes.get(board.id);
            if (known === undefined) {
                if (change?.status === "added") {
                    screens.push({
                        boardId: board.id,
                        name: board.name,
                        route: routes.next(board.name),
                        status: "new",
                    });
                }
            } else if (known.route !== null) {
                const status = change?.status === "changed" ? "changed" : "same";
                screens.push({ boardId: board.id, name: board.name, route: known.route, status });
            }
        }
        const present = new Set(design.boards.map((board) => board.id));
        for (const [boardId, entry] of Object.entries(map.boards)) {
            if (!present.has(boardId) && entry.route !== null) {
                screens.push({ boardId, name: entry.name, route: entry.route, status: "removed" });
            }
        }
        return {
            schemaVersion: 1,
            planId: request.id,
            createdAt: request.createdAt,
            fileId: this.ctx.context.fileId,
            mode: "incremental",
            platform: stack.platform,
            summary: "",
            stack,
            screens,
            components: [],
            tree: "",
            notes: "",
            boards: Object.fromEntries(
                design.boards.map((board) => [board.id, { name: board.name, hash: board.hash }])
            ),
            navigation: design.edges,
        };
    }

    /**
     * True when a change request needs a turn on the whole app: new instructions, flow or design
     * system changes, changed boards that are not screens, or a request without detailed changes.
     */
    private needsAppWideTurn(request: ChangeRequest): boolean {
        return (
            request.instructions.text.length > 0 ||
            request.changes.flows.length > 0 ||
            request.changes.designSystem !== null ||
            this.nonScreenChanges(request).length > 0
        );
    }

    /** Changed boards of a request that are no screens of the app (shared parts, components). */
    private nonScreenChanges(request: ChangeRequest): ChangeRequest["changes"]["screens"] {
        return request.changes.screens.filter(
            (screen) => screen.status === "changed" && this.screenRoutes.get(screen.boardId) === null
        );
    }

    /** One Claude turn for the app-wide part of a change request. */
    private async applyChangeRequest(request: ChangeRequest, screens: PlanScreen[]): Promise<void> {
        this.step("apply", "running", request.id);
        const lines = [
            `## Step: apply the change request ${request.id}`,
            "",
            "Change what the whole app needs for this change request. The screens listed under",
            '"Screens" are updated one by one after this step; do not rebuild them now.',
            "",
            ...ChangeRequests.appWideLines(request),
        ];
        const shared = this.nonScreenChanges(request);
        if (shared.length > 0) {
            lines.push("", "### Boards that are not screens (shared parts of the app)");
            for (const board of shared) {
                lines.push("", `"${board.name}" (board ${board.boardId}):`, ...ChangeRequests.screenLines(board));
            }
        }
        const updated = screens.filter((screen) => screen.status !== "same");
        if (updated.length > 0) {
            lines.push("", "### Screens", ...updated.map((screen) => `- "${screen.name}" (${screen.status})`));
        }
        lines.push(
            "",
            "All screens:",
            ...screens.filter((s) => s.status !== "removed").map((s) => `- "${s.name}" → ${s.route}`)
        );
        this.addNotes(lines, "", undefined);
        lines.push(
            "",
            "End your reply with a ```json block:",
            "```json",
            '{ "files": ["src/…"], "conflicts": [], "assets": [] }',
            "```"
        );
        await this.turn(lines.join("\n"));
        this.step("apply", "done", request.id);
    }

    /**
     * Asks the user about instructions Claude did not follow because they conflict with the
     * design; one more turn applies them when the user wants them followed.
     */
    private async settleConflicts(): Promise<void> {
        if (this.conflicts.length === 0) {
            return;
        }
        const list = this.conflicts.map((conflict) => `- ${conflict.text}`).join("\n");
        const answer = await this.ctx.ask({
            text: this.text.conflictQuestion(list),
            options: [
                { id: "design", label: this.text.keepDesign() },
                { id: "instruction", label: this.text.followInstruction() },
            ],
        });
        if (answer !== "instruction") {
            return;
        }
        this.step("apply", "running", "conflicts", "conflicts");
        const conflicts = this.conflicts.splice(0);
        await this.turn(
            [
                "## Step: follow the instructions after all",
                "",
                "The user wants these instructions followed even where they differ from the design:",
                ...conflicts.map((conflict) => `- ${conflict.text}`),
                "",
                "End your reply with a ```json block listing the files you changed and the assets you used:",
                "```json",
                '{ "files": [], "assets": [] }',
                "```",
            ].join("\n")
        );
        this.step("apply", "done", "conflicts", "conflicts");
    }

    // steps -----------------------------------------------------------------------------------

    private async runPreBuild(stack: Stack): Promise<void> {
        for (const id of stack.preBuild) {
            this.step("prebuild", "running", id, id);
            const known = this.preBuild ? await this.preBuild.run(id, this.ctx) : false;
            if (!known) {
                this.log(`Pre-build workflow "${id}" is not installed; skipped.`);
            }
            this.step("prebuild", "done", id, id);
        }
    }

    private async scaffold(plan: Plan, screens: PlanScreen[], overrides: BuildOverrides): Promise<Stack> {
        const stackName = overrides.stackName?.trim() || plan.stack.name;
        this.step("scaffold", "running", stackName);
        const result = await this.turn(this.scaffoldPrompt(plan, screens, overrides));
        const reply = JsonReply.parse(result.text, AppBuilder.ScaffoldReplySchema);
        // the theme file recorded by the pre-build token sync (W21) stays recorded
        const current = await this.files.readStack();
        const theme = { themeFile: current?.themeFile, themeFormat: current?.themeFormat };
        const stack = reply
            ? StackSchema.parse({ ...reply.stack, platform: plan.platform, preBuild: plan.stack.preBuild, ...theme })
            : { ...plan.stack, ...theme };
        if (!reply) {
            this.log("The scaffold reply had no valid stack block; keeping the planned stack.");
        }
        await this.files.writeStack(stack);
        this.step("scaffold", "done", stackName);
        return stack;
    }

    private async buildScreen(
        plan: Plan,
        screens: PlanScreen[],
        screen: PlanScreen,
        previous: string[],
        owners: Map<string, string>,
        overrides: BuildOverrides
    ): Promise<string[]> {
        const update = screen.status === "changed";
        const progress = { step: "screen", id: screen.boardId, name: screen.name, update };
        const label = this.text.screen(screen.name, update);
        this.ctx.emit("progress", { ...progress, label, status: "running" });
        const before = await this.git.snapshot();
        const result = await this.turn(this.screenPrompt(plan, screens, screen, previous, owners, overrides));
        const after = await this.git.snapshot();
        let changed = await this.git.changedFiles(before, after);

        const foreign = changed.filter((file) => {
            const owner = owners.get(file);
            return owner !== undefined && owner !== screen.boardId;
        });
        if (foreign.length > 0) {
            await this.git.restore(before, foreign);
            this.log(`Reverted changes to other screens' files: ${foreign.join(", ")}`);
            changed = changed.filter((file) => !foreign.includes(file));
        }
        const claimed = (JsonReply.parse(result.text, AppBuilder.ScreenReplySchema)?.files ?? [])
            .map(AppBuilder.normalizePath)
            .filter((file): file is string => file !== null && !foreign.includes(file));
        const files = [...new Set([...previous, ...changed, ...claimed])]
            .filter((file) => this.git.exists(file))
            .sort();
        this.ctx.emit("progress", { ...progress, label, status: "done" });
        return files;
    }

    private async removeScreens(removed: PlanScreen[], map: BuildMap): Promise<void> {
        this.step("cleanup", "running");
        const lines = removed.map((screen) => {
            const files = map.boards[screen.boardId]?.files ?? [];
            return `- "${screen.name}" (route ${screen.route}); its files: ${files.join(", ") || "unknown"}`;
        });
        await this.turn(
            [
                "These screens were deleted from the design. Remove them from the app: delete their files,",
                "their routes and every link to them. Keep the rest of the app working.",
                "",
                ...lines,
            ].join("\n")
        );
        this.step("cleanup", "done");
    }

    private async installAndCheck(stack: Stack, installFirst: boolean): Promise<void> {
        let needInstall = installFirst || !existsSync(join(this.ctx.workspace.appSrcDir, "node_modules"));
        for (let attempt = 0; ; attempt++) {
            const failure = await this.runCommands(stack, needInstall);
            if (failure === null) {
                return;
            }
            this.log(
                `\`${failure.command.join(" ")}\` failed (${failure.outcome.timedOut ? "timeout" : `exit ${failure.outcome.code}`}):\n` +
                    BuildText.tail(failure.outcome.output, AppBuilder.MAX_PROMPT_OUTPUT_CHARS)
            );
            if (attempt >= this.maxFixAttempts) {
                throw new BuildError(this.text.gaveUp(failure.command, failure.outcome, attempt), "gave-up");
            }
            const fixId = String(attempt + 1);
            this.step("fix", "running", fixId, `fix-${fixId}`);
            const before = await this.git.snapshot();
            await this.turn(this.fixPrompt(failure));
            const changed = await this.git.changedFiles(before, await this.git.snapshot());
            needInstall = failure.step === "install" || changed.some((file) => AppBuilder.DEPENDENCY_FILES.test(file));
            this.step("fix", "done", fixId, `fix-${fixId}`);
        }
    }

    /** Runs install (when asked) and the checks; returns the first failure or null. */
    private async runCommands(stack: Stack, install: boolean): Promise<CommandFailure | null> {
        if (install) {
            const command = stack.commands.install;
            this.step("install", "running", command.join(" "));
            const outcome = await this.execute(command, AppBuilder.INSTALL_TIMEOUT_MS);
            if (outcome.code !== 0) {
                this.step("install", "error", command.join(" "));
                return { step: "install", command, outcome };
            }
            this.step("install", "done", command.join(" "));
        }
        const checks = [stack.commands.typecheck, stack.commands.build].filter((c): c is string[] => c !== undefined);
        for (const command of checks) {
            this.step("check", "running", command.join(" "));
            const outcome = await this.execute(command, AppBuilder.CHECK_TIMEOUT_MS);
            if (outcome.code !== 0) {
                this.step("check", "error", command.join(" "));
                return { step: "check", command, outcome };
            }
            this.step("check", "done", command.join(" "));
        }
        return null;
    }

    private execute(command: string[], timeoutMs: number): Promise<CommandOutcome> {
        return this.executor.execute(command, {
            cwd: this.ctx.workspace.appSrcDir,
            signal: this.ctx.signal,
            timeoutMs,
        });
    }

    private async dependenciesChanged(since: string): Promise<boolean> {
        const changed = await this.git.changedFiles(since, await this.git.snapshot());
        return changed.some((file) => AppBuilder.DEPENDENCY_FILES.test(file));
    }

    /** Runs one Claude turn of the build, in the build's shared session. */
    private async turn(prompt: string): Promise<{ text: string }> {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
        const result = await this.ctx.runner.run({
            prompt,
            promptName: "build-run",
            resumeSessionId: this.session,
        });
        this.session = result.sessionId ?? this.session;
        this.turns++;
        this.collectExtras(result.text);
        return result;
    }

    /** Keeps the conflicts and assets a reply lists (W34 instructions). */
    private collectExtras(text: string): void {
        const extras = JsonReply.parse(text, AppBuilder.ExtrasReplySchema);
        if (extras === null) {
            return;
        }
        for (const conflict of extras.conflicts) {
            const clean = conflict.trim();
            if (clean.length > 0 && !this.conflicts.some((known) => known.text === clean)) {
                this.conflicts.push({ text: clean });
            }
        }
        for (const asset of extras.assets) {
            const file = AppBuilder.normalizePath(asset.file);
            if (file !== null && !this.assets.some((known) => known.file === file)) {
                this.assets.push({ file, source: asset.source.trim(), license: asset.license.trim() });
            }
        }
    }

    // prompts ---------------------------------------------------------------------------------

    private scaffoldPrompt(plan: Plan, screens: PlanScreen[], overrides: BuildOverrides): string {
        const stackName = overrides.stackName?.trim();
        const lines = [
            "## Step: scaffold the app",
            "",
            "Create the project in `app-src/` (it may already hold an older version; replace what does",
            "not fit). Set up the tooling, global styles and design tokens taken from the design",
            "(colors, typography, spacing), the shared components below, and routing with one route per",
            "screen. Create every screen as a simple placeholder at the path you will fill later; the",
            "following steps build them one by one. Do not install dependencies or run commands.",
            "",
            stackName && stackName !== plan.stack.name
                ? `Stack: the developer asked for **${stackName}** instead of the proposed stack.`
                : `Stack: ${plan.stack.name}${plan.stack.version ? ` (${plan.stack.version})` : ""}.`,
            "",
            "Screens and routes:",
            ...screens
                .filter((screen) => screen.status !== "removed")
                .map((screen) => `- "${screen.name}" (board ${screen.boardId}) → ${screen.route}`),
        ];
        if (plan.components.length > 0) {
            lines.push("", "Shared components:", ...plan.components.map((c) => `- ${c.name}: ${c.purpose}`));
        }
        if (plan.tree.trim()) {
            lines.push("", "Planned folder tree:", "```", plan.tree.trimEnd(), "```");
        }
        this.addNotes(lines, plan.notes, overrides.notes);
        lines.push(
            "",
            "End your reply with a ```json block holding the final stack:",
            "```json",
            JSON.stringify({ stack: AppBuilder.stackExample(plan.stack) }, null, 2),
            "```"
        );
        return lines.join("\n");
    }

    private screenPrompt(
        plan: Plan,
        screens: PlanScreen[],
        screen: PlanScreen,
        previous: string[],
        owners: Map<string, string>,
        overrides: BuildOverrides
    ): string {
        const routes = new Map(screens.map((s) => [s.boardId, s]));
        const navigation = plan.navigation
            .filter((edge) => edge.from === screen.boardId && routes.has(edge.to))
            .map((edge) => {
                const target = routes.get(edge.to)!;
                return `- ${edge.trigger} on "${edge.sourceName}" → "${target.name}" (${target.route})`;
            });
        const update = screen.status === "changed";
        const lines = [
            `## Step: ${update ? "update" : "build"} the screen "${screen.name}"`,
            "",
            `Board id ${screen.boardId}, route ${screen.route}.`,
            update
                ? "The design of this screen changed since the last build. Update its code to match the design; keep what still matches."
                : "Build this screen so it looks like the board.",
            "Look at it first: `generate_code_hints` with this nodeId for structure and styles, and",
            "`capture_node_screenshot` to see it. Read nested layers with `get_node_properties` when needed.",
            "",
            "Navigation from this screen (wire these up):",
            ...(navigation.length > 0 ? navigation : ["- none"]),
            "",
            "All screens:",
            ...screens.filter((s) => s.status !== "removed").map((s) => `- "${s.name}" → ${s.route}`),
        ];
        const change = this.request?.changes.screens.find((s) => s.boardId === screen.boardId);
        if (update && change !== undefined && this.request !== null) {
            lines.push(
                "",
                `What changed on this screen since the last build (change request ${this.request.id}); work from this list and look only at the layers it names:`,
                ...ChangeRequests.screenLines(change)
            );
        }
        if (previous.length > 0) {
            lines.push("", "Files of this screen from the last build:", ...previous.map((file) => `- ${file}`));
        }
        const others = [...owners.entries()].filter(([, owner]) => owner !== screen.boardId).map(([file]) => file);
        if (others.length > 0) {
            lines.push(
                "",
                "Do not change these files of other screens (changes to them are undone):",
                ...others.map((file) => `- ${file}`)
            );
        }
        this.addNotes(lines, plan.notes, overrides.notes);
        lines.push(
            "",
            "End your reply with a ```json block listing the files of this screen, relative to `app-src/`:",
            "```json",
            '{ "files": ["src/screens/Example.tsx"] }',
            "```"
        );
        return lines.join("\n");
    }

    private fixPrompt(failure: CommandFailure): string {
        return [
            `## Step: fix the ${failure.step === "install" ? "dependency installation" : "build"}`,
            "",
            `The command \`${failure.command.join(" ")}\` ${failure.outcome.timedOut ? "timed out" : `failed with exit code ${failure.outcome.code}`}.`,
            "Fix the cause in the code or configuration of `app-src/`. Do not run commands; the build is",
            "checked again after your reply. Do not remove features or screens to make it pass.",
            "",
            "Output (last part):",
            "```",
            BuildText.tail(failure.outcome.output, AppBuilder.MAX_PROMPT_OUTPUT_CHARS),
            "```",
        ].join("\n");
    }

    private addNotes(lines: string[], planNotes: string, developerNotes: string | undefined): void {
        if (this.themeNote) {
            lines.push("", this.themeNote);
        }
        if (planNotes.trim()) {
            lines.push("", "Plan notes:", planNotes.trim());
        }
        if (developerNotes?.trim()) {
            lines.push("", "Instructions from the developer (follow them):", developerNotes.trim());
        }
        const instructions = this.instructions ? BuildInstructions.promptSection(this.instructions) : "";
        if (instructions) {
            lines.push("", instructions);
        }
    }

    /** Stack whose pre-build steps include the token sync when a change request changed tokens. */
    private static withTokenSync(stack: Stack, request: ChangeRequest | null): Stack {
        if (request === null || request.changes.tokens.length === 0 || stack.preBuild.includes("token-sync")) {
            return stack;
        }
        return { ...stack, preBuild: [...stack.preBuild, "token-sync"] };
    }

    // map -------------------------------------------------------------------------------------

    private nextMap(
        plan: Plan,
        screens: PlanScreen[],
        built: Map<string, string[]>,
        previous: BuildMap | null,
        commit: string | null
    ): BuildMap {
        const boards: BuildMap["boards"] = {};
        const screenById = new Map(screens.map((screen) => [screen.boardId, screen]));
        for (const [boardId, board] of Object.entries(plan.boards)) {
            const screen = screenById.get(boardId);
            const before = previous?.boards[boardId];
            const isScreen = screen !== undefined && screen.status !== "removed";
            boards[boardId] = {
                name: board.name,
                hash: board.hash,
                route: isScreen ? screen.route : (before?.route ?? null),
                files: built.get(boardId) ?? (before?.files ?? []).filter((file) => this.git.exists(file)),
            };
        }
        return {
            schemaVersion: 1,
            builtAt: new Date().toISOString(),
            fileId: plan.fileId,
            commit: commit ?? previous?.commit ?? null,
            boards,
        };
    }

    // helpers ---------------------------------------------------------------------------------

    /**
     * Reports a step. Clients translate by `step` (and `name`/`update`/`detail`); `label` is an
     * English fallback. `detail` (command, stack, workflow id, fix attempt) goes to developers only.
     */
    private step(step: BuildStep, status: "running" | "done" | "error", detail?: string, id?: string): void {
        const payload: Record<string, unknown> = { step, id: id ?? step, label: this.text.step(step, detail), status };
        if (detail !== undefined && this.text.isDeveloper) {
            payload.detail = detail;
        }
        this.ctx.emit("progress", payload);
    }

    private log(text: string): void {
        if (this.text.isDeveloper) {
            this.ctx.emit("log", { text });
        }
    }

    /** Owner board of every file that belongs to exactly one screen of a build map. */
    private static owners(map: BuildMap): Map<string, string> {
        const count = new Map<string, number>();
        const owner = new Map<string, string>();
        for (const [boardId, entry] of Object.entries(map.boards)) {
            for (const file of entry.files) {
                count.set(file, (count.get(file) ?? 0) + 1);
                owner.set(file, boardId);
            }
        }
        return new Map([...owner].filter(([file]) => count.get(file) === 1));
    }

    private static applyRoutes(screens: PlanScreen[], routes: Record<string, string> | undefined): PlanScreen[] {
        if (!routes) {
            return screens;
        }
        const taken = new Routes(
            screens.filter((screen) => routes[screen.boardId] === undefined).map((screen) => screen.route)
        );
        return screens.map((screen) =>
            routes[screen.boardId] === undefined || screen.status === "removed"
                ? screen
                : { ...screen, route: taken.claim(routes[screen.boardId], screen.name) }
        );
    }

    /** Normalizes a path Claude reported to a forward-slash path inside `app-src/`, or null. */
    private static normalizePath(file: string): string | null {
        const clean = file
            .replace(/\\/g, "/")
            .replace(/^\.\//, "")
            .replace(/^app-src\//, "");
        if (
            clean.length === 0 ||
            clean.startsWith("/") ||
            /^[A-Za-z]:/.test(clean) ||
            clean.split("/").includes("..")
        ) {
            return null;
        }
        return clean;
    }

    private static stackExample(stack: Stack): Omit<Stack, "platform" | "schemaVersion" | "preBuild"> {
        const { platform: _platform, schemaVersion: _version, preBuild: _preBuild, ...rest } = stack;
        return rest;
    }

    private static firstLine(message: string): string {
        return message.length > 200 ? `${message.slice(0, 197)}...` : message;
    }
}
