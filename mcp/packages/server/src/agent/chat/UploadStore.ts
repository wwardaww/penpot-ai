import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join, relative, sep } from "path";
import {
    FILE_ATTACHMENT_LIMITS,
    FOLDER_ATTACHMENT_LIMITS,
    type Attachment,
    type FileAttachment,
    type FileAttachmentGroup,
    type FolderAttachment,
} from "@penpot/mcp-common";
import { AgentError } from "../AgentClient";
import type { ProjectWorkspace } from "../workspace/ProjectWorkspace";

/** Reason of a refused file, sent in the `error` message for clients to translate. */
export type UploadRefusal =
    | "file-type"
    | "file-size"
    | "file-count"
    | "files-total"
    | "file-read"
    | "file-incomplete"
    | "folder-empty"
    | "folder-count"
    | "folder-file-size"
    | "folder-path";

/**
 * Refusal of the files of a chat message: a `bad-request` with a reason code and its parameters.
 */
export class UploadRefusedError extends AgentError {
    constructor(
        public readonly reason: UploadRefusal,
        public readonly params: Record<string, unknown>,
        message: string
    ) {
        super("bad-request", message);
        this.name = "UploadRefusedError";
    }
}

/** A checked file: its bytes and its real media type. */
interface CheckedFile {
    bytes: Buffer;
    mime: string;
}

/** A checked file of a folder attachment: its bytes and its safe path segments. */
export interface CheckedFolderFile {
    segments: string[];
    bytes: Buffer;
}

/**
 * Store of the files users attach to chat messages (`.penforge/uploads/` of the project) and of
 * the folders they attach (`.penforge/sources/`).
 *
 * Checks every file attachment before anything is written: accepted media type, size limits per
 * file and per message, declared size and base64 encoding. Folder files may be of any type; their
 * paths must stay inside the folder and they count toward the message's total size. The bytes decide the type: an image or
 * PDF whose bytes show another accepted type (a JPEG named `.png`) gets the real type, UTF-16 text
 * is converted to UTF-8, and anything else that does not match is refused. A message with one bad
 * file is refused as a whole. Files are written under fresh, sanitized names, never outside the
 * project folder.
 */
export class UploadStore {
    /** Folder of the uploads, relative to the project's metadata folder. */
    public static readonly FOLDER = "uploads";
    /** Folder of the attached folders, relative to the project's metadata folder. */
    public static readonly SOURCES_FOLDER = "sources";
    private static readonly MAX_PATH_DEPTH = 32;
    private static readonly WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
    private static readonly BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
    private static readonly MAX_NAME_LENGTH = 80;

    constructor(private readonly workspace: ProjectWorkspace) {}

    /**
     * Checks and saves the file and folder attachments of a message.
     *
     * @param attachments - the message's attachments (other kinds pass through unchanged)
     * @returns the attachments, file attachments with their real type, size and `path` (bytes kept
     *   for Claude), folder attachments with their `path` and the stored paths of their files (no
     *   bytes: Claude reads them from the folder)
     * @throws UploadRefusedError when a file or folder is refused; nothing is written then
     */
    public async saveAll(attachments: Attachment[] | undefined): Promise<Attachment[] | undefined> {
        if (!attachments) {
            return attachments;
        }
        const files = attachments.filter((attachment): attachment is FileAttachment => attachment.kind === "file");
        const folders = attachments.filter(
            (attachment): attachment is FolderAttachment => attachment.kind === "folder"
        );
        const checked = UploadStore.check(files);
        let total = 0;
        for (const { bytes } of checked.values()) {
            total += bytes.length;
        }
        const checkedFolders = new Map<FolderAttachment, CheckedFolderFile[]>();
        for (const folder of folders) {
            const folderFiles = UploadStore.checkFolder(folder);
            total += folderFiles.reduce((sum, file) => sum + file.bytes.length, 0);
            checkedFolders.set(folder, folderFiles);
        }
        if (total > FILE_ATTACHMENT_LIMITS.maxTotalBytes) {
            throw UploadStore.totalRefusal();
        }
        const saved = new Map<Attachment, Attachment>();
        for (const file of files) {
            const { bytes, mime } = checked.get(file)!;
            const path = await this.write(file.name, bytes);
            saved.set(file, { ...file, mime, size: bytes.length, base64: bytes.toString("base64"), path });
        }
        for (const folder of folders) {
            saved.set(folder, await this.writeFolder(folder.name, checkedFolders.get(folder)!));
        }
        return attachments.map((attachment) => saved.get(attachment) ?? attachment);
    }

