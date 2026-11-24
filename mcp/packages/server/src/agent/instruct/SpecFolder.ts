import { createHash } from "crypto";
import { lstatSync, readFileSync } from "fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { FolderPaths } from "../workspace/FolderPaths";

/** Content of the manifest of a spec folder. */
interface SpecManifest {
    generator: string;
    projectId: string;
    writtenAt: string;
    /** sha256 of every file the last run wrote, by `/`-separated path */
    files: Record<string, string>;
}

/** What publishing a spec changed. */
export interface SpecPublishResult {
    files: number;
    /** files the user had changed, moved to `kept/<time>/` before the new ones were written */
    kept: string[];
}

/**
 * The `PenforgeUI/` folder of a web or mobile project (W41 Instruct), in a folder the user picked.
 *
 * Its manifest `.penforge-ui.json` names the project and lists the files Penforge wrote. A run
 * replaces only those: files the user added stay, and files the user changed are moved to
 * `kept/<time>/` first. A `PenforgeUI` folder without the project's manifest is never touched.
 */
export class SpecFolder {
    public static readonly NAME = "PenforgeUI";
    public static readonly MANIFEST = ".penforge-ui.json";
    private static readonly GENERATOR = "penforge-instruct";
    private static readonly MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
    private static readonly KEPT = "kept";
    private static readonly paths = new FolderPaths();

    /**
     * @param dir - the `PenforgeUI` folder (a real path, existing or not)
     * @param projectId - the project
     */
    constructor(
        private readonly dir: string,
        private readonly projectId: string
    ) {}

    /**
     * Tells whether a folder is the spec folder Penforge wrote for a project.
     *
     * @param dir - the `PenforgeUI` folder
     * @param projectId - the project
     */
    public static isOwn(dir: string, projectId: string): boolean {
        return SpecFolder.paths.isRealFolder(dir) && SpecFolder.manifest(dir)?.projectId === projectId;
    }

    /**
     * Tells whether a run may write a spec folder: it does not exist, or Penforge wrote it for the
     * project.
     *
     * @param dir - the `PenforgeUI` folder
     * @param projectId - the project
     */
    public static isFreeOrOwn(dir: string, projectId: string): boolean {
        try {
            lstatSync(dir);
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ENOENT";
        }
        return SpecFolder.isOwn(dir, projectId);
    }

    /** Tells whether a folder is a spec folder of any project. */
    public static isSpec(dir: string): boolean {
        return basename(dir) === SpecFolder.NAME && SpecFolder.manifest(dir) !== null;
    }

    /**
     * Replaces the folder's files with the files of a staging folder.
     *
     * @param staging - folder holding the new content
     * @throws Error when the folder exists and is not the project's spec folder
     */
    public async publish(staging: string): Promise<SpecPublishResult> {
        if (!SpecFolder.isFreeOrOwn(this.dir, this.projectId)) {
            throw new Error(`${this.dir} exists and was not written by Penforge for this project`);
        }
        if (!(await SpecFolder.exists(this.dir))) {
            await mkdir(this.dir);
        }
        const previous = SpecFolder.manifest(this.dir)?.files ?? {};
        const next = await SpecFolder.hashes(staging);
        // names the project's manifest from the start, so an interrupted run can be repeated
        await this.writeManifest({ ...previous });
        const kept = await this.removePrevious(previous, next);
        for (const [file, hash] of Object.entries(next)) {
            const target = this.path(file);
            await this.makeFolders(dirname(target));
            const present = await SpecFolder.hash(target);
            // a link or folder in the file's place is moved away too, never written through
            if (present !== hash && (await SpecFolder.exists(target))) {
                kept.push(await this.keep(file));
            }
            if (present !== hash) {
                await copyFile(join(staging, ...file.split("/")), target);
            }
        }
        await this.writeManifest(next);
        return { files: Object.keys(next).length, kept };
    }

