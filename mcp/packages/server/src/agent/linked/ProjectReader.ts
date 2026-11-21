import { readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { join } from "path";
import type { LinkedProjectKind, WorkflowContext } from "@penpot/mcp-common";
import { DesignMdRepository } from "../designmd/DesignMdRepository";
import { LinkedProjectPrompt } from "./LinkedProjectPrompt";
import { LinkedToolFilter } from "./LinkedToolFilter";
import { LinkedWorkspace } from "./LinkedWorkspace";
import type { ProjectLink } from "./ProjectLink";
import { type SourceChanges, type SourceIndex, SourceInventory } from "./SourceInventory";

/** Params of the `project-read` workflow. */
export interface ProjectReadParams {
    /** read every file again and write a new brief ("Read project again") */
    force?: boolean;
}

/** Payload of the `result` event of `project-read`. */
export interface ProjectReadResult {
    state: "ready" | "unchanged" | "not-linked";
    reason?: "none" | "missing";
    kind: LinkedProjectKind | null;
    engine: ProjectLink["engine"];
    stack: ProjectLink["stack"];
    files: number;
    changed: number;
    skipped: number;
    truncated: boolean;
    /** the folder's DESIGN.md was copied into the project's `design/` repository (W22) */
    designMd?: "copied";
}

/**
 * Background read of a linked folder (W38 workflow `project-read`).
 *
 * Step 1 (no Claude): {@link SourceInventory} into `.penforge/source-index.json`. Step 2 (Claude
 * with Read, Glob and Grep inside the folder only): `.penforge/project-brief.md`, written from
 * Claude's answer. A later run with no changed file and an existing brief stops after step 1;
 * a run with changes asks Claude to update the brief from the changed files only. One read per
 * project at a time; a second request waits and then finds nothing changed.
 */
export class ProjectReader {
    /** files Claude is asked to read fully at most */
    public static readonly READ_BUDGET = 60;
    /** files listed in the prompt at most */
    public static readonly LISTED_FILES = 400;
    public static readonly INDEX_FILE = "source-index.json";

    private static readonly running = new Map<string, Promise<unknown>>();

    constructor(private readonly ctx: WorkflowContext) {}

    /**
     * Runs the read.
     *
     * @param params - the workflow params
     */
    public async run(params: ProjectReadParams): Promise<ProjectReadResult> {
        const key = this.ctx.workspace.root;
        const previous = ProjectReader.running.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(() => this.read(params.force === true));
        ProjectReader.running.set(key, next);
        const forget = () => {
            if (ProjectReader.running.get(key) === next) {
                ProjectReader.running.delete(key);
            }
        };
        next.then(forget, forget);
        return next;
    }

    private async read(force: boolean): Promise<ProjectReadResult> {
        const ctx = this.ctx;
        const folder = LinkedWorkspace.of(ctx);
        if (folder.state === "not-linked") {
            return {
                state: "not-linked",
                reason: folder.reason,
                kind: folder.link?.kind ?? ProjectReader.kindOf(ctx),
                engine: folder.link?.engine ?? null,
                stack: folder.link?.stack ?? null,
                files: 0,
                changed: 0,
                skipped: 0,
                truncated: false,
            };
        }
        const { link, root } = folder;
        this.progress("inventory", { done: 0 }, "Listing the project's files");
        const index = await new SourceInventory(root, link.kind, link.engine).build((done) =>
            this.progress("inventory", { done }, `Listed ${done} files`)
        );
        this.checkCancelled();
        const before = await ctx.workspace.readJson<SourceIndex | null>(ProjectReader.INDEX_FILE, null);
        const sameRoot = before !== null && before.root === index.root && before.kind === index.kind;
        const changes = SourceInventory.changes(sameRoot ? before : null, index);
        const changedCount = changes.added.length + changes.changed.length + changes.removed.length;
        const briefFile = join(ctx.workspace.metaDir, LinkedProjectPrompt.BRIEF_FILE);
        const oldBrief = await readFile(briefFile, "utf8").catch(() => null);
        const designMd = link.kind === "existing" ? await this.copyDesignMd(root) : false;
        const skipped = index.skipped.folders + index.skipped.ignored + index.skipped.tooBig + index.skipped.overBudget;
        const base = {
            kind: link.kind,
            engine: link.engine,
            stack: link.stack,
            files: index.files.length,
            changed: changedCount,
            skipped,
            truncated: index.truncated,
            ...(designMd ? { designMd: "copied" as const } : {}),
        };
        if (!force && oldBrief !== null && oldBrief.trim().length > 0 && changedCount === 0) {
            await ctx.workspace.writeJson(ProjectReader.INDEX_FILE, index);
            return { state: "unchanged", ...base };
        }
        const update = !force && sameRoot && oldBrief !== null && oldBrief.trim().length > 0;
        const total = Math.min(
            update ? changes.added.length + changes.changed.length : index.files.length,
            ProjectReader.READ_BUDGET
        );
        let done = 0;
        this.progress("read", { done, total }, "Reading the project");
        const answer = await ctx.runner.run({
            prompt: update
                ? this.updatePrompt(link, root, index, changes, oldBrief!)
                : this.firstPrompt(link, root, index),
            promptName: "project-read",
            toolFilter: new LinkedToolFilter(ctx.workspace.root, [root], null, false),
            onEvent: (event) => {
                if (event.kind === "tool" && event.toolName === "Read" && event.status === "done") {
                    done = Math.min(done + 1, total);
                    this.progress("read", { done, total }, `Read ${done} of ${total} files`);
                }
            },
        });
        this.checkCancelled();
        const brief = ProjectReader.cleanBrief(answer.text);
        if (brief.length < 40) {
            throw new Error("Claude did not write a project brief");
        }
        this.progress("brief", {}, "Writing the project brief");
        await this.writeBrief(briefFile, `${brief}\n\n${ProjectReader.skippedSection(index)}\n`);
        await ctx.workspace.writeJson(ProjectReader.INDEX_FILE, index);
        return { state: "ready", ...base };
    }

    private firstPrompt(link: ProjectLink, root: string, index: SourceIndex): string {
        return [
            `Read the ${ProjectReader.describe(link)} in \`${root}\` and write its project brief.`,
            "",
            `Files to read, in priority order (read at most ${ProjectReader.READ_BUDGET} fully: Markdown first, then UI,`,
            "screen and style files; use Grep and Glob for the rest):",
            ProjectReader.fileList(
                index.files.map((file) => file),
                index.files.length
            ),
        ].join("\n");
    }

    private updatePrompt(
        link: ProjectLink,
        root: string,
        index: SourceIndex,
        changes: SourceChanges,
        oldBrief: string
    ): string {
        const byPath = new Map(index.files.map((file) => [file.path, file]));
        const touched = [...changes.added, ...changes.changed].map((path) => byPath.get(path)!).filter(Boolean);
        return [
            `Files of the ${ProjectReader.describe(link)} in \`${root}\` changed since the last read. Update`,
            "the project brief below: read only the changed files, keep what still holds, and answer with",
            "the whole updated brief.",
            "",
            "Changed or new files:",
            ProjectReader.fileList(touched, touched.length),
            ...(changes.removed.length > 0
                ? ["", "Removed files:", ...changes.removed.slice(0, 100).map((path) => `- ${path}`)]
                : []),
            "",
            "Current brief:",
            "````markdown",
            oldBrief.replace(/````/g, "```").trim(),
            "````",
        ].join("\n");
    }

    private static fileList(files: SourceIndex["files"], total: number): string {
        const lines = files
            .slice(0, ProjectReader.LISTED_FILES)
            .map(
                (file) =>
                    `- ${file.path} (${file.kind}${file.hash === null ? ", name only: do not read" : `, ${file.size} B`})`
            );
        if (total > ProjectReader.LISTED_FILES) {
            lines.push(`- …and ${total - ProjectReader.LISTED_FILES} more files (list them with Glob when needed)`);
        }
        return lines.length > 0 ? lines.join("\n") : "- (no file)";
    }

    private static describe(link: ProjectLink): string {
        if (link.kind === "game") {
            return link.engine === "unreal" ? "Unreal Engine 5 game" : "Unity game";
        }
        return link.stack ? `${link.stack.name} ${link.stack.platform} app` : "app";
    }

    /** Copies the folder's DESIGN.md into the project's `design/` repository once (W22 reads it there). */
    private async copyDesignMd(root: string): Promise<boolean> {
        const source = join(root, "DESIGN.md");
        let text: string;
        try {
            const info = await stat(source);
            if (!info.isFile() || info.size > 1024 * 1024) {
                return false;
            }
            text = await readFile(source, "utf8");
        } catch {
            return false;
        }
        const repository = new DesignMdRepository(this.ctx.workspace);
        if ((await repository.read()) !== null) {
            return false;
        }
        await repository.write(DesignMdRepository.normalize(text));
        await repository.commit("import DESIGN.md of the linked project").catch(() => null);
        return true;
    }

    private async writeBrief(file: string, text: string): Promise<void> {
        const target = this.ctx.workspace.resolve(file);
        const temp = `${target}.tmp-${randomUUID()}`;
        await writeFile(temp, text, "utf8");
        try {
            await rename(temp, target);
        } catch (error) {
            await unlink(temp).catch(() => undefined);
            throw error;
        }
    }

    /** Takes the Markdown out of Claude's answer (a fenced block when there is one). */
    private static cleanBrief(text: string): string {
        const fenced = /````?markdown\n([\s\S]*?)\n````?/i.exec(text);
        return (fenced ? fenced[1] : text).trim();
    }

    private static skippedSection(index: SourceIndex): string {
        const { folders, ignored, tooBig, overBudget } = index.skipped;
        return [
            "## Skipped by the reader",
            `- ${folders} dependency, build, cache or engine folders; ${ignored} paths from .gitignore.`,
            `- ${tooBig} files over 1 MB; ${overBudget} files over the read budget.`,
            ...(index.truncated ? ["- The folder is very big: only part of it was listed."] : []),
            `- ${index.files.length} files listed; Claude read the most important ones fully.`,
        ].join("\n");
    }

    private static kindOf(ctx: WorkflowContext): LinkedProjectKind | null {
        const type = ctx.context.projectType;
        return type === "game" || type === "existing" ? type : null;
    }

    private progress(step: "inventory" | "read" | "brief", params: Record<string, number>, text: string): void {
        this.ctx.emit("progress", { step, params, text });
    }

    private checkCancelled(): void {
        if (this.ctx.signal.aborted) {
            throw new Error("cancelled");
        }
    }
}
