import { posix } from "path";
import { type SourceFile, SourceFiles } from "../tokens/SourceFiles";

/** Where a route of the app is declared. */
export interface DeclaredRoute {
    route: string;
    file: string;
}

/**
 * Source files of the generated app with what the conformance check reads from them: the import
 * graph, the routes the app declares and the constants that hold routes.
 *
 * Works on text, not on a parsed program, so it serves every stack (React Router, Next, Expo
 * Router, React Navigation, Vue, Svelte, plain HTML); where the text leaves doubt it accepts.
 */
export class AppSources {
    private static readonly EXTENSIONS = new Set([
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".css",
        ".scss",
        ".less",
        ".vue",
        ".svelte",
        ".astro",
        ".html",
    ]);
    private static readonly CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|html)$/;
    private static readonly CONFIG = /(^|\/)(?:[\w.-]+\.config\.(?:ts|js|mjs|cjs)|[\w.-]+\.d\.ts)$/;
    private static readonly TEST = /(^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[a-z]+$)/;
    private static readonly IMPORT =
        /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|@import\s+(?:url\(\s*)?)["']([^"']+)["']/g;
    private static readonly ROUTER =
        /<Routes?\b|createBrowserRouter|createHashRouter|createRouter|createRoutesFromElements|NavigationContainer|createStackNavigator|createNativeStackNavigator|createBottomTabNavigator|<Stack\.Screen|<Tabs\.Screen|RouterModule|VueRouter|\blinking\b/;
    /** property names whose value is a place to go, not a declared route */
    private static readonly LINK_PROPS = new Set([
        "to",
        "href",
        "url",
        "link",
        "src",
        "action",
        "redirect",
        "redirectTo",
    ]);

    private readonly byPath: Map<string, SourceFile>;
    private readonly imports = new Map<string, string[]>();

    /**
     * @param files - source files of the app, paths relative to the app folder
     */
    constructor(public readonly files: SourceFile[]) {
        this.byPath = new Map(files.map((file) => [file.file, file]));
    }

    /**
     * Reads the sources of an app (no dependencies, build output or tests).
     *
     * @param appDir - the app folder
     */
    public static async load(appDir: string): Promise<AppSources> {
        const files = await SourceFiles.list(appDir, AppSources.EXTENSIONS);
        return new AppSources(files.filter((file) => !AppSources.TEST.test(file.file)));
    }

    /** Code files: scripts, components and pages, without tool configuration. */
    public code(): SourceFile[] {
        return this.files.filter((file) => AppSources.CODE.test(file.file) && !AppSources.CONFIG.test(file.file));
    }

    /** Text of a file, "" when the app has no such source. */
    public text(file: string): string {
        return this.byPath.get(file)?.text ?? "";
    }

    /**
     * Gets the files reached from some files through relative and `@/` imports, the files
     * included. Files that declare the app's routes are left out: they name every screen.
     *
     * @param files - start files
     * @param depth - import steps followed
     */
    public closure(files: readonly string[], depth = 4): SourceFile[] {
        const seen = new Map<string, SourceFile>();
        let step = files.filter((file) => this.byPath.has(file));
        for (const file of step) {
            seen.set(file, this.byPath.get(file)!);
        }
        for (let i = 0; i < depth && step.length > 0; i++) {
            const next: string[] = [];
            for (const file of step) {
                for (const target of this.importsOf(file)) {
                    if (!seen.has(target) && !this.isRouter(target)) {
                        seen.set(target, this.byPath.get(target)!);
                        next.push(target);
                    }
                }
            }
            step = next;
        }
        return [...seen.values()];
    }

    /** Tells whether a file declares the routes of the app. */
    public isRouter(file: string): boolean {
        return AppSources.CODE.test(file) && AppSources.ROUTER.test(this.text(file));
    }

    /** Routes the app declares: router definitions, navigation maps and file-based routes. */
    public declaredRoutes(): DeclaredRoute[] {
        const routes: DeclaredRoute[] = [];
        const routed = this.files.some((file) => this.isRouter(file.file));
        for (const file of this.code()) {
            // a single-page app's only HTML file is the shell of every route
            if (routed && file.file.endsWith(".html")) {
                continue;
            }
            if (this.isRouter(file.file)) {
                for (const match of file.text.matchAll(/\bpath\s*[=:]\s*\{?\s*["'`]([^"'`$]*)["'`]/g)) {
                    routes.push({ route: AppSources.normalize(match[1]), file: file.file });
                }
            }
            const page = AppSources.fileRoute(file.file);
            if (page !== null) {
                routes.push({ route: page, file: file.file });
            }
        }
        return routes;
    }

    /**
     * Tells whether the app has a route: declared by a router or a file, or held by a constant
     * (`addTask: "/add-task"`, also without the leading slash as in React Navigation's linking map).
     *
     * @param route - route of the plan
     */
    public hasRoute(route: string): boolean {
        const wanted = AppSources.normalize(route);
        if (this.declaredRoutes().some((declared) => declared.route === wanted)) {
            return true;
        }
        return this.code().some((file) => this.routeConstants(file, wanted).length > 0);
    }

    /** Names of the constants that hold a route, in the whole app. */
    public constantsOf(route: string): string[] {
        const wanted = AppSources.normalize(route);
        return [...new Set(this.code().flatMap((file) => this.routeConstants(file, wanted)))];
    }

    /** Tells whether the start of the app leads to a route: the route `/` itself, or a redirect to it. */
    public startsAt(route: string, names: readonly string[]): boolean {
        const wanted = AppSources.normalize(route);
        if (wanted === "/") {
            return this.hasRoute("/") || this.code().length === 0;
        }
        const literal = AppSources.quoted(route);
        return this.code().some((file) => {
            for (const match of file.text.matchAll(
                /(?:<Navigate\b|<Redirect\b|\bredirect(?:To)?\b|initialRouteName|router\.replace|navigate)\s*[^\n]{0,120}/g
            )) {
                if (literal.test(match[0]) || names.some((name) => AppSources.quoted(name).test(match[0]))) {
                    return true;
                }
            }
            return false;
        });
    }

    /** Pattern of a string literal holding a value (as a whole, or followed by `?`, `#` or `/`). */
    public static quoted(value: string): RegExp {
        if (value === "/") {
            return /["'`](?:\.{0,2}\/|index\.html)["'`?#]/;
        }
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z0-9_]+/g, "[^\"'`]+");
        return new RegExp(`["'\`](?:\\.?\\/)?${escaped.replace(/^\//, "/?")}(?:["'\`?#]|\\/["'\`])`);
    }

    private importsOf(file: string): string[] {
        const known = this.imports.get(file);
        if (known !== undefined) {
            return known;
        }
        const targets: string[] = [];
        for (const match of this.text(file).matchAll(AppSources.IMPORT)) {
            const target = this.resolve(file, match[1]);
            if (target !== null) {
                targets.push(target);
            }
        }
        this.imports.set(file, targets);
        return targets;
    }

    private resolve(from: string, specifier: string): string | null {
        const candidates: string[] = [];
        if (specifier.startsWith(".")) {
            candidates.push(posix.join(posix.dirname(from), specifier));
        } else if (/^[@~]\//.test(specifier)) {
            candidates.push(posix.join("src", specifier.slice(2)), specifier.slice(2));
        } else if (specifier.startsWith("src/")) {
            candidates.push(specifier);
        } else {
            return null;
        }
        for (const candidate of candidates) {
            const clean = posix.normalize(candidate).replace(/^\//, "");
            const bare = clean.replace(/\.(?:js|jsx|mjs)$/, "");
            const tries = [
                clean,
                ...[".tsx", ".ts", ".jsx", ".js", ".vue", ".svelte", ".mjs", ".css"].flatMap((ext) => [
                    `${clean}${ext}`,
                    `${bare}${ext}`,
                    `${clean}/index${ext}`,
                ]),
            ];
            const found = tries.find((path) => this.byPath.has(path));
            if (found !== undefined) {
                return found;
            }
        }
        return null;
    }

    /** Constants of a file that hold a route (property or `const` name). */
    private routeConstants(file: SourceFile, wanted: string): string[] {
        const names: string[] = [];
        for (const match of file.text.matchAll(
            /(?:^|[{,;\s(])["']?([A-Za-z_$][\w$-]*)["']?\s*[:=]\s*["'`]([^"'`$\n]*)["'`]/g
        )) {
            if (
                !AppSources.LINK_PROPS.has(match[1]) &&
                match[1] !== "path" &&
                match[2].length > 0 &&
                AppSources.normalize(match[2]) === wanted
            ) {
                const value = match[2];
                const routeLike = value.startsWith("/") || this.isRouter(file.file);
                if (routeLike) {
                    names.push(match[1]);
                }
            }
        }
        return names;
    }

    /** Route of a page file (`app/`, `pages/`, `routes/` folders, plain HTML), or null. */
    private static fileRoute(file: string): string | null {
        const html = /^(?:src\/)?([^/]+(?:\/[^/]+)*)\.html$/.exec(file);
        if (html) {
            return html[1] === "index" ? "/" : AppSources.normalize(html[1]);
        }
        const match = /^(?:src\/)?(app|pages|routes)\/(.+)\.(?:tsx|ts|jsx|js|vue|svelte|astro)$/.exec(file);
        if (!match) {
            return null;
        }
        const segments = match[2].split("/").filter((segment) => !/^\(.*\)$/.test(segment));
        const last = segments[segments.length - 1] ?? "";
        if (/^[_+](?!page$)/.test(last) || /^(?:layout|loading|error|not-found|404|500|template)$/.test(last)) {
            return null;
        }
        if (/^(?:index|page|\+page|route)$/.test(last)) {
            segments.pop();
        }
        if (segments[0] === "api") {
            return null;
        }
        return AppSources.normalize(segments.join("/"));
    }

    /** Comparable form of a route: leading slash, no trailing one, parameters as `:`. */
    public static normalize(route: string): string {
        const clean = route
            .trim()
            .replace(/\[\.{0,3}[^\]]*\]/g, ":")
            .replace(/:[A-Za-z0-9_]+\??/g, ":")
            .replace(/\$[A-Za-z0-9_]+/g, ":")
            .replace(/^\.?\/+|\/+$/g, "");
        return `/${clean}`;
    }
}