    /** Removes the files of the last run that are not changed; moves changed ones to `kept/`. */
    private async removePrevious(previous: Record<string, string>, next: Record<string, string>): Promise<string[]> {
        const kept: string[] = [];
        for (const [file, hash] of Object.entries(previous)) {
            if (!SpecFolder.isSafeName(file) || !(await this.isPlain(file))) {
                continue;
            }
            const present = await SpecFolder.hash(this.path(file));
            if (present === null || present === next[file]) {
                continue;
            }
            if (present === hash) {
                await unlink(this.path(file));
            } else {
                kept.push(await this.keep(file));
            }
        }
        for (const file of Object.keys(previous).filter((name) => SpecFolder.isSafeName(name))) {
            const parent = dirname(this.path(file));
            if (!SpecFolder.paths.same(parent, this.dir) && SpecFolder.paths.isRealFolder(parent)) {
                // only an empty folder goes away
                await rmdir(parent).catch(() => undefined);
            }
        }
        return kept;
    }

    private async keep(file: string): Promise<string> {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const target = this.path(`${SpecFolder.KEPT}/${stamp}/${file}`);
        await this.makeFolders(dirname(target));
        await rename(this.path(file), target);
        return file;
    }

    /** Creates folders below the spec folder; refuses a link in their place. */
    private async makeFolders(folder: string): Promise<void> {
        await mkdir(folder, { recursive: true });
        if (!SpecFolder.paths.isRealFolder(folder)) {
            throw new Error(`${folder} is not a plain folder`);
        }
    }

    /** Tells whether the folders above a listed file are no links. */
    private async isPlain(file: string): Promise<boolean> {
        const parent = dirname(this.path(file));
        return SpecFolder.paths.isRealFolder(parent);
    }

    private path(file: string): string {
        return join(this.dir, ...file.split("/"));
    }

    private async writeManifest(files: Record<string, string>): Promise<void> {
        const manifest: SpecManifest = {
            generator: SpecFolder.GENERATOR,
            projectId: this.projectId,
            writtenAt: new Date().toISOString(),
            files,
        };
        await writeFile(join(this.dir, SpecFolder.MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }

    private static manifest(dir: string): SpecManifest | null {
        const file = join(dir, SpecFolder.MANIFEST);
        try {
            const info = lstatSync(file);
            if (!info.isFile() || info.size > SpecFolder.MAX_MANIFEST_BYTES) {
                return null;
            }
            const manifest = JSON.parse(readFileSync(file, "utf8")) as Partial<SpecManifest> | null;
            if (
                manifest === null ||
                typeof manifest !== "object" ||
                manifest.generator !== SpecFolder.GENERATOR ||
                typeof manifest.projectId !== "string"
            ) {
                return null;
            }
            const files =
                typeof manifest.files === "object" && manifest.files !== null
                    ? Object.fromEntries(Object.entries(manifest.files).filter(([, hash]) => typeof hash === "string"))
                    : {};
            return { ...(manifest as SpecManifest), files };
        } catch {
            return null;
        }
    }

    /** A listed path that stays below the folder. */
    private static isSafeName(file: string): boolean {
        return (
            file.length > 0 &&
            !/[\\:\0]/.test(file) &&
            !file.startsWith("/") &&
            file.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
        );
    }

    private static exists(target: string): Promise<boolean> {
        return lstat(target).then(
            () => true,
            () => false
        );
    }

    private static async hashes(root: string, prefix = ""): Promise<Record<string, string>> {
        const result: Record<string, string> = {};
        for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                Object.assign(result, await SpecFolder.hashes(root, name));
            } else if (entry.isFile()) {
                result[name] = (await SpecFolder.hash(join(root, ...name.split("/"))))!;
            }
        }
        return result;
    }

    /** sha256 of a regular file, or null for anything else. */
    private static async hash(file: string): Promise<string | null> {
        try {
            if (!(await lstat(file)).isFile()) {
                return null;
            }
            return createHash("sha256")
                .update(await readFile(file))
                .digest("hex");
        } catch {
            return null;
        }
    }
}
