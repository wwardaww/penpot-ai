import type { AbortSignalLike, Workflow, WorkflowContext } from "@penpot/mcp-common";
import { ensureCheckpoint } from "../checkpoints";
import { PenpotScripts } from "../designmd";
import { DesignSystemFailure, DesignSystemRun, DesignSystemScripts } from "../designsystem";
import {
    DEFAULT_ICON_LIMITS,
    DEFAULT_ICON_STYLE,
    GitHubIcons,
    IconCollector,
    IconScripts,
    type CollectedIcon,
    type FoundLicense,
    type IconChunkReport,
    type IconCollection,
    type IconTokenReport,
} from "../icons";

/** One SVG sent by the client (icons taken from a `.fig` file). */
export interface ClientSvgIcon {
    name: string;
    /** sub folder under `Icons` (`/`-separated), optional */
    group?: string;
    svg: string;
}

/** Params of the `design-system-icons` workflow. */
export type DesignSystemIconsParams =
    | {
          source: "github";
          /** GitHub repository, folder, release or file URL */
          url: string;
          /** skip the question (the user already agreed to this exact URL) */
          confirmed?: boolean;
      }
    | {
          source: "svg";
          icons: ClientSvgIcon[];
          /** where the SVGs come from, for the report (`fig:<file name>`) */
          origin?: string;
      };

/** Payload of the `result` event. */
export interface DesignSystemIconsResult {
    cancelled?: boolean;
    source: string;
    license: FoundLicense | null;
    found: number;
    imported: number;
    skipped: { name: string; reason: string; detail?: string }[];
    truncated: boolean;
    token: IconTokenReport | null;
    checkpoint: { id: string; n: number } | null;
}

/** Icons per `execute_code` call (one undo step each; Penpot closes an undo block after 20 s). */
export const ICON_CHUNK = 40;

/** Most SVG icons a client may send in one run. */
export const MAX_CLIENT_ICONS = DEFAULT_ICON_LIMITS.maxIcons;

/** Where GitHub icon sets come from (tests replace the factory). */
export const iconSources = { github: (): GitHubIcons => new GitHubIcons() };

/** Question option ids. */
export const ICON_OPTIONS = { import: "import", cancel: "cancel" } as const;

/**
 * Imports an icon set into the open design system file: from a GitHub URL (downloaded from the
 * allowlisted hosts, size and count limits, SVGs sanitized, license shown and the user asked
 * before anything changes) or from SVGs the client extracted (a `.fig` file imported through
 * W12). Every icon becomes a 24 px main component under path `Icons…` on the "Icons" page, its
 * strokes and fills bound to the `color.icon` token. Checkpoint first; one undo step per chunk of
 * {@link ICON_CHUNK} icons.
 */
