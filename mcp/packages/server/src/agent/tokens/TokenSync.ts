import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { WorkflowContext, WorkflowResult } from "@penpot/mcp-common";
import { AppSourceGit } from "../build/AppSourceGit";
import { BuildFiles } from "../build/BuildFiles";
import { BuildLock } from "../build/BuildLock";
import { BuildText } from "../build/BuildText";
import { type CommandExecutor, ProcessCommandExecutor } from "../build/CommandExecutor";
import { ensureCheckpoint } from "../checkpoints";
import { DesignTokens, type TokenChanges } from "./DesignTokens";
import { PathCommit } from "./PathCommit";
import { PenpotTokenReader } from "./PenpotTokenReader";
import { ThemeBlock } from "./ThemeBlock";
import { ThemeGenerator } from "./ThemeGenerator";
import { type ThemeEntry, ThemeModel } from "./ThemeModel";
import { ThemeLocator, type ThemeTarget } from "./ThemeTarget";
import { TokenSyncError } from "./TokenSyncError";
import { TokenUsage } from "./TokenUsage";

/** When a sync asks Claude to make the app code use the tokens. */
export type LinkMode = "never" | "auto" | "always";

/** Params of the `token-sync` workflow. */
export interface TokenSyncParams {
    /**
     * Claude pass that replaces hard-coded values with token references: `never` (default),
     * `auto` (when the block is new, when new tokens are unused, or when the code uses none of
     * them) or `always`
     */
    link?: LinkMode;
    /** `watch`: started by the client when tokens change; quiet, skips projects without an app */
    trigger?: "manual" | "watch";
    /** set by `build-run`, which runs this workflow first and holds the project lock */
    preBuild?: boolean;
}

/** How a sync ended. */
export type TokenSyncOutcome = "updated" | "unchanged" | "no-tokens" | "no-app" | "busy";

/** Outcome of the Claude pass. */
export type LinkOutcome = "done" | "none" | "reverted";

/** `result` event of `token-sync`. */
export interface TokenSyncResult {
    outcome: TokenSyncOutcome;
    tokenCount: number;
    /** tokens without a usable value (unresolved references, unknown types) */
    skipped: string[];
    changes: TokenChanges;
    /** theme file relative to `app-src/`, null without an app */
    themeFile: string | null;
    format: string | null;
    themeCreated: boolean;
    themeChanged: boolean;
    /** Claude pass outcome; null when it did not run */
    link: LinkOutcome | null;
    linkedFiles: string[];
    /** tokens the app code does not use yet */
    unused: number;
    commits: { design: string | null; appSrc: string | null };
}

/** Collaborators of a {@link TokenSync}. */
export interface TokenSyncOptions {
    executor?: CommandExecutor;
}

/**
 * Sync of the open file's design tokens to the generated app (`token-sync` workflow, W21).
 *
 * Reads the tokens (active sets resolved), exports them as W3C design tokens to
 * `design/penpot-tokens.json`, writes the generated block of the app's theme file in the stack's
 * format (deterministic, see {@link ThemeGenerator}) and records the file in `stack.json`
 * (`themeFile`, `themeFormat`, `token-sync` in `preBuild`, so every build syncs first). Optionally
 * one Claude turn then replaces hard-coded values in the app with token references; that change is
 * type-checked and undone when it breaks the build. Each repository gets its own commit with
 * only the files the sync wrote.
 */
export class TokenSync {
    /** Export of the tokens in the `design/` repository. */
    public static readonly EXPORT_FILE = "penpot-tokens.json";
    public static readonly WORKFLOW = "token-sync";

    private static readonly CHECK_TIMEOUT_MS = 10 * 60 * 1000;
    private static readonly MAX_LISTED_TOKENS = 150;
    private static readonly MAX_OUTPUT_CHARS = 6000;

    private readonly params: Required<TokenSyncParams>;
    private readonly executor: CommandExecutor;

    constructor(
        private readonly ctx: WorkflowContext,
        params: TokenSyncParams = {},
        options: TokenSyncOptions = {}
    ) {
        const link = params.link === "auto" || params.link === "always" ? params.link : "never";
        this.params = {
            link: params.preBuild === true || params.trigger === "watch" ? "never" : link,
            trigger: params.trigger === "watch" ? "watch" : "manual",
            preBuild: params.preBuild === true,
        };
        this.executor = options.executor ?? new ProcessCommandExecutor();
    }

    /**
     * Runs the sync.
     *
     * Before a build it never fails the build: problems become a `log` line and the build goes on
     * with the theme as it is.
     */
    public async run(): Promise<WorkflowResult> {
        if (!this.params.preBuild) {
            return TokenSyncError.report(this.ctx, () => this.locked());
        }
        try {
            return await this.sync();
        } catch (error) {
            if (this.ctx.signal.aborted) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.log("token-sync-skipped", `Token sync skipped: ${message}`);
            return { summary: `Token sync skipped: ${message}` };
        }
    }

