import type { Attachment, FileAttachment, WorkflowToolsApi } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import type { RunnerDocument, RunnerImage, RunnerInput } from "../runner/ClaudeRunner";
import { UploadStore } from "./UploadStore";

/**
 * Builder of Claude input from a user text and its attachments.
 *
 * Node attachments become a list of the attached layers, with a property summary from the
 * `get_node_properties` tool when that tool is available, and their snapshots become images.
 * Attached files become image or document blocks (images, PDFs) or inline text (text files, cut
 * at {@link AttachmentPrompt.MAX_TEXT_CHARS} characters); every file is listed with the path the
 * daemon saved it at, so Claude can read it again later.
 */
export class AttachmentPrompt {
    private static readonly PROPERTIES_TOOL = "get_node_properties";
    private static readonly MAX_PROPERTIES_CHARS = 6000;
    /** Most layers of one message that get a property summary (the chat attaches the selection). */
    private static readonly MAX_PROPERTY_LOOKUPS = 5;
    private static readonly IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    /** Most characters of one text file put inline. */
    public static readonly MAX_TEXT_CHARS = 100_000;
    private readonly logger = createLogger("AttachmentPrompt");

    /**
     * @param tools - Penpot tools of the client's tab, used for property summaries
     * @param timeoutMs - time limit for one property lookup
     */
    constructor(
        private readonly tools: WorkflowToolsApi | null,
        private readonly timeoutMs: number = 8000
    ) {}

    /**
     * Builds the input.
     *
     * @param text - the user's text
     * @param attachments - the attachments
     */
    public async build(text: string, attachments: Attachment[] = []): Promise<RunnerInput> {
        if (attachments.length === 0) {
            return { text };
        }
        const images: RunnerImage[] = [];
        const documents: RunnerDocument[] = [];
        const lines: string[] = [];
        const contents: string[] = [];
        const canLookUp = await this.hasPropertiesTool();
        let lookups = 0;
        for (const attachment of attachments) {
            switch (attachment.kind) {
                case "node": {
                    lines.push(
                        `- Layer "${attachment.name}" (type ${attachment.type}, nodeId ${attachment.nodeId}, ` +
                            `pageId ${attachment.pageId}, fileId ${attachment.fileId})`
                    );
                    if (canLookUp && lookups < AttachmentPrompt.MAX_PROPERTY_LOOKUPS) {
                        lookups++;
                        const summary = await this.properties(attachment.nodeId);
                        if (summary) {
                            lines.push("  Properties:", ...summary.split("\n").map((line) => `  ${line}`));
                        }
                    }
                    if (attachment.snapshotPng) {
                        images.push({ mime: "image/png", base64: attachment.snapshotPng });
                        lines.push(`  (snapshot image ${images.length} below)`);
                    }
                    break;
                }
                case "comment": {
                    const { kind: _kind, threadId, ...rest } = attachment;
                    lines.push(`- Comment thread ${threadId}: ${JSON.stringify(rest)}`);
                    break;
                }
                case "image": {
                    if (AttachmentPrompt.IMAGE_MIMES.has(attachment.mime)) {
                        images.push({ mime: attachment.mime, base64: attachment.base64 });
                        lines.push(`- Image ${images.length} below`);
                    }
                    break;
                }
                case "file": {
                    AttachmentPrompt.addFile(attachment, lines, images, documents, contents);
                    break;
                }
            }
        }
        const sections = contents.length > 0 ? `\n\n${contents.join("\n\n")}` : "";
        return {
            text: `${text}\n\nAttached by the user:\n${lines.join("\n")}${sections}`,
            images,
            ...(documents.length > 0 ? { documents } : {}),
        };
    }

    private static addFile(
        file: FileAttachment,
        lines: string[],
        images: RunnerImage[],
        documents: RunnerDocument[],
        contents: string[]
    ): void {
        const saved = file.path ? `, saved at ${file.path}` : "";
        const label = `File "${file.name}" (${file.mime}, ${file.size} bytes${saved})`;
        const group = UploadStore.group(file.mime);
        if (file.base64 === undefined || group === undefined) {
            lines.push(`- ${label}`);
            return;
        }
        switch (group) {
            case "image":
                images.push({ mime: file.mime, base64: file.base64 });
                lines.push(`- ${label}: image ${images.length} below`);
                break;
            case "pdf":
                documents.push({ mime: "application/pdf", base64: file.base64, title: file.name });
                lines.push(`- ${label}: document ${documents.length} below`);
                break;
            case "text": {
                const content = Buffer.from(file.base64, "base64").toString("utf8");
                const cut = content.length > AttachmentPrompt.MAX_TEXT_CHARS;
                lines.push(`- ${label}: its text follows`);
                contents.push(
                    `<attached-file name=${JSON.stringify(file.name)}>\n` +
                        (cut ? content.slice(0, AttachmentPrompt.MAX_TEXT_CHARS) : content) +
                        "\n</attached-file>" +
                        (cut
                            ? `\n(Only the first ${AttachmentPrompt.MAX_TEXT_CHARS} characters are shown; ` +
                              "read the saved file for the rest.)"
                            : "")
                );
                break;
            }
        }
    }

    private async hasPropertiesTool(): Promise<boolean> {
        if (!this.tools) {
            return false;
        }
        try {
            return (await this.withTimeout(this.tools.list())).includes(AttachmentPrompt.PROPERTIES_TOOL);
        } catch (error) {
            this.logger.debug("Tool list unavailable: %s", String(error));
            return false;
        }
    }

    private async properties(nodeId: string): Promise<string | null> {
        try {
            const result = await this.withTimeout(
                this.tools!.call(AttachmentPrompt.PROPERTIES_TOOL, { nodeId, depth: 1 })
            );
            if (result.isError || result.text.length === 0) {
                return null;
            }
            return result.text.length > AttachmentPrompt.MAX_PROPERTIES_CHARS
                ? `${result.text.slice(0, AttachmentPrompt.MAX_PROPERTIES_CHARS)}\n…(truncated)`
                : result.text;
        } catch (error) {
            this.logger.debug("Property lookup for %s failed: %s", nodeId, String(error));
            return null;
        }
    }

    private withTimeout<T>(promise: Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs);
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }
}
