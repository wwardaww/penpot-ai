import { readFile } from "fs/promises";
import { join } from "path";
import type { Attachment, Platform, Workflow, WorkflowContext } from "@penpot/mcp-common";
import {
    type BoardInspection,
    type CreatedBoard,
    type DesignSystemSnapshot,
    createBoardCode,
    inspectBoardCode,
    readDesignSystemCode,
} from "./generate-screen.snippets";

/** Params of the `generate-screen` workflow (camelCase on the wire). */
export interface GenerateScreenParams {
    /** what to design, in the user's words */
    prompt: string;
    /** platform of the screen; defaults to the project platform of the tab */
    platform?: Platform;
    /** page to put the screen on; defaults to the tab's current page */
    targetPageId?: string;
    /** layers the new screen should follow (style, structure) */
    referenceNodeIds?: string[];
}

/** Payload of the `result` event of a run. */
export interface GenerateScreenResult {
    boardId: string;
    pageId: string;
    name: string;
    platform: Platform;
    width: number;
    height: number;
    inspection: BoardInspection;
    /** problems the self-review could not fix */
    remainingIssues: string[];
    /** Claude's description of the screen */
    notes: string;
}

/** Board size of a new screen. */
export interface ScreenFrame {
    label: string;
    width: number;
    height: number;
    /** horizontal guide offsets (safe areas), relative to the board */
    guides: number[];
}

/** Board per platform (architecture §8): desktop for web, iPhone with safe areas for mobile. */
export const SCREEN_FRAMES: Record<Platform, ScreenFrame> = {
    web: { label: "Desktop", width: 1440, height: 1024, guides: [] },
    mobile: { label: "iPhone", width: 390, height: 844, guides: [47, 844 - 34] },
};

/** Space between the new board and the layers already on the page. */
export const BOARD_GAP = 200;

/** Longest prompt accepted. */
export const MAX_PROMPT_LENGTH = 4000;

/** Longest DESIGN.md excerpt put into the prompt. */
export const MAX_DESIGN_MD_CHARS = 16000;

/** Most reference layers accepted. */
export const MAX_REFERENCES = 10;

/** Name of the W19 workflow that saves a checkpoint, used when it is registered. */
export const CHECKPOINT_WORKFLOW = "checkpoint-create";

/** Services of the workflow that tests replace. */
export interface GenerateScreenDeps {
    /** Gets a registered workflow by name. */
    findWorkflow(name: string): Promise<Workflow<any> | undefined>;
    /** Reads the project's `design/DESIGN.md`, or null when there is none. */
    readDesignMd(ctx: WorkflowContext): Promise<string | null>;
}

const defaultDeps: GenerateScreenDeps = {
    async findWorkflow(name) {
        // lazy: `index.ts` imports this module
        const shipped = (await import("./index")) as Record<string, Workflow<any>>;
        return Object.values(shipped).find((workflow) => workflow?.name === name);
    },
    async readDesignMd(ctx) {
        try {
            return await readFile(join(ctx.workspace.designDir, "DESIGN.md"), "utf8");
        } catch {
            return null;
        }
    },
};

/** Params of a run after {@link parseParams}. */
export interface ParsedParams {
    prompt: string;
    platform: Platform;
    targetPageId: string | undefined;
    referenceNodeIds: string[];
}

/**
 * Normalizes and checks the params of a run.
 *
 * @param raw - params as received
 * @param defaultPlatform - the project platform of the tab
 * @throws Error when the prompt is missing or a value has the wrong type
 */
export function parseParams(raw: unknown, defaultPlatform: Platform | undefined): ParsedParams {
    const params = (raw ?? {}) as Record<string, unknown>;
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    if (prompt.length === 0) {
        throw new Error("generate-screen needs a non-empty prompt");
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new Error(`The prompt is too long (max ${MAX_PROMPT_LENGTH} characters)`);
    }
    const platform = params.platform ?? defaultPlatform ?? "web";
    if (platform !== "web" && platform !== "mobile") {
        throw new Error(`Unknown platform ${JSON.stringify(platform)}`);
    }
    const targetPageId = params.targetPageId;
    if (targetPageId !== undefined && targetPageId !== null && typeof targetPageId !== "string") {
        throw new Error("targetPageId must be a string");
    }
    const references = params.referenceNodeIds ?? [];
    if (!Array.isArray(references) || references.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new Error("referenceNodeIds must be a list of node ids");
    }
    return {
        prompt,
        platform,
        targetPageId: targetPageId || undefined,
        referenceNodeIds: [...new Set(references as string[])].slice(0, MAX_REFERENCES),
    };
}

/**
 * Picks the position of the new board: right of everything on the page, top-aligned with it.
 */
