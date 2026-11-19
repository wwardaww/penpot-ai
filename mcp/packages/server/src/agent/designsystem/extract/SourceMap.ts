import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import type { ComponentReport } from "./ExtractScripts";
import type { ExtractDetails, RawInventory } from "./ExtractModel";

const execFileAsync = promisify(execFile);

/** Where the design system came from (marker `designSystem.source`). */
export interface SourceRef {
    fileId: string;
    projectId: string;
    revn: number;
}

/**
 * `source-map.json` (W36 → W30): how every item of the source project file maps to the design
 * system. Ids of the source are the ids of the copy before the extraction (Penpot's
 * `duplicate-file` keeps them), so a component, color or typography that was kept has the SAME
 * id in the source and in the design system.
 */
export interface SourceMap {
    version: 1;
    createdAt: string;
    source: SourceRef | null;
    designSystem: { fileId: string; projectId: string; name: string };
    /** source component id → design system component (same id when kept; null when dropped) */
    components: Record<
        string,
        {
            componentId: string | null;
            name: string;
            path: string;
            status: "kept" | "renamed" | "grouped" | "icon" | "dropped";
        }
    >;
    /** source layer id (a repeated layer or an icon drawing) → design system component */
    layers: Record<string, { componentId: string; name: string; variant: string | null; kind: "component" | "icon" }>;
    /** source library color id → token, and the library color that stays (null when dropped) */
    colors: Record<string, { token: string | null; colorId: string | null }>;
    /** source library typography id → typography that stays (null when dropped) */
    typographies: Record<string, { typographyId: string | null; name: string }>;
    /** raw values of the source → token names (`#rrggbb`, px values, shadow keys) */
    values: {
        colors: Record<string, string>;
        spacing: Record<string, string>;
        radius: Record<string, string>;
        shadows: Record<string, string>;
    };
    /** raw text styles of the source (family, size, weight) → the text style made of them */
    textStyles: {
        fontFamily: string;
        fontSize: string;
        fontWeight: string;
        typographyId: string | null;
        name: string;
    }[];
    /** near-duplicate colors folded into one token */
    merged: { token: string; keep: string; from: string[] }[];
}

/** What the apply stages made, to build the map from. */
export interface SourceMapInput {
    source: SourceRef | null;
    designSystem: { fileId: string; projectId: string; name: string };
    inventory: RawInventory;
    details: ExtractDetails;
    components: ComponentReport | null;
    /** hex → library color id after the colors stage */
    libraryColors: Record<string, string>;
    /** text style name → typography id after the typography stage */
    typographies: Record<string, string>;
    /** icon shape id → component id after the icon import */
    icons: Record<string, string>;
}

/** Builder and store of {@link SourceMap}. */
export class SourceMapFile {
    /** file name inside `design/systems/<file-id>/` */
    public static readonly FILE_NAME = "source-map.json";

    /** commit message prefix */
    public static readonly COMMIT_PREFIX = "penforge(design-system): ";

