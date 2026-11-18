import { dirname, join } from "node:path";
import { waitForHttp } from "../health/probes";
import { exitedReason, type ServiceContext, type ServiceDefinition } from "./context";

/** Environment variables a Node child of the shell never inherits (other tools' secrets). */
const DROPPED_ENV = /^(ELECTRON_|NODE_OPTIONS$|PENPOT_|PENFORGE_)/;

export function nodeChildEnv(ctx: ServiceContext, extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(ctx.baseEnv)) {
        if (!DROPPED_ENV.test(key)) {
            env[key] = value;
        }
    }
    return { ...env, ...ctx.nodeEnv, ...extra };
}

/** media-processor (Node + sharp): thumbnails and image info for the backend. */
export const mediaProcessorService: ServiceDefinition = {
    name: "media-processor",
    critical: false,

    spec(ctx) {
        return {
            name: "media-processor",
            command: ctx.nodeExecutable,
            args: [ctx.runtime.mediaProcessorEntry],
            env: nodeChildEnv(ctx, {
                NODE_ENV: "production",
                PENPOT_MEDIA_PROCESSOR_HOST: "127.0.0.1",
                PENPOT_MEDIA_PROCESSOR_PORT: String(ctx.ports.mediaProcessor),
                PENPOT_MEDIA_PROCESSOR_SHARED_KEY: ctx.state.mediaProcessorKey,
                PENPOT_MEDIA_PROCESSOR_MAX_CONCURRENT_REQUESTS: "4",
                TMPDIR: ctx.data.tmp,
                TEMP: ctx.data.tmp,
                TMP: ctx.data.tmp,
            }),
            cwd: dirname(dirname(ctx.runtime.mediaProcessorEntry)),
            logFile: join(ctx.data.logs, "media-processor.log"),
        };
    },

    async ready(ctx, proc) {
        await waitForHttp(`http://127.0.0.1:${ctx.ports.mediaProcessor}/api/health`, {
            timeoutMs: 30_000,
            abort: exitedReason(proc),
        });
    },
};

/** Settings of the daemon that come from the first-run wizard. */
export interface DaemonOptions {
    projectsDir: string;
    claudePath?: string;
}

export function daemonEnv(ctx: ServiceContext, options: DaemonOptions): NodeJS.ProcessEnv {
    const extra: Record<string, string> = {
        NODE_ENV: "production",
        PENFORGE: "1",
        PENFORGE_HOME: options.projectsDir,
        PENFORGE_AGENT_HOST: "127.0.0.1",
        PENFORGE_AGENT_PORT: String(ctx.ports.agent),
        PENFORGE_ALLOWED_ORIGINS: ctx.origin,
        PENFORGE_PUBLIC_URI: ctx.origin,
        PENPOT_MCP_SERVER_HOST: "127.0.0.1",
        PENPOT_MCP_SERVER_PORT: String(ctx.ports.mcp),
        PENPOT_MCP_WEBSOCKET_PORT: String(ctx.ports.bridge),
        PENPOT_MCP_LOG_DIR: ctx.data.logs,
    };
    if (options.claudePath) {
        extra.PENFORGE_CLAUDE_PATH = options.claudePath;
    }
    return nodeChildEnv(ctx, extra);
}

/** The Penforge daemon (MCP server + plugin bridge + agent endpoint). */
export function daemonService(options: () => DaemonOptions): ServiceDefinition {
    return {
        name: "daemon",
        critical: false,

        spec(ctx) {
            return {
                name: "daemon",
                command: ctx.nodeExecutable,
                args: [ctx.runtime.daemonEntry, "--penforge"],
                env: daemonEnv(ctx, options()),
                cwd: dirname(dirname(ctx.runtime.daemonEntry)),
                logFile: join(ctx.data.logs, "daemon.log"),
            };
        },

        async ready(ctx, proc) {
            await waitForHttp(`http://127.0.0.1:${ctx.ports.agent}/health`, {
                timeoutMs: 60_000,
                abort: exitedReason(proc),
            });
        },

        stopOptions() {
            return { timeoutMs: 8_000 };
        },
    };
}
