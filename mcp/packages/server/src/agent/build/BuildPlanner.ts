import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { WorkflowContext, WorkflowResult } from "@penpot/mcp-common";
import {
    BuildFiles,
    type BuildMap,
    type BuildMode,
    type Plan,
    PlanComponentSchema,
    type PlanScreen,
    type Stack,
    StackSchema,
} from "./BuildFiles";
import { BuildError } from "./BuildError";
import { BuildLock } from "./BuildLock";
import { BuildText } from "./BuildText";
import { type DesignBoard, DesignReader, type DesignSnapshot } from "./DesignReader";
import { JsonReply } from "./JsonReply";
import { Routes } from "./Routes";

/** Params of `build-plan`. */
export interface BuildPlanParams {
    /** "full" plans a build from scratch even when an earlier build exists */
    mode?: "auto" | "full";
    /**
     * Asks "Build it?" as a workflow question and reports the answer as `result {confirmed}`
     * (default; W09's Build chain). False when the client shows the plan and confirms itself by
     * running `build-run` (W08 build dialog).
     */
    ask?: boolean;
}

/** Payload of the `plan` event (see `wiki/architecture.md` §7, build pipeline). */
export interface PlanEventPayload {
    planId: string;
    mode: BuildMode;
    summary: string;
    question: string;
    options: { id: string; label: string }[];
    screens: { boardId: string; name: string; status: PlanScreen["status"] }[];
    /** technical part, only for developers */
    developer?: {
        stack: Stack;
        tree: string;
        routes: { boardId: string; name: string; route: string }[];
        components: { name: string; purpose: string }[];
        notes: string;
    };
}

/**
 * Planner of an app build (`build-plan` workflow).
 *
 * Reads the design, compares it with the last build (`.penforge/map.json`) and decides the mode:
 * a full build (first build, or asked for) is planned by Claude; an incremental build or "nothing
 * to do" is planned without Claude from the board hashes. Writes `.penforge/plan.json`,
 * `plan.md` and `stack.json`, then emits the `plan` event in the persona's language and a
 * `result` event `{planId, mode}`. Confirmation is the client's next step (`build-run`).
 */
export class BuildPlanner {
    /** Reply Claude gives to the planning turn. */
    private static readonly ReplySchema = z.object({
        summary: z.string().min(1),
        stack: StackSchema.omit({ platform: true, schemaVersion: true }).extend({
            preBuild: z.array(z.string()).optional(),
        }),
        screens: z
            .array(
                z.object({
                    boardId: z.string(),
                    name: z.string().optional(),
                    route: z.string().optional(),
                })
            )
            .default([]),
        components: z.array(PlanComponentSchema).default([]),
        tree: z.string().default(""),
        notes: z.string().default(""),
    });

    private readonly text: BuildText;
    private readonly files: BuildFiles;

    constructor(
        private readonly ctx: WorkflowContext,
        private readonly reader: DesignReader = new DesignReader(ctx.tools)
    ) {
        this.text = new BuildText(ctx.context.persona);
        this.files = new BuildFiles(ctx.workspace);
    }

