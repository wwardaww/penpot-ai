import { mkdirSync } from "node:fs";
import { join, parse } from "node:path";
import { waitForHttp } from "../health/probes";
import { DB_NAME, DB_USER } from "./postgres";
import { exitedReason, type ServiceContext, type ServiceDefinition } from "./context";

/**
 * Flags of the desktop backend: Penforge on, single local profile, no email, no registration,
 * cookies over loopback HTTP, images through the bundled media-processor.
 */
export const BACKEND_FLAGS = [
    "enable-ai",
    "enable-penforge-local",
    "enable-remote-media-processing",
    "disable-registration",
    "disable-login-with-password",
    "disable-email-verification",
    "disable-smtp",
    "disable-secure-session-cookies",
    "disable-admin-console",
    "disable-telemetry",
];

export function backendEnv(ctx: ServiceContext): NodeJS.ProcessEnv {
    return {
        ...ctx.baseEnv,
        PENPOT_FLAGS: BACKEND_FLAGS.join(" "),
        PENPOT_PUBLIC_URI: ctx.origin,
        PENPOT_HTTP_SERVER_HOST: "127.0.0.1",
        PENPOT_HTTP_SERVER_PORT: String(ctx.ports.backend),
        PENPOT_DATABASE_URI: `postgresql://127.0.0.1:${ctx.ports.postgres}/${DB_NAME}`,
        PENPOT_DATABASE_USERNAME: DB_USER,
        PENPOT_DATABASE_PASSWORD: ctx.state.postgresPassword,
        PENPOT_REDIS_URI: "mem://desktop",
        PENPOT_OBJECTS_STORAGE_BACKEND: "fs",
        PENPOT_OBJECTS_STORAGE_FS_DIRECTORY: ctx.data.assets,
        PENPOT_TMP_DIRECTORY: ctx.data.tmp,
        PENPOT_SECRET_KEY: ctx.state.backendSecretKey,
        PENPOT_PENFORGE_LOCAL_SECRET: ctx.state.localLoginSecret,
        PENPOT_MEDIA_PROCESSOR_SHARED_KEY: ctx.state.mediaProcessorKey,
        PENPOT_MEDIA_PROCESSING_SERVICE_URI: `http://127.0.0.1:${ctx.ports.mediaProcessor}`,
    };
}

/** Where yetti's `/tmp/undertow/` lands for the backend's working directory. */
export function undertowDir(ctx: ServiceContext): string {
    return ctx.platform === "win32" ? join(parse(ctx.runtime.backendDir).root, "tmp", "undertow") : "/tmp/undertow";
}

export function backendArgs(ctx: ServiceContext): string[] {
    return [
        `-Xmx${ctx.backendHeapMb}m`,
        "-XX:+UseSerialGC",
        "-XX:ReservedCodeCacheSize=128m",
        "-XX:-OmitStackTraceInFastThrow",
        // `environ` lower-cases env names with the default locale: under a Turkish locale
        // `PENPOT_DATABASE_URI` becomes `:penpot-database-urı` and the setting is lost
        "-Duser.language=en",
        "-Duser.country=US",
        "-Dfile.encoding=UTF-8",
        `-Djava.io.tmpdir=${ctx.data.tmp}`,
        "-Djava.util.logging.manager=org.apache.logging.log4j.jul.LogManager",
        `-Dlog4j2.configurationFile=${join(ctx.runtime.backendDir, "log4j2.xml")}`,
        "--sun-misc-unsafe-memory-access=allow",
        "--enable-native-access=ALL-UNNAMED",
        "--add-opens=java.base/java.nio=ALL-UNNAMED",
        "--enable-preview",
        "-jar", join(ctx.runtime.backendDir, "penpot.jar"),
        "-m", "app.main",
    ];
}

/** Penpot backend (JVM). Runs the database migrations itself on start. */
export const backendService: ServiceDefinition = {
    name: "backend",
    critical: true,

    async prepare(ctx) {
        mkdirSync(ctx.data.assets, { recursive: true });
        mkdirSync(ctx.data.tmp, { recursive: true });
        // the multipart parser (yetti) writes uploads to the fixed `/tmp/undertow/`, which
        // Windows resolves against the drive of the working directory
        mkdirSync(undertowDir(ctx), { recursive: true });
    },

    spec(ctx) {
        return {
            name: "backend",
            command: ctx.runtime.java,
            args: backendArgs(ctx),
            env: backendEnv(ctx),
            // `builtin-templates/` is read from the working directory
            cwd: ctx.runtime.backendDir,
            logFile: join(ctx.data.logs, "backend.log"),
        };
    },

    async ready(ctx, proc) {
        // first start runs every migration: give it time
        await waitForHttp(`http://127.0.0.1:${ctx.ports.backend}/readyz`, {
            timeoutMs: 300_000,
            intervalMs: 500,
            abort: exitedReason(proc),
        });
    },

    stopOptions() {
        return { timeoutMs: 15_000 };
    },
};
