import { createHash } from "crypto";
import { existsSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative, sep } from "path";
import type { AbortSignalLike, WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { CommandSchema } from "../build/BuildFiles";
import { type CommandExecutor, ProcessCommandExecutor } from "../build/CommandExecutor";
import { PublishError, SecretMask } from "./PublishError";

/** One file of a built site. */
export interface SiteFile {
    /** path relative to the site root, with `/` separators and no leading slash */
    path: string;
    sha1: string;
    size: number;
    content: Buffer;
}

/** Built static site of a project's app. */
export class StaticSite {
    /**
     * @param folder - output folder name, relative to `app-src` (`dist`)
     * @param files - every file of the site
     */
    constructor(
        public readonly folder: string,
        public readonly files: SiteFile[]
    ) {}

    /** Total size of the files in bytes. */
    public get size(): number {
        return this.files.reduce((sum, file) => sum + file.size, 0);
    }

    /**
     * Gets the files plus one generated file, unless the site has a file of that name already.
     *
     * @param path - path of the generated file (`_redirects`)
     * @param content - its content
     */
    public withFile(path: string, content: string): SiteFile[] {
        if (this.files.some((file) => file.path === path)) {
            return this.files;
        }
        return [...this.files, StaticSite.file(path, Buffer.from(content, "utf8"))];
    }

    /**
     * Creates a site file.
     *
     * @param path - relative path with `/` separators
     * @param content - the bytes
     */
    public static file(path: string, content: Buffer): SiteFile {
        return { path, sha1: createHash("sha1").update(content).digest("hex"), size: content.length, content };
    }
}

/** Progress steps of {@link StaticSiteBuilder.build}. */
export type BuildStep = "install" | "build";

/**
 * Builder of a project's app into static files for Vercel and Netlify.
 *
 * Runs the stack's `commands.install` (when `node_modules` is missing) and `commands.build` in
 * `app-src/` like the build pipeline does (validated argument vectors, no shell, scrubbed
 * environment without tokens), then reads the first output folder that holds an `index.html`.
 */
export class StaticSiteBuilder {
    /** Output folders looked at, in order. */
    public static readonly OUTPUT_FOLDERS = ["dist", "build", "out", "web-build", join(".output", "public")];
    private static readonly MAX_FILES = 5000;
    private static readonly MAX_BYTES = 100 * 1024 * 1024;
    private static readonly INSTALL_TIMEOUT_MS = 15 * 60_000;
    private static readonly BUILD_TIMEOUT_MS = 10 * 60_000;

    /**
     * @param executor - runs the stack commands
     * @param mask - removes secrets from build output
     */
    constructor(
        private readonly executor: CommandExecutor = new ProcessCommandExecutor(),
        private readonly mask: SecretMask = new SecretMask()
    ) {}

    /**
     * Builds the app and reads its output.
     *
     * @param workspace - the project
     * @param signal - cancels the build
     * @param onStep - called when a step starts
     * @throws PublishError `no-app`, `build-failed`, `no-output`, `too-large`
     */
    public async build(
        workspace: WorkflowWorkspaceApi,
        signal: AbortSignalLike | undefined,
        onStep: (step: BuildStep) => void = () => {}
    ): Promise<StaticSite> {
        const stack = await workspace.readJson<{ commands?: { install?: unknown; build?: unknown } } | null>(
            "stack.json",
            null
        );
        const build = CommandSchema.safeParse(stack?.commands?.build);
        if (!stack || !build.success || !existsSync(join(workspace.appSrcDir, "package.json"))) {
            throw new PublishError("no-app", "There is no generated app to publish yet");
        }
        const install = CommandSchema.safeParse(stack.commands?.install);
        if (install.success && !existsSync(join(workspace.appSrcDir, "node_modules"))) {
            onStep("install");
            await this.run(install.data, workspace.appSrcDir, StaticSiteBuilder.INSTALL_TIMEOUT_MS, signal);
        }
        onStep("build");
        await this.run(build.data, workspace.appSrcDir, StaticSiteBuilder.BUILD_TIMEOUT_MS, signal);
        for (const folder of StaticSiteBuilder.OUTPUT_FOLDERS) {
            const root = join(workspace.appSrcDir, folder);
            if (existsSync(join(root, "index.html"))) {
                return new StaticSite(folder.split(sep).join("/"), await StaticSiteBuilder.collect(root));
            }
        }
        throw new PublishError("no-output", "The build made no folder with an index.html", {
            folders: StaticSiteBuilder.OUTPUT_FOLDERS.join(", "),
        });
    }

    private async run(
        argv: string[],
        cwd: string,
        timeoutMs: number,
        signal: AbortSignalLike | undefined
    ): Promise<void> {
        const outcome = await this.executor.execute(argv, { cwd, timeoutMs, signal });
        if (outcome.code !== 0) {
            throw new PublishError(
                "build-failed",
                outcome.timedOut ? `${argv.join(" ")} took too long` : `${argv.join(" ")} failed`,
                { command: argv.join(" ") },
                this.mask.mask(outcome.output).slice(-4000)
            );
        }
    }

    private static async collect(root: string): Promise<SiteFile[]> {
        const files: SiteFile[] = [];
        let bytes = 0;
        const walk = async (dir: string): Promise<void> => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isSymbolicLink()) {
                    continue;
                }
                if (entry.isDirectory()) {
                    await walk(path);
                } else if (entry.isFile()) {
                    bytes += (await stat(path)).size;
                    if (files.length >= StaticSiteBuilder.MAX_FILES || bytes > StaticSiteBuilder.MAX_BYTES) {
                        throw new PublishError("too-large", "The built app is too large to publish", {
                            limitMb: String(StaticSiteBuilder.MAX_BYTES / 1024 / 1024),
                        });
                    }
                    files.push(StaticSite.file(relative(root, path).split(sep).join("/"), await readFile(path)));
                }
            }
        };
        await walk(root);
        return files.sort((a, b) => a.path.localeCompare(b.path));
    }
}
