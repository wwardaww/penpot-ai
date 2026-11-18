import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ChildEnvironment } from "../build/ChildEnvironment";
import { PublishError } from "./PublishError";

/**
 * ZIP archive of a project's generated app (`app-src`).
 *
 * Holds the app as it is on disk, tracked and new files alike but without what `.gitignore`
 * leaves out (`node_modules`, build output): the working tree is staged into a temporary index
 * (the repository's own index, history and files stay untouched) and `git archive` packs that
 * tree under one top folder.
 */
export class AppArchive {
    /** Largest archive served. */
    public static readonly MAX_BYTES = 200 * 1024 * 1024;

    /**
     * Packs the app.
     *
     * @param appSrcDir - the `app-src` repository
     * @param folder - name of the top folder inside the archive
     * @returns the ZIP bytes
     * @throws PublishError `no-app` when there is no repository, `too-large` above {@link MAX_BYTES}
     */
    public static async zip(appSrcDir: string, folder: string): Promise<Buffer> {
        if (!existsSync(join(appSrcDir, ".git")) || !existsSync(join(appSrcDir, "package.json"))) {
            throw new PublishError("no-app", "There is no generated app to download yet");
        }
        const scratch = await mkdtemp(join(tmpdir(), "penforge-zip-"));
        try {
            const env = ChildEnvironment.scrub(process.env, {
                GIT_INDEX_FILE: join(scratch, "index"),
                GIT_TERMINAL_PROMPT: "0",
            });
            await AppArchive.git(["add", "--all", "--", "."], appSrcDir, env);
            const tree = (await AppArchive.git(["write-tree"], appSrcDir, env)).toString("utf8").trim();
            if (!/^[0-9a-f]{40,64}$/.test(tree)) {
                throw new Error("git write-tree returned no tree");
            }
            return await AppArchive.git(["archive", "--format=zip", `--prefix=${folder}/`, tree], appSrcDir, env);
        } finally {
            await rm(scratch, { recursive: true, force: true });
        }
    }

    private static git(args: string[], cwd: string, env: Record<string, string>): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const child = spawn("git", args, {
                cwd,
                env,
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            const chunks: Buffer[] = [];
            let size = 0;
            let stderr = "";
            child.stdout.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > AppArchive.MAX_BYTES) {
                    child.kill();
                    reject(
                        new PublishError("too-large", "The app is too large to download", {
                            limitMb: String(AppArchive.MAX_BYTES / 1024 / 1024),
                        })
                    );
                    return;
                }
                chunks.push(chunk);
            });
            child.stderr.on("data", (chunk: Buffer) => {
                stderr = (stderr + chunk.toString("utf8")).slice(-4000);
            });
            child.once("error", reject);
            child.once("close", (code) => {
                if (code === 0) {
                    resolve(Buffer.concat(chunks));
                } else if (size <= AppArchive.MAX_BYTES) {
                    reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`));
                }
            });
        });
    }
}
