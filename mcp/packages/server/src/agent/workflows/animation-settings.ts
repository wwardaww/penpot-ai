import type { Workflow } from "@penpot/mcp-common";
import { AnimationSettings } from "../animations/AnimationSettings";

/** Params of `animation-settings`: `aiAnimations` changes the setting, missing only reads it. */
export interface AnimationSettingsParams {
    aiAnimations?: boolean;
}

/**
 * Reads or changes the project setting "AI may add animations" (W32, `.penforge/project.json`
 * `aiAnimations`, on by default). Emits `result` `{aiAnimations}`.
 */
export const workflow: Workflow<AnimationSettingsParams> = {
    name: "animation-settings",
    description: "Read or change whether the AI may add animations on its own.",
    run: async (ctx, params) => {
        const value = params?.aiAnimations;
        if (value !== undefined && typeof value !== "boolean") {
            throw new Error("aiAnimations must be true or false");
        }
        const on =
            value === undefined
                ? await AnimationSettings.isOn(ctx.workspace)
                : await AnimationSettings.set(ctx.workspace, value);
        ctx.emit("result", { aiAnimations: on });
        return { summary: on ? "AI may add animations" : "AI adds animations only when asked" };
    },
};
