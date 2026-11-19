import { pipeline, Readable } from "node:stream";
import { createGunzip, inflateRawSync } from "node:zlib";
import { IconImportError } from "./IconLimits";

/** A file of an archive the caller asked for. */
export interface ArchiveEntry {
    /** path inside the archive, `/`-separated */
    path: string;
    /** the bytes, or null when the file was larger than `maxEntryBytes` */
    data: Buffer | null;
    /** size of the file in bytes */
    size: number;
}

/** What to read from an archive. */
export interface ArchiveOptions {
    /** whether to read the file at this path (others are skipped without buffering) */
    wanted(path: string): boolean;
    /** a wanted file larger than this comes back with `data: null` */
    maxEntryBytes(path: string): number;
    /** fails with `too-large` when the archive unpacks to more than this many bytes */
    maxUnpackedBytes: number;
}

const BLOCK = 512;

/**
 * Reads the regular files of a gzip-compressed tar stream (GitHub `archive/<ref>.tar.gz`):
 * ustar names with prefix, pax `path` records and GNU long names. Files nobody wants are skipped
 * as they stream by; links, devices and folders are ignored. Never writes to disk.
 *
 * @param source - the compressed bytes
 */
export async function* readTarGz(source: AsyncIterable<Buffer>, options: ArchiveOptions): AsyncGenerator<ArchiveEntry> {
    const unpacked = createGunzip();
    // an error of the source (too large, cancelled) destroys the gunzip stream with that error,
    // so iterating it fails the same way
    pipeline(Readable.from(source), unpacked, () => {});
    let total = 0;
    async function* checked(): AsyncGenerator<Buffer> {
        try {
            for await (const chunk of unpacked) {
                total += (chunk as Buffer).length;
                if (total > options.maxUnpackedBytes) {
                    throw new IconImportError("too-large", "The archive unpacks to too many bytes", {
                        limitMb: Math.round(options.maxUnpackedBytes / 1048576),
                    });
                }
                yield chunk as Buffer;
            }
        } catch (error) {
            if (error instanceof IconImportError) {
                throw error;
            }
            throw new IconImportError("bad-archive", `The archive is broken: ${(error as Error).message}`);
        }
    }
    yield* readTar(checked(), options);
}

/**
 * Reads the regular files of an uncompressed tar stream (see {@link readTarGz}).
 */
export async function* readTar(source: AsyncIterable<Buffer>, options: ArchiveOptions): AsyncGenerator<ArchiveEntry> {
    const reader = new ByteQueue(source);
    let longName: string | null = null;
    let paxPath: string | null = null;
    for (;;) {
        const header = await reader.read(BLOCK);
        if (header === null || header.length < BLOCK) {
            return;
        }
        if (header.every((byte) => byte === 0)) {
            return;
        }
        if (!checksumOk(header)) {
            throw new IconImportError("bad-archive", "The archive is not a tar file");
        }
        const size = parseSize(header.subarray(124, 136));
        const type = String.fromCharCode(header[156] || 48);
        const padded = Math.ceil(size / BLOCK) * BLOCK;
        const magic = header.subarray(257, 262).toString("latin1");
        const prefix = magic === "ustar" ? cString(header.subarray(345, 500)) : "";
        const ownName = cString(header.subarray(0, 100));
        const name = paxPath ?? longName ?? (prefix ? `${prefix}/${ownName}` : ownName);

        if (type === "L" || type === "x" || type === "g") {
            const body = await reader.read(padded);
            if (body === null) {
                return;
            }
            const content = body.subarray(0, size);
            if (type === "L") {
                longName = cString(content);
            } else if (type === "x") {
                paxPath = paxRecord(content, "path");
            }
            continue;
        }
        longName = null;
        paxPath = null;

        const regular = type === "0" || type === "\0" || type === "7";
        const path = name.replace(/\\/g, "/");
        if (!regular || !options.wanted(path)) {
            if (!(await reader.skip(padded))) {
                return;
            }
            continue;
        }
        if (size > options.maxEntryBytes(path)) {
            if (!(await reader.skip(padded))) {
                return;
            }
            yield { path, data: null, size };
            continue;
        }
        const body = await reader.read(padded);
        if (body === null) {
            throw new IconImportError("bad-archive", "The archive ends in the middle of a file");
        }
        yield { path, data: Buffer.from(body.subarray(0, size)), size };
    }
}

/**
 * Reads the wanted files of a zip archive held in memory (release assets). Stored and deflated
 * entries only; zip64 and encrypted archives are refused.
 *
 * @param zip - the archive bytes
 */
