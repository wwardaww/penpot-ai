import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the bundled runtime lives (JRE, PostgreSQL, backend, frontend, daemon, media-processor).
 *
 * Packaged app: `<resources>/runtime` (electron-builder `extraResources`). Development:
 * `desktop/build/runtime`, filled by `scripts/stage.mjs` and `scripts/fetch-runtime.mjs`.
 * `PENFORGE_DESKTOP_RUNTIME` overrides both.
 */
export interface RuntimeLayout {
    root: string;
    /** `java` executable of the bundled JRE. */
    java: string;
    /** Folder with `initdb`, `pg_ctl` and `postgres`. */
    postgresBin: string;
    /** Folder with `penpot.jar`, `log4j2.xml` and `builtin-templates/`. */
    backendDir: string;
    /** Built frontend (`index.html`, `js/`, ...). */
    frontendDir: string;
    /** Built MCP plugin served at `/plugins/mcp`. */
    mcpPluginDir: string;
    /** Penforge daemon entry (`mcp/packages/server` build). */
    daemonEntry: string;
    /** media-processor entry. */
    mediaProcessorEntry: string;
    /** Build versions of the bundled parts (`version.json`). */
    versionFile: string;
}

export function exe(name: string, platform: NodeJS.Platform = process.platform): string {
    return platform === "win32" ? `${name}.exe` : name;
}

export function runtimeLayout(root: string, platform: NodeJS.Platform = process.platform): RuntimeLayout {
    return {
        root,
        java: join(root, "jre", "bin", exe("java", platform)),
        postgresBin: join(root, "postgres", "bin"),
        backendDir: join(root, "backend"),
        frontendDir: join(root, "frontend"),
        mcpPluginDir: join(root, "mcp-plugin"),
        daemonEntry: join(root, "daemon", "dist", "index.js"),
        mediaProcessorEntry: join(root, "media-processor", "dist", "index.js"),
        versionFile: join(root, "version.json"),
    };
}

/** Parts of the layout that must exist before the supervisor starts; answers the missing ones. */
export function missingParts(layout: RuntimeLayout): string[] {
    const required: [string, string][] = [
        ["jre", layout.java],
        ["postgres", join(layout.postgresBin, exe("pg_ctl"))],
        ["backend", join(layout.backendDir, "penpot.jar")],
        ["frontend", join(layout.frontendDir, "index.html")],
        ["daemon", layout.daemonEntry],
    ];
    return required.filter(([, path]) => !existsSync(path)).map(([name]) => name);
}

/** Per-user data of the desktop app (database, assets, logs, settings). */
export interface DataLayout {
    root: string;
    pgdata: string;
    assets: string;
    logs: string;
    tmp: string;
    stateFile: string;
}

export function dataLayout(root: string): DataLayout {
    return {
        root,
        pgdata: join(root, "pgdata"),
        assets: join(root, "assets"),
        logs: join(root, "logs"),
        tmp: join(root, "tmp"),
        stateFile: join(root, "desktop.json"),
    };
}
