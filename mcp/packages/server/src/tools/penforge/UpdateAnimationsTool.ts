import { z } from "zod";
import { Tool } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { AnimationSchemas } from "./AnimationSchemas";
import { PenforgePluginTool } from "./PenforgePluginTool";

/**
 * Arguments of {@link UpdateAnimationsTool}.
 */
export class UpdateAnimationsArgs {
    static schema = {
        operations: z
            .array(AnimationSchemas.OPERATION)
            .min(1)
            .max(100)
            .describe("Changes, applied in order; all layers must be on one page."),
        sessionId: Tool.SESSION_ID_SCHEMA,
    };

    operations!: z.infer<typeof AnimationSchemas.OPERATION>[];

    sessionId?: string;
}

/**
 * Sets, updates and removes layer animations (W31 specs) through the Plugin API (W32).
 */
export class UpdateAnimationsTool extends PenforgePluginTool<UpdateAnimationsArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, UpdateAnimationsArgs.schema);
    }

    public getToolName(): string {
        return "update_animations";
    }

    public getToolDescription(): string {
        return (
            "Animates layers (Penforge): entrance and exit (effects fade, slide up/down/left/right, scale, " +
            "blur; duration, delay, easing; `stagger` animates the direct children one after the other, " +
            "e.g. the cards of a list), hover and press states (scale, opacity, offset, fill, shadow), " +
            "loops (pulse, spin, bounce, shimmer) and smart animate on a navigate/overlay interaction. " +
            "Ops: `set` replaces the given sections, `update` merges fields (null removes one), `remove` " +
            "drops sections or everything, `set-smart`/`remove-smart` by interaction index. Example: " +
            '{op:"set", nodeId:<list>, entrance:{effects:[{type:"fade"},{type:"slide",direction:"up",' +
            'distance:16}], duration:300, easing:"ease-out", stagger:{each:60}}}. Keep motion subtle: ' +
            "150-400 ms, standard easings. All layers must be on one page (opened if needed); every " +
            "result is validated before the first change and the whole call is one undo step. The file " +
            "only stores the animation: it plays in View mode and from the chat's Play button. Returns " +
            "`{pageId, undoGrouped, results:[{nodeId, name, type, status set|removed|unchanged, " +
            "animations, warnings?}]}`."
        );
    }

    protected async executeCore(args: UpdateAnimationsArgs): Promise<ToolResponse> {
        const data = await this.callPlugin("updateAnimations", { operations: args.operations }, args.sessionId);
        return PenforgePluginTool.json(data);
    }
}