    /**
     * Checks the files of a folder attachment without saving them.
     *
     * @returns the bytes and the safe path segments of every file
     * @throws UploadRefusedError naming the first problem
     */
    public static checkFolder(folder: FolderAttachment): CheckedFolderFile[] {
        if (folder.files.length === 0) {
            throw new UploadRefusedError("folder-empty", { name: folder.name }, `The folder "${folder.name}" is empty`);
        }
        if (folder.files.length > FOLDER_ATTACHMENT_LIMITS.maxFiles) {
            throw new UploadRefusedError(
                "folder-count",
                { name: folder.name, limit: FOLDER_ATTACHMENT_LIMITS.maxFiles },
                `The folder "${folder.name}" has more than ${FOLDER_ATTACHMENT_LIMITS.maxFiles} files`
            );
        }
        return folder.files.map((file) => {
            const segments = UploadStore.pathSegments(file.path);
            if (!segments) {
                throw new UploadRefusedError(
                    "folder-path",
                    { name: file.path },
                    `"${file.path}" is not a valid path inside the folder`
                );
            }
            if (
                file.base64 === undefined ||
                file.base64.length % 4 !== 0 ||
                !UploadStore.BASE64_PATTERN.test(file.base64)
            ) {
                throw new UploadRefusedError("file-read", { name: file.path }, `"${file.path}" could not be read`);
            }
            const bytes = Buffer.from(file.base64, "base64");
            if (bytes.length !== file.size) {
                throw new UploadRefusedError(
                    "file-incomplete",
                    { name: file.path },
                    `"${file.path}" arrived incomplete`
                );
            }
            if (bytes.length > FOLDER_ATTACHMENT_LIMITS.maxFileBytes) {
                const limitMb = UploadStore.megabytes(FOLDER_ATTACHMENT_LIMITS.maxFileBytes);
                throw new UploadRefusedError(
                    "folder-file-size",
                    { name: file.path, limitMb },
                    `"${file.path}" is too large (limit ${limitMb} MB per file in a folder)`
                );
            }
            return { segments, bytes };
        });
    }

    /**
     * Safe segments of a path inside an attached folder, or null when the path leaves the folder
     * (`..`), is absolute, empty or too deep. Every segment becomes a {@link safeName}; Windows
     * device names get a leading dash.
     */
    public static pathSegments(path: string): string[] | null {
        if (/^([A-Za-z]:|[\\/])/.test(path)) {
            return null;
        }
        const parts = path.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
        if (parts.length === 0 || parts.length > UploadStore.MAX_PATH_DEPTH || parts.includes("..")) {
            return null;
        }
        return parts.map((part) => {
            const safe = UploadStore.safeName(part);
            return UploadStore.WINDOWS_RESERVED.test(safe) ? `-${safe}` : safe;
        });
    }

    /**
     * Joined path of `segments` not yet in `used` (case-insensitive, as on Windows and macOS):
     * a clash gets "-2", "-3"… before the extension. Adds the result to `used`.
     */
    public static uniquePath(segments: string[], used: Set<string>): string {
        const joined = segments.join("/");
        const slash = joined.lastIndexOf("/");
        const dot = joined.lastIndexOf(".");
        let candidate = joined;
        for (let n = 2; used.has(candidate.toLowerCase()); n++) {
            candidate = dot > slash + 1 ? `${joined.slice(0, dot)}-${n}${joined.slice(dot)}` : `${joined}-${n}`;
        }
        used.add(candidate.toLowerCase());
        return candidate;
    }

    /**
     * Checks file attachments without saving them.
     *
     * @returns the bytes and real type of every file
     * @throws UploadRefusedError naming the first problem
     */
    public static check(files: FileAttachment[]): Map<FileAttachment, CheckedFile> {
        if (files.length > FILE_ATTACHMENT_LIMITS.maxFiles) {
            throw new UploadRefusedError(
                "file-count",
                { limit: FILE_ATTACHMENT_LIMITS.maxFiles },
                `At most ${FILE_ATTACHMENT_LIMITS.maxFiles} files can be attached to one message`
            );
        }
        const checked = new Map<FileAttachment, CheckedFile>();
        let total = 0;
        for (const file of files) {
            const result = UploadStore.checkFile(file);
            total += result.bytes.length;
            checked.set(file, result);
        }
        if (total > FILE_ATTACHMENT_LIMITS.maxTotalBytes) {
            throw UploadStore.totalRefusal();
        }
        return checked;
    }