    private async locked(): Promise<WorkflowResult> {
        const release = BuildLock.tryAcquire(this.ctx.workspace.root);
        if (release === null) {
            const result = this.emptyResult("busy");
            this.emit("result", result);
            return { summary: "A build is running; the tokens sync with it." };
        }
        try {
            return await this.sync();
        } finally {
            release();
        }
    }

    private async sync(): Promise<WorkflowResult> {
        const workspace = this.ctx.workspace;
        const stack = await this.readStack();
        const hasApp = stack !== null || existsSync(join(workspace.appSrcDir, "package.json"));
        if (this.params.trigger === "watch" && !hasApp) {
            this.emit("result", this.emptyResult("no-app"));
            return { summary: "No app yet; nothing to sync." };
        }

        this.progress("read-tokens", "running", "Reading the design tokens");
        const tokens = DesignTokens.fromSnapshot(await new PenpotTokenReader(this.ctx.tools).read());
        this.progress("read-tokens", "done", "Reading the design tokens");

        const { changes, commit: designCommit } = await this.exportTokens(tokens);
        const result: TokenSyncResult = {
            ...this.emptyResult("unchanged"),
            tokenCount: tokens.tokens.length,
            skipped: tokens.skipped,
            changes,
            commits: { design: designCommit, appSrc: null },
        };
        if (!hasApp || tokens.isEmpty) {
            result.outcome = hasApp ? "no-tokens" : "no-app";
            this.emit("result", result);
            return { summary: TokenSync.summary(result) };
        }

        this.progress("theme", "running", "Updating the app theme");
        const target = await ThemeLocator.locate(workspace.appSrcDir, stack);
        const generator = ThemeGenerator.create(target.format, target.module, target.quote);
        const model = ThemeModel.build(tokens);
        const body = generator.render(model);
        const hadBlock = target.exists && ThemeBlock.has(target.text);
        const text = ThemeBlock.write(target.text, body, generator.comment, TokenSync.prologue(target));
        result.themeFile = target.file;
        result.format = target.format;
        result.themeCreated = !target.exists;
        result.themeChanged = text !== target.text;
        if (result.themeChanged) {
            await this.writeAppFile(target.file, text);
        }
        if (stack !== null) {
            await this.recordTheme(stack, target);
        }
        result.commits.appSrc = await new PathCommit(workspace.appSrcDir).commit(
            [target.file],
            `penforge(token-sync): update ${target.file} from the design tokens`
        );
        this.progress("theme", "done", "Updating the app theme");

        let unused = await TokenUsage.unused(workspace.appSrcDir, model, generator);
        if (this.shouldLink(hadBlock, unused, model, changes)) {
            const linked = await this.link(target, generator, body, unused);
            result.link = linked.outcome;
            result.linkedFiles = linked.files;
            result.commits.appSrc = linked.commit ?? result.commits.appSrc;
            if (linked.outcome === "done") {
                unused = await TokenUsage.unused(workspace.appSrcDir, model, generator);
            }
        }
        result.unused = unused.length;

        const designChanged = designCommit !== null;
        result.outcome = result.themeChanged || designChanged || result.link === "done" ? "updated" : "unchanged";
        this.emit("result", result);
        return { summary: TokenSync.summary(result) };
    }

    // steps -----------------------------------------------------------------------------------