    public async plan(params: BuildPlanParams = {}): Promise<WorkflowResult> {
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

    private async run(params: BuildPlanParams): Promise<WorkflowResult> {
        this.progress("read", "running");
        const design = await this.reader.read();
        this.progress("read", "done");
        if (design.boards.length === 0) {
            throw new BuildError(this.text.noBoards(), "no-boards");
        }
        const map = await this.files.readMap();
        const stack = await this.files.readStack();
        const hasApp = existsSync(join(this.ctx.workspace.appSrcDir, "package.json"));
        const fresh = params.mode === "full" || map === null || stack === null || !hasApp;

        let plan = fresh ? await this.fullPlan(design, stack) : this.incrementalPlan(design, map!, stack!);
        await this.publish(plan);
        if (params.ask === false) {
            this.ctx.emit("result", { planId: plan.planId, mode: plan.mode });
            return { summary: plan.mode === "none" ? this.text.nothingChanged() : plan.summary };
        }
        for (;;) {
            const payload = this.payload(plan);
            const answer = await this.ctx.ask({ text: this.questionText(plan, payload), options: payload.options });
            if (answer === "rebuild") {
                plan = await this.fullPlan(design, plan.stack);
                await this.publish(plan);
                continue;
            }
            const confirmed = answer === "build";
            this.ctx.emit("result", { planId: plan.planId, mode: plan.mode, confirmed });
            return { summary: confirmed ? plan.summary : this.text.notNow() };
        }
    }

    /** Writes the plan files and emits the `plan` event. */
    private async publish(plan: Plan): Promise<void> {
        await this.files.writePlan(plan, this.markdown(plan));
        await this.files.writeStack(plan.stack);
        this.ctx.emit("plan", this.payload(plan));
    }

    /** Text of the "Build it?" question: the summary, technical details for developers, the question. */
    private questionText(plan: Plan, payload: PlanEventPayload): string {
        const parts = [plan.summary];
        if (payload.developer && plan.mode !== "none") {
            const routes = payload.developer.routes.map((r) => `- ${r.name} → \`${r.route}\``);
            parts.push(`**Stack:** ${plan.stack.name}`, ["**Routes:**", ...routes].join("\n"));
        }
        parts.push(`**${payload.question}**`);
        return parts.join("\n\n");
    }

    // planning --------------------------------------------------------------------------------

    private async fullPlan(design: DesignSnapshot, previous: Stack | null): Promise<Plan> {
        this.progress("plan", "running");
        const prompt = this.planPrompt(design, previous);
        let result = await this.ctx.runner.run({ prompt, promptName: "build-plan" });
        let reply = JsonReply.parse(result.text, BuildPlanner.ReplySchema);
        if (reply === null && !this.ctx.signal.aborted) {
            result = await this.ctx.runner.run({
                prompt:
                    "Your reply did not end with a valid ```json block in the required shape. " +
                    "Reply again with only that block.",
                promptName: "build-plan",
                resumeSessionId: result.sessionId,
            });
            reply = JsonReply.parse(result.text, BuildPlanner.ReplySchema);
        }
        if (reply === null) {
            throw new BuildError(this.text.planFailed(), "plan-failed");
        }
        this.progress("plan", "done");

        const stack = StackSchema.parse({
            ...reply.stack,
            platform: this.ctx.context.platform,
            preBuild: previous?.preBuild ?? reply.stack.preBuild?.filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id)) ?? [],
        });
        const screens = this.planScreens(design, reply.screens);
        return {
            schemaVersion: 1,
            planId: randomUUID(),
            createdAt: new Date().toISOString(),
            fileId: this.ctx.context.fileId,
            mode: "full",
            platform: this.ctx.context.platform,
            summary: reply.summary.trim(),
            stack,
            screens,
            components: reply.components,
            tree: reply.tree,
            notes: reply.notes,
            boards: BuildPlanner.boards(design.boards),
            navigation: design.edges,
        };
    }

    private incrementalPlan(design: DesignSnapshot, map: BuildMap, stack: Stack): Plan {
        const routes = new Routes(Object.values(map.boards).flatMap((entry) => (entry.route ? [entry.route] : [])));
        const screens: PlanScreen[] = [];
        for (const board of design.boards) {
            const known = map.boards[board.id];
            if (known === undefined) {
                screens.push({ boardId: board.id, name: board.name, route: routes.next(board.name), status: "new" });
            } else if (known.route !== null) {
                const status = known.hash === board.hash ? "same" : "changed";
                screens.push({ boardId: board.id, name: board.name, route: known.route, status });
            }
        }
        const present = new Set(design.boards.map((board) => board.id));
        for (const [boardId, entry] of Object.entries(map.boards)) {
            if (!present.has(boardId) && entry.route !== null) {
                screens.push({ boardId, name: entry.name, route: entry.route, status: "removed" });
            }
        }
        const names = (status: PlanScreen["status"]) => screens.filter((s) => s.status === status).map((s) => s.name);
        const work = screens.some((screen) => screen.status !== "same");
        return {
            schemaVersion: 1,
            planId: randomUUID(),
            createdAt: new Date().toISOString(),
            fileId: this.ctx.context.fileId,
            mode: work ? "incremental" : "none",
            platform: this.ctx.context.platform,
            summary: work
                ? this.text.incrementalSummary(names("changed"), names("new"), names("removed"))
                : this.text.nothingChanged(),
            stack,
            screens,
            components: [],
            tree: "",
            notes: "",
            boards: BuildPlanner.boards(design.boards),
            navigation: design.edges,
        };
    }

    /** Screens of a full plan: Claude's choice of boards, with safe and unique routes. */
    private planScreens(
        design: DesignSnapshot,
        proposed: { boardId: string; name?: string; route?: string }[]
    ): PlanScreen[] {
        const boards = new Map(design.boards.map((board) => [board.id, board]));
        const chosen = proposed.filter((screen, index) => {
            const first = proposed.findIndex((other) => other.boardId === screen.boardId) === index;
            return first && boards.has(screen.boardId);
        });
        const list: { boardId: string; route?: string }[] =
            chosen.length > 0 ? chosen : design.boards.map((board) => ({ boardId: board.id }));
        const start = design.flows.find((flow) => boards.has(flow.startingBoardId))?.startingBoardId;
        const routes = new Routes();
        return list.map((screen) => {
            const board = boards.get(screen.boardId)!;
            const wanted = screen.route ?? (screen.boardId === start ? "/" : undefined);
            return {
                boardId: board.id,
                name: board.name,
                route: routes.claim(wanted, board.name),
                status: "new" as const,
            };
        });
    }

    private planPrompt(design: DesignSnapshot, previous: Stack | null): string {
        const names = new Map(design.boards.map((board) => [board.id, board.name]));
        const boards = design.boards.map((board) => ({
            boardId: board.id,
            name: board.name,
            page: board.pageName,
            size: `${Math.round(board.width)}×${Math.round(board.height)}`,
        }));
        const navigation = design.edges
            .filter((edge) => names.has(edge.from) && names.has(edge.to))
            .map(
                (edge) => `- ${names.get(edge.from)} → ${names.get(edge.to)} (${edge.trigger} on "${edge.sourceName}")`
            );
        const flows = design.flows.map(
            (flow) => `- flow "${flow.name}" starts at ${names.get(flow.startingBoardId) ?? "?"}`
        );
        return [
            "Plan the app for this design. Look at the boards with the Penpot tools before you decide.",
            "",
            "## Top-level boards",
            "```json",
            JSON.stringify(boards, null, 2),
            "```",
            "",
            "## Navigation (prototype interactions)",
            navigation.length > 0 ? navigation.join("\n") : "- none",
            flows.length > 0 ? flows.join("\n") : "",
            "",
            previous
                ? `## Current stack (keep it unless it cannot work)\n\`\`\`json\n${JSON.stringify(previous, null, 2)}\n\`\`\``
                : "",
        ]
            .filter((line, index, all) => line !== "" || all[index - 1] !== "")
            .join("\n");
    }

    // output ----------------------------------------------------------------------------------

    private payload(plan: Plan): PlanEventPayload {
        const options =
            plan.mode === "none"
                ? [
                      { id: "rebuild", label: "Build everything again" },
                      { id: "cancel", label: "Not now" },
                  ]
                : [
                      { id: "build", label: "Build it" },
                      { id: "cancel", label: "Not now" },
                  ];
        const payload: PlanEventPayload = {
            planId: plan.planId,
            mode: plan.mode,
            summary: plan.summary,
            question: this.text.question(plan.mode),
            options,
            screens: plan.screens.map(({ boardId, name, status }) => ({ boardId, name, status })),
        };
        if (this.text.isDeveloper) {
            payload.developer = {
                stack: plan.stack,
                tree: plan.tree,
                routes: plan.screens
                    .filter((screen) => screen.status !== "removed")
                    .map(({ boardId, name, route }) => ({ boardId, name, route })),
                components: plan.components,
                notes: plan.notes,
            };
        }
        return payload;
    }

    private markdown(plan: Plan): string {
        const lines = [
            `# Build plan`,
            "",
            `- Plan: ${plan.planId}`,
            `- Created: ${plan.createdAt}`,
            `- Mode: ${plan.mode}`,
            `- Platform: ${plan.platform}`,
            `- Stack: ${plan.stack.name}${plan.stack.version ? ` (${plan.stack.version})` : ""}`,
            "",
            "## Summary",
            "",
            plan.summary,
            "",
            "## Screens",
            "",
            ...plan.screens.map((screen) => `- ${screen.name} → \`${screen.route}\` (${screen.status})`),
        ];
        if (plan.components.length > 0) {
            lines.push("", "## Components", "", ...plan.components.map((c) => `- ${c.name}: ${c.purpose}`));
        }
        if (plan.tree.trim().length > 0) {
            lines.push("", "## Folder tree", "", "```", plan.tree.trimEnd(), "```");
        }
        if (plan.notes.trim().length > 0) {
            lines.push("", "## Notes", "", plan.notes.trim());
        }
        return lines.join("\n") + "\n";
    }

    private progress(step: "read" | "plan", status: "running" | "done"): void {
        this.ctx.emit("progress", { step, id: step, label: this.text.step(step), status });
    }

    private static boards(boards: DesignBoard[]): Plan["boards"] {
        return Object.fromEntries(boards.map((board) => [board.id, { name: board.name, hash: board.hash }]));
    }
}