export function placeBoard(snapshot: Pick<DesignSystemSnapshot, "freeX" | "topY">): { x: number; y: number } {
    if (snapshot.freeX === null) {
        return { x: 0, y: 0 };
    }
    return { x: Math.round(snapshot.freeX + BOARD_GAP), y: Math.round(snapshot.topY ?? 0) };
}

/**
 * Name the board carries until Claude renames it: "Draft" and the first words of the prompt.
 */
export function provisionalName(prompt: string): string {
    const words = prompt
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4);
    const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    return `Draft ${name || "Screen"}`.slice(0, 40);
}

/**
 * Describes the design system for the prompt, as compact Markdown.
 */
export function describeDesignSystem(snapshot: DesignSystemSnapshot, designMd: string | null): string {
    const lines: string[] = ["## Design system of this file"];
    const path = (item: { path: string; name: string }) => (item.path ? `${item.path} / ${item.name}` : item.name);
    const library = (name: string) => (name === "local" ? "" : ` [library ${name}]`);

    if (snapshot.components.length > 0) {
        lines.push("", "Components (use these before drawing anything):");
        for (const c of snapshot.components) {
            lines.push(`- ${path(c)} (id ${c.id})${library(c.library)}`);
        }
    } else {
        lines.push("", "Components: none.");
    }
    if (snapshot.tokens.length > 0) {
        lines.push("", "Tokens of the active sets (name: type = value):");
        for (const t of snapshot.tokens) {
            lines.push(`- ${t.name}: ${t.type} = ${t.value ?? "?"}`);
        }
    } else {
        lines.push("", "Tokens: none.");
    }
    if (snapshot.colors.length > 0) {
        lines.push("", "Library colors:");
        for (const c of snapshot.colors) {
            const opacity = c.opacity !== null && c.opacity !== 1 ? ` @${c.opacity}` : "";
            lines.push(`- ${path(c)} = ${c.color ?? "gradient"}${opacity} (id ${c.id})${library(c.library)}`);
        }
    }
    if (snapshot.typographies.length > 0) {
        lines.push("", "Library typographies:");
        for (const t of snapshot.typographies) {
            lines.push(
                `- ${path(t)}: ${t.fontFamily} ${t.fontSize}/${t.lineHeight} weight ${t.fontWeight} ` +
                    `(id ${t.id})${library(t.library)}`
            );
        }
    }
    if (snapshot.truncated) {
        lines.push("", "(Some lists were cut; read the library with execute_code when you need more.)");
    }
    if (designMd && designMd.trim().length > 0) {
        const text =
            designMd.length > MAX_DESIGN_MD_CHARS ? `${designMd.slice(0, MAX_DESIGN_MD_CHARS)}\n…(cut)` : designMd;
        lines.push("", "## DESIGN.md of the project (rules to follow)", "", text.trim());
    }
    return lines.join("\n");
}

/**
 * Builds the request of the build turn.
 */
export function buildRequest(args: {
    prompt: string;
    platform: Platform;
    board: CreatedBoard;
    frame: ScreenFrame;
    designSystem: string;
    hasReferences: boolean;
}): string {
    const { prompt, board, frame } = args;
    const lines = [
        `Design this screen: ${prompt}`,
        "",
        `The empty screen board is ready: boardId ${board.boardId} on pageId ${board.pageId}, ` +
            `${frame.label} ${board.width}×${board.height}, vertical flex layout, white fill. ` +
            `Build everything inside it.`,
    ];
    if (frame.guides.length > 0) {
        lines.push(`Safe-area guides at y = ${frame.guides.join(" and ")} px.`);
    }
    if (args.hasReferences) {
        lines.push("Follow the look and structure of the attached reference layers.");
    }
    lines.push("", args.designSystem);
    return lines.join("\n");
}

/**
 * Lists what the self-review should fix, from the inspection of the board.
 */
