import type { Attachment, Workflow } from "@penpot/mcp-common";

/** Params of the `chat` workflow. */
export interface ChatParams {
    text: string;
    attachments?: Attachment[];
}

/**
 * Free chat as a workflow: one Claude turn with the user's text and attached nodes.
 *
 * Streams the answer as `workflow.event` kind `progress` (`{text}` deltas) and reports it as kind
 * `result`. For conversations with history, clients use `chat.send` instead.
 */
export const workflow: Workflow<ChatParams> = {
    name: "chat",
    description: "Free chat about the open design, with optional attached nodes.",
    run: async (ctx, params) => {
        if (typeof params?.text !== "string" || params.text.trim().length === 0) {
            throw new Error("chat needs a non-empty text");
        }
        const result = await ctx.runner.run({
            prompt: params.text,
            attachments: params.attachments,
            onEvent: (event) => {
                if (event.kind === "text") {
                    ctx.emit("progress", { text: event.text });
                }
            },
        });
        ctx.emit("result", { text: result.text });
        return { summary: result.text };
    },
};
