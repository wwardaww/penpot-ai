import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { Readable } from "stream";
import { ChildEnvironment } from "../build/ChildEnvironment";
import { PublishError } from "./PublishError";

/**
 * ZIP archive of a project's generated app (`app-src`) at its last saved version.
 *
 * Packs the `HEAD` commit with `git archive`: only committed files, so files the app never saved
 * (an uncommitted `.env`, build output) stay out. The archive is not built in memory: {@link open}
 * streams it from git when the browser downloads it.
 */
export class AppArchive {
    private static readonly COMMIT = /^[0-9a-f]{40,64}$/;

    /**
     * @param appSrcDir - the `app-src` repository
     * @param commit - the commit packed
     * @param folder - name of the top folder inside the archive
     */
    private constructor(
        private readonly appSrcDir: string,
        public readonly commit: string,
        public readonly folder: string
    ) {}

    /**
     * Prepares the archive of the app's `HEAD`.
     *
     * @param appSrcDir - the `app-src` repository
     * @param folder - name of the top folder inside the archive
     * @throws PublishError `no-app` when there is no repository or no commit yet
     */
    public static async ofHead(appSrcDir: string, folder: string): Promise<AppArchive> {
        if (!existsSync(join(appSrcDir, ".git")) || !existsSync(join(appSrcDir, "package.json"))) {
            throw new PublishError("no-app", "There is no generated app to download yet");
        }
        const commit = (
            await AppArchive.output(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], appSrcDir)
        ).trim();
        if (!AppArchive.COMMIT.test(commit)) {
            throw new PublishError("no-app", "The app has no saved version yet");
        }
        return new AppArchive(appSrcDir, commit, folder);
    }

    /**
     * Starts `git archive` and returns its output, the ZIP bytes.
     */
    public open(): Readable {
        const child = spawn("git", ["archive", "--format=zip", `--prefix=${this.folder}/`, this.commit], {
            cwd: this.appSrcDir,
            env: AppArchive.env(),
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
        });
        child.once("error", (error) => child.stdout.destroy(error));
        child.once("close", (code) => {
            if (code !== 0) {
                child.stdout.destroy(new Error(`git archive failed (exit ${code})`));
            }
        });
        return child.stdout;
    }

    private static env(): Record<string, string> {
        return ChildEnvironment.scrub(process.env, { GIT_TERMINAL_PROMPT: "0" });
    }

    private static output(args: string[], cwd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn("git", args, {
                cwd,
                env: AppArchive.env(),
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "ignore"],
            });
            let out = "";
            child.stdout.on("data", (chunk: Buffer) => {
                out += chunk.toString("utf8");
            });
            child.once("error", reject);
            child.once("close", () => resolve(out));
        });
    }
}