export function reviewIssues(
    inspection: BoardInspection,
    snapshot: Pick<DesignSystemSnapshot, "components" | "tokens" | "colors">,
    provisional: string
): string[] {
    const issues: string[] = [];
    const list = (names: string[]) =>
        names
            .slice(0, 12)
            .map((name) => `"${name}"`)
            .join(", ") + (names.length > 12 ? ` and ${names.length - 12} more` : "");
    if (inspection.layerCount === 0) {
        issues.push("The screen board is empty: build the screen inside it.");
        return issues;
    }
    if (inspection.name.trim() === provisional) {
        issues.push("Rename the screen board to a short screen name.");
    }
    if (inspection.genericNames.length > 0) {
        issues.push(`Rename these layers after their role: ${list(inspection.genericNames)}.`);
    }
    if (inspection.containersWithoutLayout.length > 0) {
        issues.push(`Give these boards a flex layout: ${list(inspection.containersWithoutLayout)}.`);
    }
    if (inspection.absoluteLayerCount > 0) {
        issues.push(
            `${inspection.absoluteLayerCount} layer(s) use absolute position inside a flex layout; ` +
                "make them flow with the layout."
        );
    }
    if (snapshot.components.length > 0 && inspection.instanceCount === 0) {
        issues.push(
            "The file has components but the screen uses none: replace drawn elements with " +
                "instances of matching components."
        );
    }
    if (snapshot.tokens.length > 0 && inspection.tokenizedLayerCount === 0) {
        issues.push("The file has tokens but none is applied: apply color, spacing and radius tokens.");
    }
    const hasColorSystem = snapshot.colors.length > 0 || snapshot.tokens.some((t) => t.type === "color");
    if (hasColorSystem && inspection.rawColorFillCount > 0) {
        issues.push(
            `${inspection.rawColorFillCount} fill(s) use raw colors; use color tokens or library colors instead.`
        );
    }
    return issues;
}

/**
 * Builds the request of the review turn.
 */
export function buildReviewRequest(issues: string[], hasScreenshot: boolean): string {
    const lines = [
        hasScreenshot
            ? "Here is a screenshot of the screen board as it is now. Review it once:"
            : "Review the screen board once (no screenshot could be taken):",
        "- layout: alignment, spacing rhythm, nothing clipped or overlapping, nothing squeezed;",
        "- hierarchy: one clear primary action, readable text sizes and contrast;",
        "- design system: components, tokens and library styles used where they exist.",
    ];
    if (issues.length > 0) {
        lines.push("", "An automatic check also found:", ...issues.map((issue) => `- ${issue}`));
    }
    lines.push(
        "",
        "Fix what is wrong in one pass with small edits; do not rebuild the screen. " +
            "Then end with the same JSON line as before."
    );
    return lines.join("\n");
}

/**
 * Reads the final JSON line of a Claude answer (`{"boardId": …, "name": …}`).
 *
 * @returns the line's fields and the answer without that line
 */
export function parseAnswer(text: string): { boardId?: string; name?: string; notes: string } {
    const lines = text.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
        const line = lines[i].trim().replace(/^`+|`+$/g, "");
        if (!line.startsWith("{") || !line.includes("boardId")) {
            continue;
        }
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            return {
                boardId: typeof parsed.boardId === "string" ? parsed.boardId : undefined,
                name: typeof parsed.name === "string" ? parsed.name : undefined,
                notes: lines.slice(0, i).join("\n").trim(),
            };
        } catch {
            break;
        }
    }
    return { notes: text.trim() };
}

/**
 * Runs Plugin API code through `execute_code` and returns its result.
 *
 * @throws Error when the tool reports an error or the output is not JSON
 */
export async function executeCode<T>(ctx: WorkflowContext, code: string): Promise<T> {
    const result = await ctx.tools.call("execute_code", { code });
    if (result.isError) {
        throw new Error(result.text || "execute_code failed");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(result.text);
    } catch {
        throw new Error(`Unexpected execute_code output: ${result.text.slice(0, 200)}`);
    }
    // the plugin answers `{result, log}`
    if (parsed !== null && typeof parsed === "object" && "result" in parsed && "log" in parsed) {
        return (parsed as { result: T }).result;
    }
    return parsed as T;
}

/**
 * Takes a screenshot of the board for the review turn.
 *
 * @returns the image attachment, or null when the capture failed
 */
async function screenshot(ctx: WorkflowContext, boardId: string): Promise<Attachment | null> {
    try {
        const result = await ctx.tools.call("capture_node_screenshot", { nodeId: boardId, scale: 1, format: "jpeg" });
        if (result.isError) {
            return null;
        }
        const image = result.content.find((block: any) => block?.type === "image") as
            { data: string; mimeType: string } | undefined;
        return image ? { kind: "image", mime: image.mimeType, base64: image.data } : null;
    } catch {
        return null;
    }
}

/**
 * Saves a checkpoint through the W19 workflow when it is registered.
 *
 * @returns true when a checkpoint was saved
 */
async function checkpoint(ctx: WorkflowContext, deps: GenerateScreenDeps, label: string): Promise<boolean> {
    const create = await deps.findWorkflow(CHECKPOINT_WORKFLOW);
    if (!create) {
        return false;
    }
    try {
        await create.run(ctx, { label, workflow: "generate-screen" });
        return true;
    } catch (error) {
        ctx.emit("log", { text: `Checkpoint failed: ${error instanceof Error ? error.message : String(error)}` });
        return false;
    }
}

function throwIfAborted(ctx: WorkflowContext): void {
    if (ctx.signal.aborted) {
        throw new Error("cancelled");
    }
}

