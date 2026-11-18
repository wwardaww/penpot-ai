import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { dirname, relative, sep } from "path";
import {
    FILE_ATTACHMENT_LIMITS,
    type Attachment,
    type FileAttachment,
    type FileAttachmentGroup,
} from "@penpot/mcp-common";
import { AgentError } from "../AgentClient";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";

/**
 * Store of the files users attach to chat messages (`.penforge/uploads/` of the project).
 *
 * Checks every file attachment before anything is written: accepted media type, size limits per
 * file and per message, declared size, base64 encoding, and that the bytes match the type (image
 * and PDF signatures, UTF-8 text). A message with one bad file is refused as a whole. Files are
 * written under fresh, sanitized names, never outside the project folder.
 */
export class UploadStore {
    /** Folder of the uploads, relative to the project's metadata folder. */
    public static readonly FOLDER = "uploads";
    private static readonly BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
    private static readonly MAX_NAME_LENGTH = 80;

    constructor(private readonly workspace: ProjectWorkspace) {}

    /**
     * Checks and saves the file attachments of a message.
     *
     * @param attachments - the message's attachments (other kinds pass through unchanged)
     * @returns the attachments, file attachments with their `path` set (bytes kept for Claude)
     * @throws AgentError `bad-request` when a file is refused; nothing is written then
     */
    public async saveAll(attachments: Attachment[] | undefined): Promise<Attachment[] | undefined> {
        if (!attachments) {
            return attachments;
        }
        const files = attachments.filter((attachment): attachment is FileAttachment => attachment.kind === "file");
        const decoded = UploadStore.check(files);
        const saved = new Map<FileAttachment, string>();
        for (const file of files) {
            saved.set(file, await this.write(file.name, decoded.get(file)!));
        }
        return attachments.map((attachment) =>
            attachment.kind === "file" ? { ...attachment, path: saved.get(attachment) } : attachment
        );
    }

    /**
     * Checks file attachments without saving them.
     *
     * @returns the decoded bytes of every file
     * @throws AgentError `bad-request` naming the first problem
     */
    public static check(files: FileAttachment[]): Map<FileAttachment, Buffer> {
        if (files.length > FILE_ATTACHMENT_LIMITS.maxFiles) {
            throw UploadStore.refuse(`At most ${FILE_ATTACHMENT_LIMITS.maxFiles} files can be attached to one message`);
        }
        const decoded = new Map<FileAttachment, Buffer>();
        let total = 0;
        for (const file of files) {
            const bytes = UploadStore.checkFile(file);
            total += bytes.length;
            decoded.set(file, bytes);
        }
        if (total > FILE_ATTACHMENT_LIMITS.maxTotalBytes) {
            throw UploadStore.refuse(
                `The attached files are too large together (limit ${UploadStore.megabytes(FILE_ATTACHMENT_LIMITS.maxTotalBytes)})`
            );
        }
        return decoded;
    }

    /**
     * Group of a media type, or undefined when the type is not accepted.
     */
    public static group(mime: string): FileAttachmentGroup | undefined {
        return Object.prototype.hasOwnProperty.call(FILE_ATTACHMENT_LIMITS.types, mime)
            ? FILE_ATTACHMENT_LIMITS.types[mime]
            : undefined;
    }

    /**
     * Safe file name: no folders, only letters, digits, dot, dash and underscore, no leading dot,
     * at most 80 characters (keeping the extension).
     */
    public static safeName(name: string): string {
        const base = name.split(/[\\/]/).pop() ?? "";
        let safe = base
            .replace(/[^A-Za-z0-9._-]+/g, "_")
            .replace(/_+/g, "_")
            .replace(/^[._]+/, "");
        if (safe.length > UploadStore.MAX_NAME_LENGTH) {
            const dot = safe.lastIndexOf(".");
            const extension = dot > 0 && safe.length - dot <= 10 ? safe.slice(dot) : "";
            safe = safe.slice(0, UploadStore.MAX_NAME_LENGTH - extension.length) + extension;
        }
        return safe.length > 0 ? safe : "file";
    }

    private static checkFile(file: FileAttachment): Buffer {
        const group = UploadStore.group(file.mime);
        if (!group) {
            throw UploadStore.refuse(
                `"${file.name}" is not a supported file type; attach images (PNG, JPEG, GIF, WebP), PDFs or text files`
            );
        }
        if (
            file.base64 === undefined ||
            file.base64.length % 4 !== 0 ||
            !UploadStore.BASE64_PATTERN.test(file.base64)
        ) {
            throw UploadStore.refuse(`"${file.name}" could not be read`);
        }
        const bytes = Buffer.from(file.base64, "base64");
        const limit = FILE_ATTACHMENT_LIMITS.maxBytes[group];
        if (bytes.length > limit) {
            throw UploadStore.refuse(`"${file.name}" is too large (limit ${UploadStore.megabytes(limit)})`);
        }
        if (bytes.length !== file.size) {
            throw UploadStore.refuse(`"${file.name}" arrived incomplete`);
        }
        if (!UploadStore.matchesType(bytes, file.mime, group)) {
            throw UploadStore.refuse(`"${file.name}" does not contain what its type says (${file.mime})`);
        }
        return bytes;
    }

    private static matchesType(bytes: Buffer, mime: string, group: FileAttachmentGroup): boolean {
        const startsWith = (signature: number[] | string, offset = 0) => {
            const expected = typeof signature === "string" ? Buffer.from(signature, "latin1") : Buffer.from(signature);
            return (
                bytes.length >= offset + expected.length &&
                bytes.subarray(offset, offset + expected.length).equals(expected)
            );
        };
        switch (group) {
            case "image":
                switch (mime) {
                    case "image/png":
                        return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
                    case "image/jpeg":
                        return startsWith([0xff, 0xd8, 0xff]);
                    case "image/gif":
                        return startsWith("GIF87a") || startsWith("GIF89a");
                    case "image/webp":
                        return startsWith("RIFF") && startsWith("WEBP", 8);
                    default:
                        return false;
                }
            case "pdf":
                return startsWith("%PDF-");
            case "text":
                return UploadStore.isUtf8Text(bytes);
        }
    }

    private static isUtf8Text(bytes: Buffer): boolean {
        if (bytes.includes(0)) {
            return false;
        }
        try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            return true;
        } catch {
            return false;
        }
    }

    private async write(name: string, bytes: Buffer): Promise<string> {
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
        const stored = `${stamp}-${randomBytes(3).toString("hex")}-${UploadStore.safeName(name)}`;
        const file = this.workspace.metaPath(`${UploadStore.FOLDER}/${stored}`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes, { flag: "wx" });
        return relative(this.workspace.root, file).split(sep).join("/");
    }

    private static megabytes(bytes: number): string {
        return `${Math.round(bytes / (1024 * 1024))} MB`;
    }

    private static refuse(message: string): AgentError {
        return new AgentError("bad-request", message);
    }
}
