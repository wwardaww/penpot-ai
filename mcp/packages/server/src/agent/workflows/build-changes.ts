import type { Workflow } from "@penpot/mcp-common";
import { BuildLock } from "../build/BuildLock";
import { ChangeTracker } from "../changes/ChangeTracker";

/**
 * Lists what changed in the design since the last build (W34): the Update button's badge and the
 * change list of the Update dialog. Reads only; runs no Claude turn and writes nothing. Result
 * `{hasBuild, busy, lastBuild, count, tokenOnly, changes, keptInstructions}`. See
 * `wiki/architecture.md` §7 (change requests).
 */
export const workflow: Workflow<Record<string, never>> = {
    name: "build-changes",
    description: "Lists the design changes since the last build of the app.",
    run: async (ctx) => {
        const tracker = new ChangeTracker(ctx);
        const keptInstructions = await tracker.keptInstructions();
        // a running build changes the baseline: the client asks again once it is done
        const release = BuildLock.tryAcquire(ctx.workspace.root);
        if (release === null) {
            ctx.emit("result", {
                hasBuild: true,
                busy: true,
                lastBuild: null,
                count: 0,
                tokenOnly: false,
                keptInstructions,
            });
            return { summary: "A build is running." };
        }
        release();
        const detection = await tracker.detect();
        const last = detection.lastBuild;
        ctx.emit("result", {
            hasBuild: detection.hasBuild,
            busy: false,
            lastBuild: last ? { n: last.n, label: last.label, at: last.at } : null,
            count: detection.changes.count,
            tokenOnly: detection.changes.tokenOnly,
            changes: detection.changes,
            keptInstructions,
        });
        if (!detection.hasBuild) {
            return { summary: "No app built yet." };
        }
        return {
            summary:
                detection.changes.count === 0
                    ? "The app is up to date."
                    : `${detection.changes.count} change(s) since the last build.`,
        };
    },
};
