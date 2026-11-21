import { LinkedAppStack } from "./LinkedAppStack";

/**
 * Finder of the app folders a Re-Design changed, inside a linked folder (W39).
 *
 * A changed file belongs to the nearest folder above it that holds an app
 * ({@link LinkedAppStack.isApp}: a package with a `dev`/`start` script, a native or Flutter app).
 * In a monorepo the Re-Design of one app gives that app's folder; changes that span several apps
 * give one folder per app, most changed first. Changes that belong to no app give the linked folder
 * itself, so a Re-Design always shows up somewhere.
 */
export class AppFolders {
    /** files looked at most */
    private static readonly MAX_FILES = 2000;
    /** folders inspected at most per call */
    private static readonly MAX_FOLDERS = 200;

    /**
     * @param root - the linked folder
     */
    constructor(private readonly root: string) {}

    /**
     * Finds the app folders of changed files.
     *
     * @param paths - changed files relative to the linked folder, `/`-separated
     * @returns app folders relative to the linked folder (`""` is the folder itself), most changed
     *  first; never empty
     */
    public async fromChanges(paths: readonly string[]): Promise<string[]> {
        const apps = new Map<string, boolean>();
        const counts = new Map<string, number>();
        for (const path of paths.slice(0, AppFolders.MAX_FILES)) {
            const app = await this.appOf(path, apps);
            if (app !== null) {
                counts.set(app, (counts.get(app) ?? 0) + 1);
            }
        }
        const found = [...counts.entries()]
            .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
            .map(([dir]) => dir);
        return found.length > 0 ? found : [""];
    }

    private async appOf(path: string, apps: Map<string, boolean>): Promise<string | null> {
        const segments = path.split("/").filter((segment) => segment.length > 0);
        if (segments.includes("..")) {
            return null;
        }
        // parent folders from the nearest to the linked folder itself
        for (let depth = segments.length - 1; depth >= 0; depth--) {
            const dir = segments.slice(0, depth).join("/");
            let isApp = apps.get(dir);
            if (isApp === undefined) {
                if (apps.size >= AppFolders.MAX_FOLDERS) {
                    return null;
                }
                const stack = await LinkedAppStack.inspect(this.root, dir);
                isApp = stack !== null && stack.isApp(dir === "");
                apps.set(dir, isApp);
            }
            if (isApp) {
                return dir;
            }
        }
        return null;
    }
}
