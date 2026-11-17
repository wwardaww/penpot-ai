import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { z } from "zod";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { StackCommand } from "./StackCommand";

/**
 * Command of a stack, as an argument vector run by the daemon in `app-src/`; see
 * {@link StackCommand} for the rules and the trust boundary. `{port}` is replaced by the dev
 * server port (W09).
 */
export const CommandSchema = z.array(z.string()).superRefine((argv, ctx) => {
    const problem = StackCommand.problem(argv);
    if (problem !== null) {
        ctx.addIssue({ code: "custom", message: problem });
    }
});

/** Stack of the generated app (`.penforge/stack.json`, see `wiki/architecture.md` §4). */
export const StackSchema = z.object({
    schemaVersion: z.literal(1).default(1),
    platform: z.enum(["web", "mobile"]),
    /** human name, e.g. "React + Vite + TypeScript" */
    name: z.string().min(1).max(120),
    /** main versions, e.g. "react 19, vite 6" */
    version: z.string().max(120).default(""),
    packageManager: z.enum(StackCommand.PROGRAMS).default("npm"),
    commands: z.object({
        install: CommandSchema,
        build: CommandSchema,
        typecheck: CommandSchema.optional(),
        dev: CommandSchema,
    }),
    /** environment variable the dev server reads its port from */
    portEnv: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .default("PORT"),
    /** `commands.dev` as one shell command, the form W09's dev server manager reads */
    dev: z.string().optional(),
    /** path the dev server answers on once ready (W09) */
    readyPath: z
        .string()
        .regex(/^\/\S*$/)
        .default("/"),
    /** workflow ids run before each build (W21 adds "token-sync") */
    preBuild: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
});

export type Stack = z.infer<typeof StackSchema>;

/** Screen of a plan: one top-level board turned into one route. */
export const PlanScreenSchema = z.object({
    boardId: z.string().min(1),
    name: z.string().min(1).max(120),
    route: z.string().regex(/^\/[A-Za-z0-9/_:-]*$/),
    /** status against the last build */
    status: z.enum(["new", "changed", "removed", "same"]).default("new"),
});

export type PlanScreen = z.infer<typeof PlanScreenSchema>;

/** Reusable component of a plan. */
export const PlanComponentSchema = z.object({
    name: z.string().min(1).max(120),
    purpose: z.string().max(400).default(""),
});

export type PlanComponent = z.infer<typeof PlanComponentSchema>;

/** Build mode: everything, only what changed, or nothing to do. */
export const BuildModeSchema = z.enum(["full", "incremental", "none"]);

export type BuildMode = z.infer<typeof BuildModeSchema>;

/** Plan written by `build-plan` and read by `build-run` (`.penforge/plan.json`). */
export const PlanSchema = z.object({
    schemaVersion: z.literal(1),
    planId: z.string().min(1),
    createdAt: z.string(),
    fileId: z.string(),
    mode: BuildModeSchema,
    platform: z.enum(["web", "mobile"]),
    summary: z.string(),
    stack: StackSchema,
    screens: z.array(PlanScreenSchema),
    components: z.array(PlanComponentSchema),
    tree: z.string(),
    notes: z.string(),
    /** every top-level board at plan time (name and design hash), by board id */
    boards: z.record(z.string(), z.object({ name: z.string(), hash: z.string() })),
    /** board-to-board navigation of the prototype */
    navigation: z.array(z.object({ from: z.string(), to: z.string(), trigger: z.string(), sourceName: z.string() })),
});

export type Plan = z.infer<typeof PlanSchema>;

/** Last build of one board (`.penforge/map.json`). */
export const MapBoardSchema = z.object({
    name: z.string(),
    hash: z.string(),
    /** route of the screen; null for boards that are not screens */
    route: z.string().nullable(),
    /** files of the screen, relative to `app-src/`, forward slashes */
    files: z.array(z.string()),
});

export type MapBoard = z.infer<typeof MapBoardSchema>;

/** Mapping of the last build: board id → screen files (`.penforge/map.json`). */
export const BuildMapSchema = z.object({
    schemaVersion: z.literal(1),
    builtAt: z.string(),
    fileId: z.string(),
    commit: z.string().nullable(),
    boards: z.record(z.string(), MapBoardSchema),
});

export type BuildMap = z.infer<typeof BuildMapSchema>;

/**
 * Store of the build pipeline's files in `.penforge/`: `plan.md`, `plan.json`, `stack.json` and
 * `map.json`.
 *
 * Every read validates the content; an invalid file counts as missing, so a broken file leads to a
 * full rebuild instead of a failure.
 */
export class BuildFiles {
    public static readonly PLAN_MD = "plan.md";
    public static readonly PLAN_JSON = "plan.json";
    public static readonly STACK_JSON = "stack.json";
    public static readonly MAP_JSON = "map.json";

    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    public readPlan(): Promise<Plan | null> {
        return this.read(BuildFiles.PLAN_JSON, PlanSchema);
    }

    public async writePlan(plan: Plan, markdown: string): Promise<void> {
        await this.workspace.writeJson(BuildFiles.PLAN_JSON, plan);
        await this.writeText(BuildFiles.PLAN_MD, markdown);
    }

    public readStack(): Promise<Stack | null> {
        return this.read(BuildFiles.STACK_JSON, StackSchema);
    }

    public writeStack(stack: Stack): Promise<void> {
        // arguments are shell-safe tokens, so joining them gives a valid shell command
        return this.workspace.writeJson(BuildFiles.STACK_JSON, { ...stack, dev: stack.commands.dev.join(" ") });
    }

    public readMap(): Promise<BuildMap | null> {
        return this.read(BuildFiles.MAP_JSON, BuildMapSchema);
    }

    public writeMap(map: BuildMap): Promise<void> {
        return this.workspace.writeJson(BuildFiles.MAP_JSON, map);
    }

    private async read<T>(name: string, schema: z.ZodType<T>): Promise<T | null> {
        let raw: unknown;
        try {
            raw = await this.workspace.readJson<unknown>(name, null);
        } catch {
            return null;
        }
        if (raw === null) {
            return null;
        }
        const parsed = schema.safeParse(raw);
        return parsed.success ? parsed.data : null;
    }

    private async writeText(name: string, content: string): Promise<void> {
        const file = this.workspace.resolve(join(this.workspace.metaDir, name));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, "utf8");
    }
}
