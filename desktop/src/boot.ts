import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataLayout, missingParts, runtimeLayout, type DataLayout, type RuntimeLayout } from "./config/layout";
import { DesktopState } from "./config/DesktopState";
import { Gateway } from "./gateway/Gateway";
import { GoogleFonts } from "./gateway/GoogleFonts";
import { configJs } from "./gateway/configJs";
import { choosePorts } from "./net/ports";
import { backendService } from "./services/backend";
import { originOf, PORT_NAMES, type Ports, type ServiceContext } from "./services/context";
import { daemonService, mediaProcessorService } from "./services/node";
import { postgresService } from "./services/postgres";
import { Supervisor, type ServiceStatus } from "./supervisor/Supervisor";

export interface BootOptions {
    runtimeRoot: string;
    dataRoot: string;
    platform?: NodeJS.Platform;
    /** Runs Node scripts: Electron's own binary with `ELECTRON_RUN_AS_NODE=1`, or node. */
    nodeExecutable: string;
    nodeEnv?: Record<string, string>;
    baseEnv?: NodeJS.ProcessEnv;
    backendHeapMb?: number;
    /** Version of the shell; compared with the bundled `version.json`. */
    appVersion: string;
    /** Path of `claude` found by the wizard, if any. */
    claudePath?: string;
    onStatus?: (statuses: ServiceStatus[]) => void;
}

export interface RunningApp {
    context: ServiceContext;
    state: DesktopState;
    supervisor: Supervisor;
    gateway: Gateway;
    /** Warnings to show (version mismatch, degraded services). */
    warnings: string[];
    stop(): Promise<void>;
}

export interface RuntimeVersions {
    desktop?: string;
    commit?: string;
    [part: string]: string | undefined;
}

export function readVersions(runtime: RuntimeLayout): RuntimeVersions {
    if (!existsSync(runtime.versionFile)) {
        return {};
    }
    try {
        return JSON.parse(readFileSync(runtime.versionFile, "utf8")) as RuntimeVersions;
    } catch {
        return {};
    }
}

export function ensureDataDirs(data: DataLayout): void {
    for (const dir of [data.root, data.assets, data.logs, data.tmp]) {
        mkdirSync(dir, { recursive: true });
    }
}

/** Projects folder of the daemon: the wizard's choice, else `~/Penforge`. */
export function projectsDirOf(state: DesktopState): string {
    return state.data.wizard.projectsDir || join(homedir(), "Penforge");
}

/**
 * Starts everything the window needs: ports, PostgreSQL, media-processor, backend (with its
 * migrations), daemon, then the gateway. Rejects when a critical part fails (after stopping
 * what had started).
 */
export async function boot(options: BootOptions): Promise<RunningApp> {
    const platform = options.platform ?? process.platform;
    const runtime = runtimeLayout(options.runtimeRoot, platform);
    const missing = missingParts(runtime);
    if (missing.length > 0) {
        throw new Error(`the app bundle is incomplete, missing: ${missing.join(", ")} (in ${runtime.root})`);
    }
    const data = dataLayout(options.dataRoot);
    ensureDataDirs(data);
    const state = DesktopState.load(data.stateFile);

    const warnings: string[] = [];
    const versions = readVersions(runtime);
    if (versions.desktop && versions.desktop !== options.appVersion) {
        warnings.push(`bundled runtime ${versions.desktop} does not match the app ${options.appVersion}`);
    }

    const ports: Ports = await choosePorts(PORT_NAMES, state.data.ports);
    state.update((d) => {
        d.ports = { ...ports };
    });

    const context: ServiceContext = {
        runtime,
        data,
        state: state.data,
        ports,
        platform,
        nodeExecutable: options.nodeExecutable,
        nodeEnv: options.nodeEnv ?? {},
        baseEnv: options.baseEnv ?? process.env,
        origin: originOf(ports),
        backendHeapMb: options.backendHeapMb ?? 1024,
    };

    const services = [postgresService, mediaProcessorService, backendService];
    if (existsSync(runtime.daemonEntry)) {
        services.push(daemonService(() => ({ projectsDir: projectsDirOf(state), claudePath: options.claudePath })));
    }
    const supervisor = new Supervisor({ context, services });
    if (options.onStatus) {
        supervisor.on("status", options.onStatus);
    }

    const gateway = new Gateway({
        port: ports.gateway,
        frontendDir: runtime.frontendDir,
        mcpPluginDir: runtime.mcpPluginDir,
        assetsDir: data.assets,
        backendPort: ports.backend,
        googleFonts: new GoogleFonts({ cacheDir: data.fontCache }),
        configJs: () => configJs({
            origin: context.origin,
            agentPort: ports.agent,
            bridgePort: ports.bridge,
            version: versions.desktop ?? options.appVersion,
        }),
    });

    await supervisor.start();
    try {
        await gateway.start();
    } catch (error) {
        await supervisor.stop();
        throw error;
    }

    for (const status of supervisor.statuses()) {
        if (status.state === "failed") {
            warnings.push(`${status.name} did not start: ${status.detail ?? "unknown error"}`);
        }
    }

    let stopped: Promise<void> | undefined;
    return {
        context,
        state,
        supervisor,
        gateway,
        warnings,
        stop() {
            stopped ??= (async () => {
                await gateway.stop();
                await supervisor.stop();
            })();
            return stopped;
        },
    };
}