    /**
     * @param workspace - the design system's workspace view (`designSystemWorkspace`)
     */
    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /** Builds the map of an extraction. */
    public static build(input: SourceMapInput, now: string): SourceMap {
        const { inventory, details } = input;
        const map: SourceMap = {
            version: 1,
            createdAt: now,
            source: input.source,
            designSystem: input.designSystem,
            components: {},
            layers: {},
            colors: {},
            typographies: {},
            values: { colors: {}, spacing: {}, radius: {}, shadows: {} },
            textStyles: [],
            merged: [],
        };
        const renamed = new Map(details.renames.map((r) => [r.componentId, r.name]));
        const grouped = new Map<string, string>();
        for (const group of details.groups) {
            group.componentIds.forEach((id) => grouped.set(id, group.path));
        }
        const icons = new Set(details.icons.componentIds);
        const dropped = new Set(input.components?.dropped ?? []);
        for (const component of inventory.components) {
            const status = dropped.has(component.id)
                ? "dropped"
                : icons.has(component.id)
                  ? "icon"
                  : renamed.has(component.id)
                    ? "renamed"
                    : grouped.has(component.id)
                      ? "grouped"
                      : "kept";
            map.components[component.id] = {
                componentId: status === "dropped" ? null : component.id,
                name: renamed.get(component.id) ?? component.name,
                path: icons.has(component.id) ? "Icons" : (grouped.get(component.id) ?? component.path),
                status,
            };
        }
        for (const created of input.components?.created ?? []) {
            const planned = details.components.find((entry) => entry.proposalId === created.proposalId)?.component;
            for (const made of created.components) {
                const members = planned?.variants.find((variant) => variant.sampleId === made.sampleId)?.members ?? [
                    made.sampleId,
                ];
                const variant = created.variants || (planned?.variants.length ?? 1) > 1 ? made.variant : null;
                for (const member of members) {
                    map.layers[member] = {
                        componentId: made.componentId,
                        name: created.name,
                        variant,
                        kind: "component",
                    };
                }
            }
        }
        for (const shape of details.icons.shapes) {
            const componentId = input.icons[shape.id];
            if (componentId) {
                map.layers[shape.id] = { componentId, name: shape.name, variant: null, kind: "icon" };
            }
        }

        const tokenOfHex = new Map(details.colors.map((color) => [color.hex, color.token]));
        const keepOf = new Map<string, string>();
        for (const merge of details.merges) {
            const token = tokenOfHex.get(merge.keep);
            if (!token) {
                continue;
            }
            map.merged.push({ token, keep: merge.keep, from: merge.drop.map((drop) => drop.hex) });
            merge.drop.forEach((drop) => {
                tokenOfHex.set(drop.hex, token);
                keepOf.set(drop.hex, merge.keep);
            });
        }
        for (const [hex, token] of [...tokenOfHex.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            map.values.colors[hex] = token;
        }
        const droppedColors = new Set(details.unused.filter((u) => u.kind === "color").map((u) => u.id));
        for (const color of inventory.colors) {
            const token = color.hex ? (tokenOfHex.get(color.hex) ?? null) : null;
            const merged = color.hex !== null && keepOf.has(color.hex);
            const target = color.hex ? (keepOf.get(color.hex) ?? color.hex) : null;
            const keptId = target ? (input.libraryColors[target] ?? null) : null;
            map.colors[color.id] = {
                token: droppedColors.has(color.id) ? null : token,
                colorId: droppedColors.has(color.id) ? null : (keptId ?? (merged ? null : color.id)),
            };
        }
        const droppedTypographies = new Set(details.unused.filter((u) => u.kind === "typography").map((u) => u.id));
        for (const typography of inventory.typographies) {
            map.typographies[typography.id] = {
                typographyId: droppedTypographies.has(typography.id) ? null : typography.id,
                name: typography.name,
            };
        }
        for (const { token } of details.tokens) {
            const bucket =
                token.type === "spacing"
                    ? map.values.spacing
                    : token.type === "borderRadius"
                      ? map.values.radius
                      : map.values.shadows;
            bucket[token.value] = token.name;
        }
        for (const { style } of details.textStyles) {
            map.textStyles.push({
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                typographyId: input.typographies[style.name] ?? null,
                name: style.name,
            });
        }
        return map;
    }

    /** Absolute path of `source-map.json`. */
    public get path(): string {
        return this.workspace.resolve(join(this.workspace.designDir, SourceMapFile.FILE_NAME));
    }

    /** Reads the map, or null when there is none. */
    public async read(): Promise<SourceMap | null> {
        try {
            return JSON.parse(await readFile(this.path, "utf8")) as SourceMap;
        } catch {
            return null;
        }
    }

    /**
     * Writes the map (through a temporary file in `.penforge/tmp/`) and commits only it.
     *
     * @returns the commit hash, or null when nothing changed
     */
    public async save(map: SourceMap, summary: string): Promise<string | null> {
        await mkdir(this.workspace.designDir, { recursive: true });
        const tempDir = this.workspace.resolve(join(this.workspace.metaDir, "tmp"));
        await mkdir(tempDir, { recursive: true });
        const temp = join(tempDir, `source-map-${randomUUID()}.tmp`);
        await writeFile(temp, JSON.stringify(map, null, 2) + "\n", "utf8");
        try {
            await rename(temp, this.path);
        } catch (error) {
            await unlink(temp).catch(() => {});
            throw error;
        }
        await this.git(["add", "--", SourceMapFile.FILE_NAME]);
        const staged = await this.git(["diff", "--cached", "--name-only", "--", SourceMapFile.FILE_NAME]);
        if (staged.trim().length === 0) {
            return null;
        }
        const configured = await this.git(["config", "user.email"])
            .then((email) => email.trim().length > 0)
            .catch(() => false);
        const identity = configured ? [] : ["-c", "user.name=Penforge", "-c", "user.email=penforge@localhost"];
        await this.git([
            ...identity,
            "commit",
            "-q",
            "-m",
            `${SourceMapFile.COMMIT_PREFIX}${summary}`,
            "--",
            SourceMapFile.FILE_NAME,
        ]);
        return (await this.git(["rev-parse", "HEAD"])).trim();
    }

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, {
            cwd: this.workspace.designDir,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    }
}
