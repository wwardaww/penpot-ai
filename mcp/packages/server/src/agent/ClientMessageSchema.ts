import { z } from "zod";
import type { ClientMessage } from "@penpot/mcp-common";

const id = z.string().min(1).max(256);
const base64 = z.string().max(20 * 1024 * 1024);

const attachment = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("node"),
        fileId: id,
        pageId: id,
        nodeId: id,
        name: z.string().max(1024),
        type: z.string().max(64),
        snapshotPng: base64.optional(),
    }),
    z.looseObject({ kind: z.literal("comment"), threadId: id }),
    z.object({ kind: z.literal("image"), mime: z.string().max(64), base64 }),
]);

/**
 * Validator of client messages (see `agent-protocol.ts`).
 *
 * Unknown fields are dropped, except inside comment attachments, which carry free-form data.
 */
export class ClientMessageSchema {
    private static readonly schema = z.discriminatedUnion("type", [
        z.object({ type: z.literal("auth"), token: z.string().max(512) }),
        z.object({
            type: z.literal("context.set"),
            fileId: id,
            fileName: z.string().max(1024),
            projectId: id,
            projectName: z.string().max(1024).optional(),
            teamId: id,
            pageId: id,
            persona: z.enum(["designer", "developer"]),
            platform: z.enum(["web", "mobile"]),
            mcpSessionId: z.string().min(1).max(128).optional(),
        }),
        z.object({
            type: z.literal("chat.send"),
            rid: id,
            conversationId: id,
            text: z.string().max(200_000),
            attachments: z.array(attachment).max(50).optional(),
        }),
        z.object({ type: z.literal("chat.cancel"), conversationId: id }),
        z.object({ type: z.literal("chat.history"), rid: id, conversationId: id }),
        z.object({
            type: z.literal("permission.respond"),
            requestId: id,
            allow: z.boolean(),
            remember: z.boolean().optional(),
        }),
        z.object({
            type: z.literal("workflow.run"),
            rid: id,
            name: z.string().min(1).max(128),
            params: z.record(z.string(), z.unknown()).optional(),
        }),
        z.object({ type: z.literal("workflow.cancel"), runId: id }),
        z.object({ type: z.literal("preview.start"), projectId: id }),
        z.object({ type: z.literal("preview.stop"), projectId: id }),
    ]);

    /**
     * Parses a raw message.
     *
     * @param raw - the parsed JSON value
     * @returns the message, or an error text
     */
    public static parse(raw: unknown): { message: ClientMessage } | { error: string; rid?: string } {
        const result = ClientMessageSchema.schema.safeParse(raw);
        if (result.success) {
            return { message: result.data as ClientMessage };
        }
        const rid = typeof (raw as { rid?: unknown })?.rid === "string" ? (raw as { rid: string }).rid : undefined;
        const issue = result.error.issues[0];
        return { error: `Invalid message: ${issue?.path.join(".") || "type"} ${issue?.message ?? ""}`.trim(), rid };
    }
}
