import type { Workflow } from "@penpot/mcp-common";
import { type ProjectReadParams, ProjectReader } from "../linked/ProjectReader";

/**
 * Background read of a Game UI / Existing project's linked folder (W38).
 *
 * Lists the files to read (`.penforge/source-index.json`), then lets Claude read them read-only and
 * write `.penforge/project-brief.md`, which every later chat and workflow turn of the project gets.
 * Emits `progress {step: inventory|read|brief, params, text}` and `result` (`ProjectReadResult`):
 * `state` `ready`, `unchanged` (no file changed since the last read) or `not-linked` (`reason`
 * `none` / `missing`: the client asks for the folder again). Params: `{force?}` reads everything
 * again.
 */
export const workflow: Workflow<ProjectReadParams> = {
    name: "project-read",
    description: "Reads the linked folder of a Game UI or Existing project and writes its brief.",
    run: async (ctx, params) => {
        const result = await new ProjectReader(ctx).run(params ?? {});
        ctx.emit("result", result);
        switch (result.state) {
            case "not-linked":
                return { summary: "The project has no linked folder on this computer" };
            case "unchanged":
                return { summary: `Project read: nothing changed (${result.files} files)` };
            default:
                return { summary: `Project read: ${result.files} files, brief written` };
        }
    },
};
