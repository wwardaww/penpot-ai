import { spawnSync } from "node:child_process";

/**
 * Kills a process and every process it started.
 *
 * Windows has no process groups that survive the parent: `taskkill /T /F` walks the tree.
 * Elsewhere children are spawned `detached` (own process group), so the group gets the signal.
 */
export function treeKill(pid: number, platform: NodeJS.Platform = process.platform, signal: NodeJS.Signals = "SIGKILL"): void {
    if (!Number.isInteger(pid) || pid <= 0) {
        return;
    }
    if (platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // already gone
        }
    }
}

/** True while a process with that id exists. */
export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}