    /** Writes `design/penpot-tokens.json` and commits it alone. */
    private async exportTokens(tokens: DesignTokens): Promise<{ changes: TokenChanges; commit: string | null }> {
        const path = this.ctx.workspace.resolve(join(this.ctx.workspace.designDir, TokenSync.EXPORT_FILE));
        let previous: unknown = null;
        try {
            previous = JSON.parse(await readFile(path, "utf8"));
        } catch {
            previous = null;
        }
        const changes = tokens.changesSince(previous);
        if (tokens.isEmpty && previous === null) {
            return { changes, commit: null };
        }
        this.progress("export", "running", "Saving the tokens");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(tokens.toDtcg(), null, 2) + "\n", "utf8");
        const commit = await new PathCommit(this.ctx.workspace.designDir).commit(
            [TokenSync.EXPORT_FILE],
            `penforge(token-sync): export ${tokens.tokens.length} design tokens`
        );
        this.progress("export", "done", "Saving the tokens");
        return { changes, commit };
    }

    /** Records the theme file in `stack.json` and adds `token-sync` to its `preBuild` list. */
    private async recordTheme(stack: Record<string, unknown>, target: ThemeTarget): Promise<void> {
        const preBuild = Array.isArray(stack.preBuild) ? stack.preBuild.filter((id) => typeof id === "string") : [];
        const next = {
            ...stack,
            themeFile: target.file,
            themeFormat: target.format,
            preBuild: preBuild.includes(TokenSync.WORKFLOW) ? preBuild : [...preBuild, TokenSync.WORKFLOW],
        };
        if (JSON.stringify(next) !== JSON.stringify(stack)) {
            await this.ctx.workspace.writeJson(BuildFiles.STACK_JSON, next);
        }
    }

    private shouldLink(hadBlock: boolean, unused: ThemeEntry[], model: ThemeModel, changes: TokenChanges): boolean {
        if (this.params.link === "never" || unused.length === 0) {
            return false;
        }
        if (this.params.link === "always") {
            return true;
        }
        const added = new Set(changes.added);
        return (
            !hadBlock || unused.length === model.entries.length || unused.some((entry) => added.has(entry.token.name))
        );
    }

    /**
     * Claude pass: one turn replaces hard-coded values with token references, the generated block
     * is put back if Claude touched it, then the app is type-checked (one fix turn); a change that
     * still fails is undone.
     */
    private async link(
        target: ThemeTarget,
        generator: ThemeGenerator,
        body: string[],
        unused: ThemeEntry[]
    ): Promise<{ outcome: LinkOutcome; files: string[]; commit: string | null }> {
        await ensureCheckpoint(this.ctx, "Before using the design tokens in the code", TokenSync.WORKFLOW);
        this.progress("link", "running", "Using the tokens in the code");
        const git = new AppSourceGit(this.ctx.workspace.appSrcDir);
        const before = await git.snapshot();
        let session: string | undefined;
        const turn = async (prompt: string) => {
            if (this.ctx.signal.aborted) {
                throw new Error("cancelled");
            }
            const answer = await this.ctx.runner.run({
                prompt,
                promptName: TokenSync.WORKFLOW,
                resumeSessionId: session,
            });
            session = answer.sessionId ?? session;
        };
        await turn(this.linkPrompt(target, generator, unused));
        await this.restoreBlock(target, generator, body);
        let changed = await git.changedFiles(before, await git.snapshot());
        this.progress("link", "done", "Using the tokens in the code");
        if (changed.length === 0) {
            return { outcome: "none", files: [], commit: null };
        }

        const failure = await this.typecheck();
        if (failure !== null) {
            this.log("typecheck-failed", `Type check failed after using the tokens:\n${failure}`);
            await turn(TokenSync.fixPrompt(failure));
            await this.restoreBlock(target, generator, body);
            changed = await git.changedFiles(before, await git.snapshot());
            const again = await this.typecheck();
            if (again !== null) {
                await git.restore(before, changed);
                this.log("link-reverted", "The code changes still failed the type check and were undone.");
                return { outcome: "reverted", files: [], commit: null };
            }
        }
        const commit = await new PathCommit(this.ctx.workspace.appSrcDir).commit(
            changed,
            "penforge(token-sync): use the design tokens in the code"
        );
        return { outcome: "done", files: changed, commit };
    }

    /** Puts the generated block back when Claude changed it. */
    private async restoreBlock(target: ThemeTarget, generator: ThemeGenerator, body: string[]): Promise<void> {
        const path = this.ctx.workspace.resolve(join(this.ctx.workspace.appSrcDir, target.file));
        let current = "";
        try {
            current = await readFile(path, "utf8");
        } catch {
            current = "";
        }
        let fixed: string;
        try {
            fixed = ThemeBlock.write(current, body, generator.comment, TokenSync.prologue(target));
        } catch {
            // markers broken by the edit: start again from the file without any marker line
            const clean = current
                .split(/\r?\n/)
                .filter((line) => !line.includes(ThemeBlock.BEGIN) && !line.includes(ThemeBlock.END))
                .join("\n");
            fixed = ThemeBlock.write(clean, body, generator.comment, TokenSync.prologue(target));
        }
        if (fixed !== current) {
            await writeFile(path, fixed, "utf8");
            this.log("block-restored", "Claude changed the generated token block; it was regenerated.");
        }
    }

    /**
     * Runs the stack's type check (`commands.typecheck`) when dependencies are installed.
     *
     * @returns the end of the output on failure, null when it passed or could not run
     */
    private async typecheck(): Promise<string | null> {
        const stack = await new BuildFiles(this.ctx.workspace).readStack();
        const command = stack?.commands.typecheck;
        if (!command || !existsSync(join(this.ctx.workspace.appSrcDir, "node_modules"))) {
            return null;
        }
        this.progress("check", "running", "Checking the app");
        const outcome = await this.executor.execute(command, {
            cwd: this.ctx.workspace.appSrcDir,
            signal: this.ctx.signal,
            timeoutMs: TokenSync.CHECK_TIMEOUT_MS,
        });
        this.progress("check", "done", "Checking the app");
        return outcome.code === 0 ? null : BuildText.tail(outcome.output, TokenSync.MAX_OUTPUT_CHARS);
    }

    // prompts ---------------------------------------------------------------------------------

    private linkPrompt(target: ThemeTarget, generator: ThemeGenerator, unused: ThemeEntry[]): string {
        const listed = unused.slice(0, TokenSync.MAX_LISTED_TOKENS).map((entry) => {
            const value = TokenSync.describe(entry);
            return `- \`${generator.reference(entry)}\` = ${value} (Penpot token "${entry.token.name}")`;
        });
        if (unused.length > listed.length) {
            listed.push(`- … and ${unused.length - listed.length} more (see the block)`);
        }
        return [
            "## Step: use the design tokens in the app code",
            "",
            `The theme file \`app-src/${target.file}\` holds a generated block between the`,
            `\`${ThemeBlock.BEGIN}\` and \`${ThemeBlock.END}\` comments with the design tokens of the`,
            `Penpot file (format: ${target.format}).`,
            "",
            "Tokens the code does not use yet:",
            ...listed,
        ].join("\n");
    }

    private static fixPrompt(output: string): string {
        return [
            "## Step: fix the type check",
            "",
            "The type check of the app failed after your change. Fix the cause without removing the",
            "token references and without editing the generated block. Do not run commands.",
            "",
            "Output (last part):",
            "```",
            output,
            "```",
        ].join("\n");
    }

    private static describe(entry: ThemeEntry): string {
        const value = entry.token.value;
        switch (value.kind) {
            case "typography":
                return JSON.stringify(value.value);
            case "shadow":
                return JSON.stringify(value.value);
            case "fontFamily":
                return value.value.join(", ");
            default:
                return String(value.value);
        }
    }

    // helpers ---------------------------------------------------------------------------------

    private static prologue(target: ThemeTarget): "js" | "css" {
        return target.format === "css" || target.format === "tailwind" ? "css" : "js";
    }

    private async readStack(): Promise<Record<string, unknown> | null> {
        try {
            const raw = await this.ctx.workspace.readJson<unknown>(BuildFiles.STACK_JSON, null);
            return typeof raw === "object" && raw !== null && !Array.isArray(raw)
                ? (raw as Record<string, unknown>)
                : null;
        } catch {
            return null;
        }
    }

    private async writeAppFile(file: string, text: string): Promise<void> {
        const path = this.ctx.workspace.resolve(join(this.ctx.workspace.appSrcDir, file));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, "utf8");
    }

    private emptyResult(outcome: TokenSyncOutcome): TokenSyncResult {
        return {
            outcome,
            tokenCount: 0,
            skipped: [],
            changes: { added: [], changed: [], removed: [] },
            themeFile: null,
            format: null,
            themeCreated: false,
            themeChanged: false,
            link: null,
            linkedFiles: [],
            unused: 0,
            commits: { design: null, appSrc: null },
        };
    }

    /**
     * Sends an event; before a build only `log` lines go out, so the build's own progress and
     * result stay the only ones its client sees.
     */
    private emit(kind: string, payload: unknown): void {
        if (!this.params.preBuild || kind === "log") {
            this.ctx.emit(kind, payload);
        }
    }

    private progress(step: string, status: "running" | "done", text: string): void {
        this.emit("progress", { step, status, text });
    }

    private log(code: string, text: string): void {
        if (this.ctx.context.persona === "developer") {
            this.ctx.emit("log", { code, text });
        }
    }

    /** English fallback of the run's summary (clients word it from the `result` payload). */
    public static summary(result: TokenSyncResult): string {
        switch (result.outcome) {
            case "busy":
                return "A build is running; the tokens sync with it.";
            case "no-app":
                return result.tokenCount > 0
                    ? `Saved ${result.tokenCount} design tokens; the app gets them when it is built.`
                    : "No app yet; nothing to sync.";
            case "no-tokens":
                return "The file has no design tokens to sync yet.";
            case "unchanged":
                return `The app theme already matches the ${result.tokenCount} design tokens.`;
            case "updated": {
                const parts = [`Updated ${result.themeFile} from ${result.tokenCount} design tokens.`];
                if (result.link === "done") {
                    parts.push(`The code now uses them in ${result.linkedFiles.length} file(s).`);
                } else if (result.link === "reverted") {
                    parts.push("Using them in the code broke the type check, so that change was undone.");
                }
                return parts.join(" ");
            }
        }
    }
}