/**
 * Creates the workflow with its services.
 *
 * Steps: read the design system (library, tokens, DESIGN.md) and the free space of the page, save a
 * checkpoint, create the empty board sized for the platform, let Claude build the screen, inspect
 * the board and screenshot it, let Claude fix what the review finds (once), and report the result.
 */
export function createGenerateScreenWorkflow(deps: GenerateScreenDeps = defaultDeps): Workflow<GenerateScreenParams> {
    return {
        name: "generate-screen",
        description: "Design a new screen on the canvas from a prompt, with the file's design system.",
        run: async (ctx, raw) => {
            const params = parseParams(raw, ctx.context.platform);
            const frame = SCREEN_FRAMES[params.platform];

            ctx.emit("progress", { text: "Reading the design system" });
            const snapshot = await executeCode<DesignSystemSnapshot>(
                ctx,
                readDesignSystemCode({
                    pageId: params.targetPageId ?? ctx.context.pageId,
                    referenceNodeIds: params.referenceNodeIds,
                })
            );
            const designMd = await deps.readDesignMd(ctx);
            throwIfAborted(ctx);

            await checkpoint(ctx, deps, "Before generating a screen");
            throwIfAborted(ctx);

            ctx.emit("progress", { text: "Creating the board" });
            const name = provisionalName(params.prompt);
            const board = await executeCode<CreatedBoard>(
                ctx,
                createBoardCode({
                    pageId: snapshot.page.id,
                    name,
                    ...placeBoard(snapshot),
                    width: frame.width,
                    height: frame.height,
                    guides: frame.guides,
                })
            );
            ctx.emit("plan", { boardId: board.boardId, pageId: board.pageId, platform: params.platform });
            throwIfAborted(ctx);

            ctx.emit("progress", { text: "Designing the screen" });
            const attachments: Attachment[] = snapshot.references.map((ref) => ({
                kind: "node",
                fileId: snapshot.fileId ?? ctx.context.fileId,
                pageId: ref.pageId,
                nodeId: ref.id,
                name: ref.name,
                type: ref.type,
            }));
            const build = await ctx.runner.run({
                prompt: buildRequest({
                    prompt: params.prompt,
                    platform: params.platform,
                    board,
                    frame,
                    designSystem: describeDesignSystem(snapshot, designMd),
                    hasReferences: attachments.length > 0,
                }),
                attachments: attachments.length > 0 ? attachments : undefined,
            });
            throwIfAborted(ctx);

            ctx.emit("progress", { text: "Checking the result" });
            const inspection = await executeCode<BoardInspection>(ctx, inspectBoardCode({ boardId: board.boardId }));
            if (!inspection.found) {
                throw new Error("The screen board was removed while it was being designed");
            }
            const issues = reviewIssues(inspection, snapshot, name);
            const image = await screenshot(ctx, board.boardId);
            throwIfAborted(ctx);

            ctx.emit("progress", { text: "Polishing the screen" });
            const review = await ctx.runner.run({
                prompt: buildReviewRequest(issues, image !== null),
                resumeSessionId: build.sessionId,
                attachments: image ? [image] : undefined,
            });
            throwIfAborted(ctx);

            const final = await executeCode<BoardInspection>(ctx, inspectBoardCode({ boardId: board.boardId }));
            if (!final.found) {
                throw new Error("The screen board was removed while it was being designed");
            }
            const answer = parseAnswer(review.text);
            const notes = answer.notes || parseAnswer(build.text).notes;
            const result: GenerateScreenResult = {
                boardId: board.boardId,
                pageId: board.pageId,
                name: final.name,
                platform: params.platform,
                width: final.width,
                height: final.height,
                inspection: final,
                remainingIssues: reviewIssues(final, snapshot, name),
                notes,
            };
            ctx.emit("result", result);
            return { summary: summarize(final) };
        },
    };
}

/**
 * One-line summary of a generated screen, for `workflow.done`.
 */
export function summarize(inspection: BoardInspection): string {
    const parts = [`Created "${inspection.name}" (${Math.round(inspection.width)}×${Math.round(inspection.height)})`];
    const details: string[] = [];
    if (inspection.instanceCount > 0) {
        details.push(`${inspection.instanceCount} component instance${inspection.instanceCount === 1 ? "" : "s"}`);
    }
    if (inspection.tokenNames.length > 0) {
        details.push(`${inspection.tokenNames.length} token${inspection.tokenNames.length === 1 ? "" : "s"}`);
    }
    if (details.length > 0) {
        parts.push(`using ${details.join(" and ")}`);
    }
    return parts.join(" ");
}

export const workflow = createGenerateScreenWorkflow();
