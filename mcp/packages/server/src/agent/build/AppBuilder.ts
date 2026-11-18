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
        const screens = AppBuilder.applyRoutes(plan.screens, overrides.data.routes);

        this.step("prepare", "running");
        await this.git.ensureIgnores();
        this.step("prepare", "done");

        let stack = plan.stack;
        // pre-build workflows work on the app: on a full build they run once it is scaffolded
        if (!full) {
            await this.runPreBuild(stack);
        }
        const start = await this.git.snapshot();
        if (full) {
            stack = await this.scaffold(plan, screens, overrides.data);
            await this.runPreBuild(stack);
        }
        this.themeNote = await TokenThemeNote.forBuild(this.ctx.workspace);

        const targets = screens.filter((screen) =>
            full ? screen.status !== "removed" : screen.status === "new" || screen.status === "changed"
        );
        const owners = map === null ? new Map<string, string>() : AppBuilder.owners(map);
        const built = new Map<string, string[]>();
        for (const screen of targets) {
            const previous = map?.boards[screen.boardId]?.files ?? [];
            built.set(screen.boardId, await this.buildScreen(plan, screens, screen, previous, owners, overrides.data));
        }
        const removed = screens.filter((screen) => screen.status === "removed");
        if (removed.length > 0) {
            await this.removeScreens(removed, map!);
        }

        await this.installAndCheck(stack, full || (await this.dependenciesChanged(start)));

        this.step("save", "running");
        const names = targets.map((screen) => screen.name);
        const message = full
            ? `penforge(build): build ${names.join(", ")}`
            : `penforge(build): update ${[...names, ...removed.map((s) => `remove ${s.name}`)].join(", ")}`;
        const commit = await this.ctx.workspace.commitAll("app-src", AppBuilder.firstLine(message));
        await this.files.writeMap(this.nextMap(plan, screens, built, map, commit));
        this.step("save", "done");

        this.ctx.emit("result", {
            planId: plan.planId,
            mode: plan.mode,
            commit,
            screens: names,
            removed: removed.map((screen) => screen.name),
            preview: true,
        });
        return {
            summary: this.text.isDeveloper
                ? `Built ${names.length} screen(s) with ${stack.name}${commit ? `; commit ${commit.slice(0, 10)}` : ""}.`
                : "Your app is ready.",
        };
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
        return result;
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