    private static totalRefusal(): UploadRefusedError {
        const limitMb = UploadStore.megabytes(FILE_ATTACHMENT_LIMITS.maxTotalBytes);
        return new UploadRefusedError(
            "files-total",
            { limitMb },
            `The attached files are too large together (limit ${limitMb} MB)`
        );
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

    /**
     * Media type of binary content from its first bytes (accepted images and PDF), or undefined.
     */
    public static sniff(bytes: Buffer): string | undefined {
        const startsWith = (signature: number[] | string, offset = 0) => {
            const expected = typeof signature === "string" ? Buffer.from(signature, "latin1") : Buffer.from(signature);
            return (
                bytes.length >= offset + expected.length &&
                bytes.subarray(offset, offset + expected.length).equals(expected)
            );
        };
        if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
            return "image/png";
        }
        if (startsWith([0xff, 0xd8, 0xff])) {
            return "image/jpeg";
        }
        if (startsWith("GIF87a") || startsWith("GIF89a")) {
            return "image/gif";
        }
        if (startsWith("RIFF") && startsWith("WEBP", 8)) {
            return "image/webp";
        }
        if (startsWith("%PDF-")) {
            return "application/pdf";
        }
        return undefined;
    }

    private static checkFile(file: FileAttachment): CheckedFile {
        const declared = UploadStore.group(file.mime);
        if (!declared) {
            throw new UploadRefusedError(
                "file-type",
                { name: file.name },
                `"${file.name}" is not a supported file type; attach images (PNG, JPEG, GIF, WebP), PDFs or text files`
            );
        }
        if (
            file.base64 === undefined ||
            file.base64.length % 4 !== 0 ||
            !UploadStore.BASE64_PATTERN.test(file.base64)
        ) {
            throw new UploadRefusedError("file-read", { name: file.name }, `"${file.name}" could not be read`);
        }
        const raw = Buffer.from(file.base64, "base64");
        if (raw.length !== file.size) {
            throw new UploadRefusedError("file-incomplete", { name: file.name }, `"${file.name}" arrived incomplete`);
        }
        const checked = UploadStore.realContent(raw, file.mime, declared);
        if (!checked) {
            throw new UploadRefusedError(
                "file-type",
                { name: file.name },
                `"${file.name}" does not contain an image, a PDF or UTF-8/UTF-16 text`
            );
        }
        const limit = FILE_ATTACHMENT_LIMITS.maxBytes[UploadStore.group(checked.mime)!];
        if (checked.bytes.length > limit) {
            const limitMb = UploadStore.megabytes(limit);
            throw new UploadRefusedError(
                "file-size",
                { name: file.name, limitMb },
                `"${file.name}" is too large (limit ${limitMb} MB)`
            );
        }
        return checked;
    }

    /**
     * The bytes and real type of a file: binary content is recognised by its signature whatever
     * the declared type; text must be UTF-8 or UTF-16 with a byte order mark (converted to UTF-8).
     */
    private static realContent(bytes: Buffer, mime: string, declared: FileAttachmentGroup): CheckedFile | null {
        const sniffed = UploadStore.sniff(bytes);
        if (sniffed) {
            return { bytes, mime: sniffed };
        }
        if (declared !== "text") {
            return null;
        }
        const text = UploadStore.decodeText(bytes);
        return text === null ? null : { bytes: Buffer.from(text, "utf8"), mime };
    }

    private static decodeText(bytes: Buffer): string | null {
        try {
            if (bytes[0] === 0xff && bytes[1] === 0xfe) {
                return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
            }
            if (bytes[0] === 0xfe && bytes[1] === 0xff) {
                return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
            }
            if (bytes.includes(0)) {
                return null;
            }
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
            return null;
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

    private async writeFolder(name: string, files: CheckedFolderFile[]): Promise<FolderAttachment> {
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
        const folder = this.workspace.metaPath(
            `${UploadStore.SOURCES_FOLDER}/${stamp}-${randomBytes(3).toString("hex")}-${UploadStore.safeName(name)}`
        );
        const used = new Set<string>();
        const stored: FolderAttachment["files"] = [];
        for (const { segments, bytes } of files) {
            const path = UploadStore.uniquePath(segments, used);
            const file = join(folder, ...path.split("/"));
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, bytes, { flag: "wx" });
            stored.push({ path, size: bytes.length });
        }
        return {
            kind: "folder",
            name,
            files: stored,
            path: relative(this.workspace.root, folder).split(sep).join("/"),
        };
    }

    /** Megabytes of a byte count, with up to two decimals ("3.75", "20"). */
    public static megabytes(bytes: number): string {
        return String(Math.round((bytes / (1024 * 1024)) * 100) / 100);
    }
}
