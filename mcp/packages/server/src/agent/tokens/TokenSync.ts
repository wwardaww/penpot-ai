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
import { type ManifestToken, TokenManifest, type TokenManifestData } from "./TokenManifest";
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

/**
 * How a sync ended: `updated`/`unchanged`; nothing to do (`no-tokens`, `no-app`, `no-theme`:
 * the app has no theme file); `busy` (a build runs); `selection-changed` (other token sets are
 * active than the ones the app follows; only a manual sync switches); `block-edited` (the block
 * was edited by hand and the user kept it, or nobody could be asked).
 */
export type TokenSyncOutcome =
    "updated" | "unchanged" | "no-tokens" | "no-app" | "no-theme" | "busy" | "selection-changed" | "block-edited";

/** Outcome of the Claude pass. */
export type LinkOutcome = "done" | "none" | "reverted";

/** `result` event of `token-sync`. */
export interface TokenSyncResult {
    outcome: TokenSyncOutcome;
    tokenCount: number;
    /** tokens without a resolved value */
    skipped: string[];
    /** tokens whose name or value cannot go into code safely */
    refused: string[];
    changes: TokenChanges;
    /** theme file relative to `app-src/`, null when none */
    themeFile: string | null;
    format: string | null;
    themeChanged: boolean;
    /** tokens no longer in Penpot that stay in the block because the code uses them */
    deprecated: string[];
    /** Claude pass outcome; null when it did not run */
    link: LinkOutcome | null;
    linkedFiles: string[];
    /** tokens the app code does not use yet */
    unused: number;
    /** files the sync changed but did not commit because they held other uncommitted edits */
    uncommitted: string[];
    /** active sets now, and the sets the app follows (differ for `selection-changed`) */
    activeSets: string[];
    followedSets: string[];
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
 * `design/penpot-tokens.json`, and writes the generated block of the app's theme file in the
 * stack's format (deterministic, see {@link ThemeGenerator}). The theme follows the token sets
 * chosen by the last manual sync (`.penforge/token-theme.json`), so looking at another theme in
 * Penpot does not rewrite the app. Code names stay stable; tokens that left Penpot stay while the
 * code uses them; hand edits of the block are never overwritten without asking. A JS theme is
 * type-checked after a change and put back when the check fails. The file is recorded in
 * `stack.json` (`themeFile`, `themeFormat`, `token-sync` in `preBuild`). Optionally one Claude
 * turn replaces hard-coded values with token references (type-checked, undone on failure).
 * Commits hold only the files the sync wrote, and never a file with other uncommitted edits.
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

