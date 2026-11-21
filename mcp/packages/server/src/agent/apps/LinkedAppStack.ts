import { readFile, stat } from "fs/promises";
import { basename, dirname, join } from "path";
import type { DetectedStack } from "@penpot/mcp-common";
import { AgentError } from "../AgentClient";
import { FolderInspector } from "../linked/FolderInspector";
import type { CommandPolicy } from "../process/CommandPolicy";
import { StackConfig } from "../process/StackConfig";
import { PathGuard } from "../workspace/pathGuard";

/** Package manager that runs an app's scripts. */
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Stack of an app folder inside a linked project (W39): what it is, how its dev server starts,
 * and whether its dependencies are installed.
 *
 * The dev command runs the app's own `dev` script (else `start`) through the package manager its
 * lockfile names, with the port and a loopback host passed in the form the framework understands;
 * the port is also in `PORT`. Penforge never installs dependencies here: a folder without
 * `node_modules` (in it or a parent up to the linked folder) is reported as not installed.
 */
export class LinkedAppStack {
    private static readonly MAX_MANIFEST_BYTES = 1024 * 1024;
    private static readonly READY_TIMEOUT_MS = 180_000;
    private static readonly LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
        ["pnpm-lock.yaml", "pnpm"],
        ["yarn.lock", "yarn"],
        ["bun.lockb", "bun"],
        ["bun.lock", "bun"],
        ["package-lock.json", "npm"],
    ];
    /** package of a stack whose name differs from it (the version shown on the card) */
    private static readonly FRAMEWORK_PACKAGES = new Map([
        ["angular", "@angular/core"],
        ["sveltekit", "@sveltejs/kit"],
    ]);

    /**
     * @param dir - real path of the app folder
     * @param stack - detected stack, or null when the folder has none Penforge knows
     * @param version - version range of the main framework dependency, or ""
     * @param devArgv - dev command with the `{port}` placeholder, or null when there is none
     * @param installed - false when a package app has no `node_modules`
     * @param web - the dev server shows the app in a browser
     * @param packageApp - the folder has a `package.json`
     */
    private constructor(
        public readonly dir: string,
        public readonly stack: DetectedStack | null,
        public readonly version: string,
        public readonly devArgv: readonly string[] | null,
        public readonly installed: boolean,
        public readonly web: boolean,
        public readonly packageApp: boolean
    ) {}

    /** Expo app: opened on a phone (QR), in a browser only with react-native-web. */
    public get expo(): boolean {
        return this.stack?.name === "expo";
    }

    /**
     * Tells whether the folder holds an app rather than a library or plain files: a package with a
     * `dev` or `start` script, or a native / Flutter app. A folder with only an `index.html` counts
     * when it is the linked folder itself (elsewhere it is mostly a `public/` folder).
     *
     * @param isRoot - the folder is the linked folder
     */
    public isApp(isRoot: boolean): boolean {
        if (this.stack === null) {
            return false;
        }
        if (this.packageApp) {
            return this.devArgv !== null;
        }
        return this.stack.name !== "static" || isRoot;
    }

    /**
     * Inspects an app folder.
     *
     * @param root - the linked folder
     * @param appDir - the app folder relative to it (`/`-separated, `""` for the folder itself)
     * @returns the stack, or null when the folder is missing or outside the linked folder
     */
    public static async inspect(root: string, appDir: string): Promise<LinkedAppStack | null> {
        let dir: string;
        let realRoot: string;
        try {
            const guard = new PathGuard(root);
            realRoot = guard.resolve(".");
            dir = guard.resolve(appDir === "" ? "." : appDir);
            if (!(await stat(dir)).isDirectory()) {
                return null;
            }
        } catch {
            return null;
        }
        const facts = await new FolderInspector().facts(dir).catch(() => null);
        if (facts === null) {
            return null;
        }
        const stack = facts.stack;
        const pkg = facts.markers.includes("package.json") ? await LinkedAppStack.manifest(dir) : null;
        if (pkg === null) {
            return new LinkedAppStack(dir, stack, "", null, true, stack?.platform !== "mobile", false);
        }
        const deps = LinkedAppStack.dependencies(pkg);
        const version = LinkedAppStack.frameworkVersion(stack, deps);
        const scripts = LinkedAppStack.object(pkg.scripts) ?? {};
        const scriptName = ["dev", "start"].find((name) => typeof scripts[name] === "string");
        const manager = await LinkedAppStack.packageManager(dir, realRoot, pkg);
        const devArgv =
            scriptName === undefined
                ? null
                : LinkedAppStack.runScript(manager, scriptName, LinkedAppStack.portArgs(String(scripts[scriptName])));
        const installed = await LinkedAppStack.hasNodeModules(dir, realRoot);
        const expo = stack?.name === "expo";
        const web = expo ? deps.has("react-native-web") : true;
        return new LinkedAppStack(dir, stack, version, devArgv, installed, web, true);
    }

    /**
     * Gets the dev server settings.
     *
     * @param policy - rules for the dev command
     * @throws AgentError `not-configured` (reason `no-dev-command` or `not-installed`), or
     *  `bad-request` when the command is refused
     */
    public toStackConfig(policy: CommandPolicy): StackConfig {
        if (this.devArgv === null) {
            throw new AgentError(
                "not-configured",
                "Penforge does not know how to start this app (no dev or start script)",
                "no-dev-command"
            );
        }
        if (!this.installed) {
            throw new AgentError(
                "not-configured",
                `The app's dependencies are not installed: install them in ${this.dir} first`,
                "not-installed",
                { path: this.dir }
            );
        }
        return new StackConfig(
            this.stack?.name ?? basename(this.dir),
            policy.validate(this.devArgv),
            "PORT",
            this.dir,
            "/",
            LinkedAppStack.READY_TIMEOUT_MS
        );
    }

    /** Arguments that give the framework of a script the port and a loopback host. */
    private static portArgs(script: string): string[] {
        const words = script.toLowerCase().split(/[\s&|;]+/);
        const uses = (...names: string[]) => names.some((name) => words.includes(name));
        if (uses("next")) {
            return ["--port", "{port}", "--hostname", "127.0.0.1"];
        }
        if (uses("expo")) {
            return ["--port", "{port}"];
        }
        if (uses("vite")) {
            return ["--host", "127.0.0.1", "--port", "{port}", "--strictPort"];
        }
        if (uses("astro", "nuxt", "nuxi", "ng")) {
            return ["--port", "{port}", "--host", "127.0.0.1"];
        }
        // other servers read PORT (create-react-app, express, …)
        return [];
    }

    private static runScript(manager: PackageManager, script: string, args: string[]): string[] {
        if (manager === "npm") {
            return args.length > 0 ? ["npm", "run", script, "--", ...args] : ["npm", "run", script];
        }
        return [manager, "run", script, ...args];
    }

    /** Package manager from the nearest lockfile up to the linked folder, else `packageManager`. */
    private static async packageManager(
        dir: string,
        realRoot: string,
        pkg: Record<string, unknown>
    ): Promise<PackageManager> {
        for (const folder of LinkedAppStack.folders(dir, realRoot)) {
            for (const [file, manager] of LinkedAppStack.LOCKFILES) {
                if (await LinkedAppStack.exists(join(folder, file))) {
                    return manager;
                }
            }
        }
        const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
        return declared === "pnpm" || declared === "yarn" || declared === "bun" ? declared : "npm";
    }

    private static async hasNodeModules(dir: string, realRoot: string): Promise<boolean> {
        for (const folder of LinkedAppStack.folders(dir, realRoot)) {
            const found = await stat(join(folder, "node_modules"))
                .then((entry) => entry.isDirectory())
                .catch(() => false);
            if (found) {
                return true;
            }
        }
        return false;
    }

    /** The folder and its parents up to the linked folder (both included). */
    private static folders(dir: string, realRoot: string): string[] {
        const guard = new PathGuard(realRoot);
        const folders: string[] = [];
        let current = dir;
        while (guard.contains(current)) {
            folders.push(current);
            const parent = dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
        return folders;
    }

    private static frameworkVersion(stack: DetectedStack | null, deps: Map<string, string>): string {
        if (stack === null) {
            return "";
        }
        const range = deps.get(LinkedAppStack.FRAMEWORK_PACKAGES.get(stack.name) ?? stack.name);
        return range === undefined ? "" : range.replace(/^[\^~>=<\s]+/, "").slice(0, 40);
    }

    private static dependencies(pkg: Record<string, unknown>): Map<string, string> {
        const deps = new Map<string, string>();
        for (const field of ["dependencies", "devDependencies"]) {
            for (const [name, range] of Object.entries(LinkedAppStack.object(pkg[field]) ?? {})) {
                deps.set(name, typeof range === "string" ? range : "");
            }
        }
        return deps;
    }

    private static async manifest(dir: string): Promise<Record<string, unknown> | null> {
        const file = join(dir, "package.json");
        try {
            if ((await stat(file)).size > LinkedAppStack.MAX_MANIFEST_BYTES) {
                return null;
            }
            return LinkedAppStack.object(JSON.parse(await readFile(file, "utf8")));
        } catch {
            return null;
        }
    }

    private static exists(file: string): Promise<boolean> {
        return stat(file)
            .then(() => true)
            .catch(() => false);
    }

    private static object(value: unknown): Record<string, unknown> | null {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    }
}