export function readZip(zip: Buffer, options: ArchiveOptions): ArchiveEntry[] {
    const eocd = findEndOfCentralDirectory(zip);
    const count = zip.readUInt16LE(eocd + 10);
    const directorySize = zip.readUInt32LE(eocd + 12);
    let offset = zip.readUInt32LE(eocd + 16);
    if (count === 0xffff || offset === 0xffffffff || directorySize === 0xffffffff) {
        throw new IconImportError("bad-archive", "Zip64 archives are not supported");
    }
    const entries: ArchiveEntry[] = [];
    let unpacked = 0;
    for (let index = 0; index < count; index++) {
        if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) {
            throw new IconImportError("bad-archive", "The zip directory is broken");
        }
        const flags = zip.readUInt16LE(offset + 8);
        const method = zip.readUInt16LE(offset + 10);
        const compressedSize = zip.readUInt32LE(offset + 20);
        const size = zip.readUInt32LE(offset + 24);
        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        const localOffset = zip.readUInt32LE(offset + 42);
        const path = zip
            .subarray(offset + 46, offset + 46 + nameLength)
            .toString(flags & 0x800 ? "utf8" : "latin1")
            .replace(/\\/g, "/");
        offset += 46 + nameLength + extraLength + commentLength;

        if (path.endsWith("/") || !options.wanted(path)) {
            continue;
        }
        if (flags & 0x1) {
            throw new IconImportError("bad-archive", "Encrypted zip archives are not supported");
        }
        if (size > options.maxEntryBytes(path)) {
            entries.push({ path, data: null, size });
            continue;
        }
        unpacked += size;
        if (unpacked > options.maxUnpackedBytes) {
            throw new IconImportError("too-large", "The archive unpacks to too many bytes", {
                limitMb: Math.round(options.maxUnpackedBytes / 1048576),
            });
        }
        if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new IconImportError("bad-archive", "A zip entry is broken");
        }
        const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
        const compressed = zip.subarray(dataStart, dataStart + compressedSize);
        let data: Buffer;
        if (method === 0) {
            data = Buffer.from(compressed);
        } else if (method === 8) {
            try {
                data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
            } catch (error) {
                throw new IconImportError("bad-archive", `A zip entry is broken: ${(error as Error).message}`);
            }
        } else {
            throw new IconImportError("bad-archive", `Unsupported zip compression ${method}`);
        }
        if (data.length !== size) {
            throw new IconImportError("bad-archive", "A zip entry has the wrong size");
        }
        entries.push({ path, data, size });
    }
    return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
    const lowest = Math.max(0, zip.length - 22 - 0xffff);
    for (let index = zip.length - 22; index >= lowest; index--) {
        if (zip.readUInt32LE(index) === 0x06054b50) {
            return index;
        }
    }
    throw new IconImportError("bad-archive", "The file is not a zip archive");
}

function cString(bytes: Buffer): string {
    const end = bytes.indexOf(0);
    return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function parseSize(field: Buffer): number {
    if (field[0] & 0x80) {
        // base-256 (GNU) for files of 8 GB and more
        let value = 0;
        for (let index = 1; index < field.length; index++) {
            value = value * 256 + field[index];
        }
        return value;
    }
    const text = cString(field).trim();
    const value = text.length === 0 ? 0 : parseInt(text, 8);
    if (!Number.isFinite(value) || value < 0) {
        throw new IconImportError("bad-archive", "The archive has a broken size field");
    }
    return value;
}

function checksumOk(header: Buffer): boolean {
    const stored = parseInt(cString(header.subarray(148, 156)).trim(), 8);
    let sum = 0;
    for (let index = 0; index < BLOCK; index++) {
        sum += index >= 148 && index < 156 ? 32 : header[index];
    }
    return stored === sum;
}

function paxRecord(content: Buffer, key: string): string | null {
    let offset = 0;
    let found: string | null = null;
    while (offset < content.length) {
        const space = content.indexOf(32, offset);
        if (space === -1) {
            break;
        }
        const length = parseInt(content.subarray(offset, space).toString("latin1"), 10);
        if (!Number.isFinite(length) || length <= 0) {
            break;
        }
        const record = content.subarray(space + 1, offset + length - 1).toString("utf8");
        const equals = record.indexOf("=");
        if (equals !== -1 && record.slice(0, equals) === key) {
            found = record.slice(equals + 1);
        }
        offset += length;
    }
    return found;
}

/** Reads exact byte counts from a chunked stream. */
class ByteQueue {
    private readonly iterator: AsyncIterator<Buffer>;
    private chunks: Buffer[] = [];
    private buffered = 0;
    private done = false;

    constructor(source: AsyncIterable<Buffer>) {
        this.iterator = source[Symbol.asyncIterator]();
    }

    /** Reads `count` bytes; fewer at the end of the stream, null when nothing is left. */
    public async read(count: number): Promise<Buffer | null> {
        while (this.buffered < count && !this.done) {
            await this.pull();
        }
        if (this.buffered === 0) {
            return null;
        }
        const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
        const taken = all.subarray(0, Math.min(count, all.length));
        const rest = all.subarray(taken.length);
        this.chunks = rest.length > 0 ? [rest] : [];
        this.buffered = rest.length;
        return taken;
    }

    /** Drops `count` bytes without keeping them; false when the stream ended first. */
    public async skip(count: number): Promise<boolean> {
        let left = count;
        while (left > 0) {
            if (this.buffered === 0) {
                if (this.done) {
                    return false;
                }
                await this.pull();
                continue;
            }
            const head = this.chunks[0];
            if (head.length <= left) {
                left -= head.length;
                this.buffered -= head.length;
                this.chunks.shift();
            } else {
                this.chunks[0] = head.subarray(left);
                this.buffered -= left;
                left = 0;
            }
        }
        return true;
    }

    private async pull(): Promise<void> {
        const next = await this.iterator.next();
        if (next.done) {
            this.done = true;
            return;
        }
        this.chunks.push(next.value);
        this.buffered += next.value.length;
    }
}