    /** Tells whether nobody can be asked (watcher and pre-build runs follow the recorded choices). */
    private get unattended(): boolean {
        return this.params.preBuild || this.params.trigger === "watch";
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
            return this.finish(TokenSync.emptyResult("busy"));
        }
        try {
            return await this.sync();
        } finally {
            release();
        }
    }

    private async sync(): Promise<WorkflowResult> {
        const workspace = this.ctx.workspace;
        // an app exists once the build scaffolded it (a plan alone has no files yet)
        const hasApp = existsSync(join(workspace.appSrcDir, "package.json"));
        if (this.params.trigger === "watch" && !hasApp) {
            return this.finish(TokenSync.emptyResult("no-app"));
        }

        this.progress("read-tokens", "running", "Reading the design tokens");
        const tokens = DesignTokens.fromSnapshot(await new PenpotTokenReader(this.ctx.tools).read());
        this.progress("read-tokens", "done", "Reading the design tokens");

        const manifest = await TokenManifest.read(workspace);
        const result: TokenSyncResult = {
            ...TokenSync.emptyResult("unchanged"),
            tokenCount: tokens.tokens.length,
            skipped: tokens.skipped,
            refused: tokens.refused.map((token) => token.name),
            activeSets: tokens.activeSets,
            followedSets: manifest?.sets ?? tokens.activeSets,
        };
        if (manifest !== null && this.unattended && !TokenSync.sameList(manifest.sets, tokens.activeSets)) {
            // another theme is only being looked at in Penpot: the app keeps following its sets
            result.outcome = "selection-changed";
            return this.finish(result);
        }

        const { changes, commit: designCommit } = await this.exportTokens(tokens);
        result.changes = changes;
        result.commits.design = designCommit;
        if (!hasApp || tokens.isEmpty) {
            result.outcome = hasApp ? "no-tokens" : "no-app";
            return this.finish(result);
        }

        const stack = await this.readStack();
        const target = await ThemeLocator.locate(workspace.appSrcDir, stack);
        if (target === null) {
            result.outcome = "no-theme";
            return this.finish(result);
        }
        result.themeFile = target.file;
        result.format = target.format;
        if (!(await this.blockMayChange(target, manifest))) {
            result.outcome = "block-edited";
            return this.finish(result);
        }

        this.progress("theme", "running", "Updating the app theme");
        const generator = ThemeGenerator.create(target.format, target.module, target.objectName);
        const previous = manifest?.tokens ?? new Map<string, ManifestToken>();
        let usage = await TokenUsage.load(workspace.appSrcDir);
        const kept = ThemeModel.removed(tokens, previous).filter((entry) => usage.uses(entry, generator));
        const model = ThemeModel.build(tokens, previous, kept);
        const body = generator.render(model);
        const hadBlock = ThemeBlock.has(target.text);
        const text = ThemeBlock.write(target.text, body, generator.comment, TokenSync.prologue(target));
        result.deprecated = kept.map((entry) => entry.token.name);
        result.themeChanged = text !== target.text;

        const commit = new PathCommit(workspace.appSrcDir);
        const dirtyBefore = await commit.dirty([target.file]);
        if (result.themeChanged) {
            await this.writeAppFile(target.file, text);
            const failure = TokenSync.isJs(target) ? await this.typecheck() : null;
            if (failure !== null) {
                // put the file back as it was: the sync's own change broke the app
                await this.writeAppFile(target.file, target.text);
                this.log("typecheck-failed", `Type check failed after the token update:\n${failure}`);
                throw new TokenSyncError(
                    "theme-check-failed",
                    `The app did not type-check with the new tokens in ${target.file}, so the theme was left as it was.`
                );
            }
        }
        if (dirtyBefore.has(target.file)) {
            result.uncommitted = result.themeChanged ? [target.file] : [];
        } else {
            result.commits.appSrc = await commit.commit(
                [target.file],
                `penforge(token-sync): update ${target.file} from the design tokens`
            );
        }
        if (stack !== null) {
            await this.recordTheme(stack, target);
        }
        await this.saveManifest(target, model, tokens, text);
        this.progress("theme", "done", "Updating the app theme");

        let unused = usage.unused(
            model.entries.filter((entry) => !entry.deprecated),
            generator
        );
        if (this.shouldLink(hadBlock, unused, model, changes)) {
            const linked = await this.link(target, generator, body, unused);
            result.link = linked.outcome;
            result.linkedFiles = linked.files;
            result.uncommitted.push(...linked.uncommitted);
            result.commits.appSrc = linked.commit ?? result.commits.appSrc;
            if (linked.outcome === "done") {
                usage = await TokenUsage.load(workspace.appSrcDir);
                unused = usage.unused(
                    model.entries.filter((entry) => !entry.deprecated),
                    generator
                );
            }
        }
        result.unused = unused.length;
        result.outcome =
            result.themeChanged || designCommit !== null || result.link === "done" ? "updated" : "unchanged";
        return this.finish(result);
    }

    // steps -----------------------------------------------------------------------------------

    /**
     * Tells whether the block may be rewritten: yes when it is as the last sync wrote it (or
     * new); after hand edits only when the user says so in a manual run.
     */
    private async blockMayChange(target: ThemeTarget, manifest: TokenManifestData | null): Promise<boolean> {
        const block = ThemeBlock.extract(target.text);
        const edited =
            block !== null &&
            manifest !== null &&
            manifest.file === target.file &&
            manifest.blockHash.length > 0 &&
            TokenManifest.hash(block) !== manifest.blockHash;
        if (!edited) {
            return true;
        }
        if (this.unattended) {
            return false;
        }
        const answer = await this.ctx.ask({
            text: `The design token part of ${target.file} was edited by hand. Replace it with the tokens from Penpot?`,
            options: [
                { id: "replace", label: "Replace it" },
                { id: "keep", label: "Keep my edits" },
            ],
        });
        return answer === "replace";
    }

    /** Writes `design/penpot-tokens.json` and commits it alone (unless it had other edits). */
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
        const repo = new PathCommit(this.ctx.workspace.designDir);
        const dirty = await repo.dirty([TokenSync.EXPORT_FILE]);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(tokens.toDtcg(), null, 2) + "\n", "utf8");
        const commit = dirty.has(TokenSync.EXPORT_FILE)
            ? null
            : await repo.commit(
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

    private async saveManifest(
        target: ThemeTarget,
        model: ThemeModel,
        tokens: DesignTokens,
        text: string
    ): Promise<void> {
        const entries = new Map<string, ManifestToken>();
        for (const entry of model.entries) {
            entries.set(entry.token.name, {
                type: entry.token.type,
                category: entry.category,
                key: entry.key,
                cssName: entry.cssName,
                value: entry.token.value,
            });
        }
        await TokenManifest.write(this.ctx.workspace, {
            schemaVersion: 1,
            file: target.file,
            format: target.format,
            objectName: target.objectName,
            sets: tokens.activeSets,
            themes: tokens.activeThemes,
            blockHash: TokenManifest.hash(ThemeBlock.extract(text) ?? ""),
            tokens: entries,
        });
    }

    private shouldLink(hadBlock: boolean, unused: ThemeEntry[], model: ThemeModel, changes: TokenChanges): boolean {
        if (this.params.link === "never" || unused.length === 0) {
            return false;
        }
        if (this.params.link === "always") {
            return true;
        }
        const added = new Set(changes.added);
        const current = model.entries.filter((entry) => !entry.deprecated);
        return !hadBlock || unused.length === current.length || unused.some((entry) => added.has(entry.token.name));
    }

    /**
     * Claude pass: one turn replaces hard-coded values with token references, the generated block
     * is put back if Claude touched it, then the app is type-checked (one fix turn); a change that
     * still fails is undone. Files that had other uncommitted edits before are left uncommitted.
     */
    private async link(
        target: ThemeTarget,
        generator: ThemeGenerator,
        body: string[],
        unused: ThemeEntry[]
    ): Promise<{ outcome: LinkOutcome; files: string[]; commit: string | null; uncommitted: string[] }> {
        await ensureCheckpoint(this.ctx, "Before using the design tokens in the code", TokenSync.WORKFLOW);
        this.progress("link", "running", "Using the tokens in the code");
        const repo = new PathCommit(this.ctx.workspace.appSrcDir);
        const dirtyBefore = await repo.dirty(["."]);
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
        await this.restoreBlock(target, generator, body, git, before);
        let changed = await git.changedFiles(before, await git.snapshot());
        this.progress("link", "done", "Using the tokens in the code");
        if (changed.length === 0) {
            return { outcome: "none", files: [], commit: null, uncommitted: [] };
        }

        const failure = await this.typecheck();
        if (failure !== null) {
            this.log("typecheck-failed", `Type check failed after using the tokens:\n${failure}`);
            await turn(TokenSync.fixPrompt(failure));
            await this.restoreBlock(target, generator, body, git, before);
            changed = await git.changedFiles(before, await git.snapshot());
            const again = await this.typecheck();
            if (again !== null) {
                await git.restore(before, changed);
                this.log("link-reverted", "The code changes still failed the type check and were undone.");
                return { outcome: "reverted", files: [], commit: null, uncommitted: [] };
            }
        }
        const clean = changed.filter((file) => !dirtyBefore.has(file));
        const commit = await repo.commit(clean, "penforge(token-sync): use the design tokens in the code");
        return {
            outcome: "done",
            files: changed,
            commit,
            uncommitted: changed.filter((file) => dirtyBefore.has(file)),
        };
    }

    /**
     * Puts the generated block back when Claude changed it. When Claude broke a marker, the theme
     * file goes back to its state before the turn and gets the block again.
     */
    private async restoreBlock(
        target: ThemeTarget,
        generator: ThemeGenerator,
        body: string[],
        git: AppSourceGit,
        snapshot: string
    ): Promise<void> {
        const path = this.ctx.workspace.resolve(join(this.ctx.workspace.appSrcDir, target.file));
        const read = async () => {
            try {
                return await readFile(path, "utf8");
            } catch {
                return "";
            }
        };
        let current = await read();
        let fixed: string;
        try {
            fixed = ThemeBlock.write(current, body, generator.comment, TokenSync.prologue(target));
        } catch {
            await git.restore(snapshot, [target.file]);
            this.log("block-restored", `Claude broke the token block markers; ${target.file} was put back.`);
            current = await read();
            fixed = ThemeBlock.write(current, body, generator.comment, TokenSync.prologue(target));
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
            return `- \`${generator.reference(entry)}\` = ${value} (Penpot token ${JSON.stringify(entry.token.name)})`;
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
        return TokenSync.isJs(target) ? "js" : "css";
    }

    private static isJs(target: ThemeTarget): boolean {
        return target.format === "react-native" || target.format === "js-web";
    }

    private static sameList(a: string[], b: string[]): boolean {
        return a.length === b.length && a.every((item, index) => item === b[index]);
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
        if (ThemeLocator.kind(this.ctx.workspace.appSrcDir, file) === "link") {
            throw new TokenSyncError("unsafe-theme-path", `${file} is a link`);
        }
        const path = this.ctx.workspace.resolve(join(this.ctx.workspace.appSrcDir, file));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, "utf8");
    }

    private static emptyResult(outcome: TokenSyncOutcome): TokenSyncResult {
        return {
            outcome,
            tokenCount: 0,
            skipped: [],
            refused: [],
            changes: { added: [], changed: [], removed: [] },
            themeFile: null,
            format: null,
            themeChanged: false,
            deprecated: [],
            link: null,
            linkedFiles: [],
            unused: 0,
            uncommitted: [],
            activeSets: [],
            followedSets: [],
            commits: { design: null, appSrc: null },
        };
    }

    /** Emits the result and gives the run's summary. */
    private finish(result: TokenSyncResult): WorkflowResult {
        this.emit("result", result);
        if (result.refused.length > 0) {
            this.log("tokens-refused", `Tokens left out (unsafe name or value): ${result.refused.join(", ")}`);
        }
        return { summary: TokenSync.summary(result) };
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
        const parts: string[] = [];
        switch (result.outcome) {
            case "busy":
                return "A build is running; it syncs the tokens itself.";
            case "no-app":
                return result.tokenCount > 0
                    ? `Saved ${result.tokenCount} design tokens; the app gets them when it is built.`
                    : "No app yet; nothing to sync.";
            case "no-tokens":
                return "The file has no design tokens to sync yet.";
            case "no-theme":
                return "The app has no theme file to put the tokens in yet.";
            case "selection-changed":
                return "Other token sets are active than the ones the app follows; the app theme was left as it is.";
            case "block-edited":
                return `The token part of ${result.themeFile} was edited by hand; it was left as it is.`;
            case "unchanged":
                parts.push(`The app theme already matches the ${result.tokenCount} design tokens.`);
                break;
            case "updated":
                parts.push(`Updated ${result.themeFile} from ${result.tokenCount} design tokens.`);
                if (result.link === "done") {
                    parts.push(`The code now uses them in ${result.linkedFiles.length} file(s).`);
                } else if (result.link === "reverted") {
                    parts.push("Using them in the code broke the type check, so that change was undone.");
                }
                break;
        }
        if (result.deprecated.length > 0) {
            parts.push(`${result.deprecated.length} token(s) no longer in Penpot stay because the code uses them.`);
        }
        if (result.refused.length > 0) {
            parts.push(`${result.refused.length} token(s) were left out: their name or value cannot go into code.`);
        }
        if (result.uncommitted.length > 0) {
            parts.push(`Not committed (they had other unsaved changes): ${result.uncommitted.join(", ")}.`);
        }
        return parts.join(" ");
    }
}
