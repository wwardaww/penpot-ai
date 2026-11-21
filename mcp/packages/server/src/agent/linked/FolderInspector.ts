import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import type { DetectedStack, FolderFacts } from "@penpot/mcp-common";

/**
 * Inspector of a folder's top level: tells a Unity or Unreal Engine game, a git repository and the
 * app stack from the names in it. Reads no file content except a small `package.json`.
 */
export class FolderInspector {
    /** names that mark a project of some kind (exact names) */
    private static readonly MARKER_NAMES = [
        "package.json",
        "pubspec.yaml",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "Podfile",
        "Package.swift",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "requirements.txt",
        "composer.json",
        "Gemfile",
        "angular.json",
        "app.json",
        "index.html",
        "DESIGN.md",
    ];
    /** marker patterns by extension, reported as `*<ext>` */
    private static readonly MARKER_EXTENSIONS = [".xcodeproj", ".xcworkspace", ".csproj", ".sln", ".uproject"];
    /** top-level entries read at most */
    private static readonly MAX_ENTRIES = 5000;
    private static readonly MAX_MANIFEST_BYTES = 1024 * 1024;

    /**
     * Gets the facts of a folder.
     *
     * @param dir - an existing folder (real path)
     * @throws when the folder cannot be read
     */
    public async facts(dir: string): Promise<FolderFacts> {
        const entries = await readdir(dir, { withFileTypes: true });
        const listed = entries.slice(0, FolderInspector.MAX_ENTRIES);
        const dirs = new Set(listed.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
        const names = new Set(listed.map((entry) => entry.name));
        const unity = dirs.has("Assets") && dirs.has("ProjectSettings");
        const uproject = listed.find((entry) => entry.isFile() && /\.uproject$/i.test(entry.name))?.name ?? null;
        const unreal = uproject !== null;
        const markers = [
            ...FolderInspector.MARKER_NAMES.filter((name) => names.has(name)),
            ...FolderInspector.MARKER_EXTENSIONS.filter((ext) =>
                listed.some((entry) => entry.name.toLowerCase().endsWith(ext))
            ).map((ext) => `*${ext}`),
        ];
        const engine = unity ? "unity" : unreal ? "unreal" : null;
        return {
            git: names.has(".git"),
            unity,
            unreal,
            uproject,
            markers,
            empty: entries.length === 0,
            engine,
            stack: engine === null ? await this.stack(dir, names, dirs) : null,
        };
    }

    /**
     * Detects the app stack from manifests: Flutter, Expo / React Native, web frameworks, native
     * iOS / Android, static HTML.
     */
    private async stack(dir: string, names: Set<string>, dirs: Set<string>): Promise<DetectedStack | null> {
        if (names.has("pubspec.yaml")) {
            return { platform: "mobile", name: "flutter" };
        }
        if (names.has("package.json")) {
            const deps = await this.packageDependencies(join(dir, "package.json"));
            const has = (name: string) => deps.has(name);
            if (has("expo")) {
                return { platform: "mobile", name: "expo" };
            }
            if (has("react-native")) {
                return { platform: "mobile", name: "react-native" };
            }
            if (has("@ionic/core") || has("@capacitor/core")) {
                return { platform: "mobile", name: "capacitor" };
            }
            for (const [dependency, name] of [
                ["next", "next"],
                ["nuxt", "nuxt"],
                ["@angular/core", "angular"],
                ["@sveltejs/kit", "sveltekit"],
                ["svelte", "svelte"],
                ["vue", "vue"],
                ["solid-js", "solid"],
                ["react", "react"],
            ] as const) {
                if (has(dependency)) {
                    return { platform: "web", name };
                }
            }
            return { platform: "web", name: "web" };
        }
        if ([...names].some((name) => /\.(xcodeproj|xcworkspace)$/i.test(name)) || names.has("Package.swift")) {
            return { platform: "mobile", name: "ios" };
        }
        if ((names.has("build.gradle") || names.has("build.gradle.kts")) && dirs.has("app")) {
            return { platform: "mobile", name: "android" };
        }
        if (names.has("index.html")) {
            return { platform: "web", name: "static" };
        }
        return null;
    }

    private async packageDependencies(file: string): Promise<Set<string>> {
        try {
            if ((await stat(file)).size > FolderInspector.MAX_MANIFEST_BYTES) {
                return new Set();
            }
            const json = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
            const names = new Set<string>();
            for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
                const value = json[field];
                if (value && typeof value === "object") {
                    Object.keys(value).forEach((name) => names.add(name));
                }
            }
            return names;
        } catch {
            return new Set();
        }
    }
}