export const workflow: Workflow<DesignSystemIconsParams> = {
    name: "design-system-icons",
    description: "Imports an icon set (GitHub URL or SVGs) as normalized components.",
    run: (ctx, params) =>
        new DesignSystemRun(ctx).guard(async () => {
            const run = new DesignSystemRun(ctx);
            let collection: IconCollection;
            let source: string;

            if (params?.source === "github") {
                if (typeof params.url !== "string" || params.url.trim().length === 0) {
                    throw new DesignSystemFailure("bad-url", "Give the GitHub URL of the icon set");
                }
                run.progress("download", "Downloading the icon set from GitHub", {
                    url: params.url.trim().slice(0, 300),
                });
                const set = await iconSources.github().fetch(params.url, toAbortSignal(ctx.signal));
                collection = set;
                source = `github:${set.source.owner}/${set.source.repo}${set.source.ref !== "HEAD" ? `@${set.source.ref}` : ""}${set.source.folder ? `/${set.source.folder}` : ""}`;
                const plan = {
                    source,
                    owner: set.source.owner,
                    repo: set.source.repo,
                    ref: set.source.ref,
                    folder: set.source.folder,
                    count: set.icons.length,
                    found: set.found,
                    skipped: set.skipped.length,
                    truncated: set.truncated,
                    license: set.license,
                };
                ctx.emit("plan", plan);
                run.progress("license", "Checking the license");
                if (set.truncated) {
                    run.log("icons-truncated", `Only the first ${DEFAULT_ICON_LIMITS.maxIcons} icons are imported`, {
                        limit: DEFAULT_ICON_LIMITS.maxIcons,
                    });
                }
                if (params.confirmed !== true) {
                    const choice = await ctx.ask({
                        text: licenseQuestion(plan),
                        options: [
                            { id: ICON_OPTIONS.import, label: `Import ${set.icons.length} icons` },
                            { id: ICON_OPTIONS.cancel, label: "Cancel" },
                        ],
                    });
                    if (choice !== ICON_OPTIONS.import) {
                        const cancelled: DesignSystemIconsResult = {
                            cancelled: true,
                            source,
                            license: set.license,
                            found: set.found,
                            imported: 0,
                            skipped: [],
                            truncated: set.truncated,
                            token: null,
                            checkpoint: null,
                        };
                        ctx.emit("result", cancelled);
                        return { summary: "Icon import cancelled" };
                    }
                }
            } else if (params?.source === "svg") {
                const icons = Array.isArray(params.icons) ? params.icons : [];
                if (icons.length === 0) {
                    throw new DesignSystemFailure("no-icons", "No icons were found in the file", { found: 0 });
                }
                collection = collectClientIcons(icons);
                source = typeof params.origin === "string" && params.origin ? params.origin.slice(0, 200) : "svg";
                if (collection.icons.length === 0) {
                    throw new DesignSystemFailure("no-icons", "None of the shapes could be used as an icon", {
                        found: collection.found,
                    });
                }
            } else {
                throw new DesignSystemFailure("bad-source", "source must be github or svg");
            }

            stopIfCancelled(ctx);
            run.progress("checkpoint", "Saving a checkpoint");
            const checkpoint = await ensureCheckpoint(
                ctx,
                `Before importing ${collection.icons.length} icons`,
                "design-system-icons"
            );
            if (!checkpoint) {
                run.log("checkpoint-failed", "No checkpoint could be saved; going on");
            }

            const scripts = new PenpotScripts(ctx.tools);
            run.progress("icon-token", "Preparing the icon color token");
            const token = await scripts.run<IconTokenReport>(IconScripts.ensureTokenScript(DEFAULT_ICON_STYLE));
            if (token.warning === "tokens-from-library") {
                run.log("tokens-from-library", "The file takes its tokens from a library; icons keep their own color");
            }

            const skipped: DesignSystemIconsResult["skipped"] = collection.skipped.map((s) => ({
                name: s.name,
                reason: s.reason,
            }));
            let imported = 0;
            const total = collection.icons.length;
            for (let start = 0; start < total; start += ICON_CHUNK) {
                stopIfCancelled(ctx);
                run.progress(
                    "icons",
                    `Importing icons ${start + 1}–${Math.min(total, start + ICON_CHUNK)} of ${total}`,
                    {
                        done: start,
                        total,
                    }
                );
                const chunk = collection.icons.slice(start, start + ICON_CHUNK);
                const report = await scripts.run<IconChunkReport>(
                    IconScripts.importChunkScript(chunk, DEFAULT_ICON_STYLE)
                );
                imported += report.imported.length;
                skipped.push(...report.skipped);
            }
            if (skipped.length > 0) {
                run.log("icons-skipped", `${skipped.length} icons were skipped`, {
                    count: skipped.length,
                    names: skipped.slice(0, 20).map((s) => s.name),
                });
            }
            const now = new Date().toISOString();
            await scripts
                .run(
                    DesignSystemScripts.markerScript(
                        {
                            icons: {
                                count: imported,
                                source,
                                license: collection.license?.spdx ?? (collection.license ? "unknown" : null),
                                importedAt: now,
                            },
                        },
                        now
                    )
                )
                .catch(() => null);

            const result: DesignSystemIconsResult = {
                source,
                license: collection.license,
                found: collection.found,
                imported,
                skipped,
                truncated: collection.truncated,
                token,
                checkpoint: checkpoint ? { id: checkpoint.id, n: checkpoint.n } : null,
            };
            ctx.emit("result", result);
            return { summary: `Imported ${imported} icons${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}` };
        }),
};

/** Sanitizes and names the SVGs a client sent, with the same rules as a GitHub folder. */
export function collectClientIcons(icons: ClientSvgIcon[]): IconCollection {
    const collector = new IconCollector("", DEFAULT_ICON_LIMITS, false);
    for (const icon of icons.slice(0, MAX_CLIENT_ICONS + 1)) {
        if (!icon || typeof icon.svg !== "string" || typeof icon.name !== "string") {
            continue;
        }
        const name = icon.name.replace(/[\/\\]/g, "-").trim() || "icon";
        const group =
            typeof icon.group === "string"
                ? icon.group
                      .split("/")
                      .map((part) => part.trim())
                      .filter(Boolean)
                : [];
        const data = Buffer.from(icon.svg, "utf8");
        const path = [...group, `${name}.svg`].join("/");
        collector.add({ path, data: data.length > DEFAULT_ICON_LIMITS.maxFileBytes ? null : data, size: data.length });
    }
    const result = collector.result();
    return icons.length > MAX_CLIENT_ICONS ? { ...result, truncated: true } : result;
}

/** English text of the license question (the client shows the `plan` payload translated). */
export function licenseQuestion(plan: {
    owner: string;
    repo: string;
    count: number;
    license: FoundLicense | null;
}): string {
    const license = plan.license
        ? `License: ${plan.license.spdx ?? "not recognized"} (${plan.license.file}). Check that it allows your use.`
        : "No license file was found: you may not have the right to use these icons.";
    return `Found ${plan.count} icons in ${plan.owner}/${plan.repo}. ${license} Import them as components?`;
}

function stopIfCancelled(ctx: WorkflowContext): void {
    if (ctx.signal.aborted) {
        throw new DesignSystemFailure("cancelled", "Cancelled");
    }
}

/** The run's signal as a platform `AbortSignal` (needed by `fetch` and `AbortSignal.any`). */
function toAbortSignal(signal: AbortSignalLike): AbortSignal {
    if (signal instanceof AbortSignal) {
        return signal;
    }
    const controller = new AbortController();
    if (signal.aborted) {
        controller.abort();
    } else {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return controller.signal;
}

export type { CollectedIcon };
