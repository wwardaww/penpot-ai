import type { DataLayout, RuntimeLayout } from "../config/layout";
import type { DesktopStateData } from "../config/DesktopState";
import type { ManagedProcess, ProcessSpec, StopOptions } from "../process/ManagedProcess";

/** Ports of one run; all bound to 127.0.0.1. */
export interface Ports {
    gateway: number;
    postgres: number;
    backend: number;
    mediaProcessor: number;
    mcp: number;
    bridge: number;
    agent: number;
}

export const PORT_NAMES = ["gateway", "postgres", "backend", "mediaProcessor", "mcp", "bridge", "agent"] as const;

export interface ServiceContext {
    runtime: RuntimeLayout;
    data: DataLayout;
    state: DesktopStateData;
    ports: Ports;
    platform: NodeJS.Platform;
    /** Executable that runs Node scripts (Electron with `ELECTRON_RUN_AS_NODE=1`, or node). */
    nodeExecutable: string;
    /** Extra environment for Node children (e.g. `ELECTRON_RUN_AS_NODE`). */
    nodeEnv: Record<string, string>;
    /** Base environment of every child (the shell's env without secrets of other tools). */
    baseEnv: NodeJS.ProcessEnv;
    /** Origin the window loads (`http://127.0.0.1:<gateway>`). */
    origin: string;
    /** JVM max heap in MiB. */
    backendHeapMb: number;
}

/** One supervised child process. */
export interface ServiceDefinition {
    name: string;
    /** One-time work before the first start (init a data folder, stop a stale server). */
    prepare?(ctx: ServiceContext): Promise<void>;
    spec(ctx: ServiceContext): ProcessSpec;
    /** Resolves when the service answers; `proc` tells when it died meanwhile. */
    ready(ctx: ServiceContext, proc: ManagedProcess): Promise<void>;
    stopOptions?(ctx: ServiceContext, proc: ManagedProcess): StopOptions;
    /** When false, a failure is reported but the app keeps going (degraded). */
    critical: boolean;
}

export function originOf(ports: Ports): string {
    return `http://127.0.0.1:${ports.gateway}`;
}

/** Abort check for `waitUntil`: fails as soon as the process is gone. */
export function exitedReason(proc: ManagedProcess): () => string | undefined {
    return () => (proc.running ? undefined : `process exited (see ${proc.log.file}):\n${proc.log.lastLines(15).join("\n")}`);
}
