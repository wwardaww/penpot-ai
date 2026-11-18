import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataLayout, runtimeLayout } from "../config/layout";
import { freshState } from "../config/DesktopState";
import type { Ports, ServiceContext } from "../services/context";

export const FAKE_SERVICE = join(__dirname, "fakeService.mjs");

/** A temporary folder removed by the returned cleanup. */
export function tempDir(prefix = "penforge-desktop-"): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function fakeContext(root: string, ports: Partial<Ports> = {}): ServiceContext {
    const full: Ports = { gateway: 1, postgres: 2, backend: 3, mediaProcessor: 4, mcp: 5, bridge: 6, agent: 7, ...ports };
    return {
        runtime: runtimeLayout(join(root, "runtime")),
        data: dataLayout(join(root, "data")),
        state: freshState(),
        ports: full,
        platform: process.platform,
        nodeExecutable: process.execPath,
        nodeEnv: {},
        baseEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
        origin: `http://127.0.0.1:${full.gateway}`,
        backendHeapMb: 512,
    };
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
