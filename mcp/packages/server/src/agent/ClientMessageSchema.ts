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
    z.object({
        kind: z.literal("file"),
        name: z.string().min(1).max(255),
        mime: z.string().max(128),
        size: z.number().int().nonnegative(),
        base64: base64.optional(),
    }),
    z.object({
        kind: z.literal("folder"),
        name: z.string().min(1).max(255),
        files: z
            .array(
                z.object({
                    path: z.string().min(1).max(1024),
                    size: z.number().int().nonnegative(),
                    base64: base64.optional(),
                })
            )
            .max(1000),
    }),
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
            platform: z.enum(["web", "mobile", "game", "existing"]),
            mcpSessionId: z.string().min(1).max(128).optional(),
        }),
        z.object({
            type: z.literal("chat.send"),
            rid: id,
            conversationId: id,
            text: z.string().max(200_000),
            attachments: z.array(attachment).max(50).optional(),
            selectionDismissed: z.boolean().optional(),
            messageId: id.optional(),
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
        z.object({ type: z.literal("preview.start"), rid: id.optional(), projectId: id }),
        z.object({ type: z.literal("preview.stop"), rid: id.optional(), projectId: id }),
        // W33: built apps on the dashboard
        z.object({ type: z.literal("apps.list"), rid: id, teamId: id.optional() }),
        z.object({ type: z.literal("apps.start"), rid: id, projectId: id }),
        z.object({ type: z.literal("apps.stop"), rid: id, projectId: id }),
        z.object({ type: z.literal("apps.logs"), rid: id, projectId: id }),
        z.object({ type: z.literal("apps.phone.start"), rid: id, projectId: id, confirmed: z.literal(true) }),
        z.object({ type: z.literal("apps.phone.stop"), rid: id.optional(), projectId: id }),
        // W37: message actions in the chat
        z.object({
            type: z.literal("chat.edit"),
            rid: id,
            conversationId: id,
            messageId: id,
            text: z.string().max(200_000),
            newMessageId: id.optional(),
            selectionDismissed: z.boolean().optional(),
        }),
        z.object({ type: z.literal("chat.delete"), rid: id, conversationId: id, messageId: id }),
        z.object({
            type: z.literal("chat.revert"),
            rid: id,
            conversationId: id,
            messageId: id,
            confirmed: z.literal(true),
        }),
        // W38: folder browser and project links
        z.object({ type: z.literal("folder.list"), rid: id, path: z.string().max(4096).optional() }),
        z.object({
            type: z.literal("project.link"),
            rid: id,
            projectId: id,
            kind: z.enum(["game", "existing"]),
            path: z.string().min(1).max(4096),
        }),
        z.object({ type: z.literal("project.link.status"), rid: id, projectId: id }),
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
