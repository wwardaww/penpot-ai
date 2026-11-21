import { z } from "zod";
import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { AgentConfig } from "../../agent/AgentConfig";
import { TidyUpTool } from "../../agent/cleanup/TidyUpTool";
import { PenforgePluginTool } from "./PenforgePluginTool";

/**
 * Arguments of {@link GetAnimationSpecTool}.
 */
export class GetAnimationSpecArgs {
    static schema = {
        fileId: z.string().min(1).max(128).describe("Id of the Penpot file open in the user's tab."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    fileId!: string;

    sessionId?: string;
}

/** `.penforge/map.json` as far as the spec reads it (architecture §7, W08). */
interface BuildMap {
    fileId?: string;
    builtAt?: string;
    commit?: string | null;
    boards?: Record<string, { name?: string; route?: string | null; files?: string[] }>;
}

/**
 * Adds the build's `map.json` hints (route and files per screen) to the plugin's animation spec.
 */
export class AnimationSpecMap {
    /**
     * Returns the spec with `map {found, builtAt, commit}` and, per board, `route`, `files` and
     * `built`. A map of another file counts as no map.
     *
     * @param spec - the plugin's spec (`PenforgeApi.getAnimationSpec`)
     * @param map - the project's `map.json`, or null
     */
    public static attach(spec: any, map: BuildMap | null): any {
        const usable = map !== null && typeof map === "object" && map.fileId === spec.fileId;
        const boards = usable && map.boards && typeof map.boards === "object" ? map.boards : {};
        return {
            ...spec,
            map: {
                found: usable,
                builtAt: usable ? (map.builtAt ?? null) : null,
                commit: usable ? (map.commit ?? null) : null,
            },
            pages: (spec.pages ?? []).map((page: any) => ({
                ...page,
                boards: (page.boards ?? []).map((board: any) => {
                    const entry = Object.prototype.hasOwnProperty.call(boards, board.boardId)
                        ? boards[board.boardId]
                        : undefined;
                    return {
                        ...board,
                        built: entry !== undefined,
                        route: typeof entry?.route === "string" ? entry.route : null,
                        files: Array.isArray(entry?.files) ? entry.files.filter((f) => typeof f === "string") : [],
                    };
                }),
            })),
        };
    }
}

/**
 * Returns every animation of the open file for the build (W32, read by W35): screens, animated
 * layers with resolved ids, smart animate links and code hints, plus the screen routes and files
 * of the last build.
 */
export class GetAnimationSpecTool extends PenforgePluginTool<GetAnimationSpecArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, GetAnimationSpecArgs.schema);
    }

    public getToolName(): string {
        return "get_animation_spec";
    }

    public getToolDescription(): string {
        return (
            "Penforge build helper. Returns all layer animations of the open file as one JSON document " +
            "`{version, fileId, fileName, layerCount, map:{found, builtAt, commit}, pages:[{pageId, pageName, " +
            "boards:[{boardId, boardName, componentName, built, route, files, layers:[{nodeId, name, type, path, " +
            "parentId, codeName, component, childCount, animations, smart?}]}], otherLayers}]}`. `route`/`files` " +
            "come from the last build's .penforge/map.json. Use it to replicate the animations in the app code " +
            "(same effects, durations, easings, stagger, states, loops and smart transitions)."
        );
    }

    protected async executeCore(args: GetAnimationSpecArgs): Promise<ToolResponse> {
        const spec: any = await this.callPlugin("getAnimationSpec", {}, args.sessionId);
        if (spec?.fileId && spec.fileId !== args.fileId) {
            throw new Error(
                `The connected Penpot tab has file ${spec.fileId} open, not ${args.fileId}; pass the tab's sessionId.`
            );
        }
        const mcpUrl = `http://${this.mcpServer.host}:${this.mcpServer.port}/mcp`;
        const workspace = await TidyUpTool.findWorkspace(
            AgentConfig.load(process.env, mcpUrl).projectsDir,
            args.fileId
        );
        const map = workspace ? await workspace.readJson<BuildMap | null>("map.json", null).catch(() => null) : null;
        return PenforgePluginTool.json(AnimationSpecMap.attach({ ...spec, fileId: spec?.fileId ?? args.fileId }, map));
    }
}
