import { deflateRawSync, gzipSync } from "node:zlib";

/** A file to put into a test archive. */
export interface TestFile {
    path: string;
    content: string | Buffer;
}

/** Builds a gzip-compressed tar (ustar; paths over 100 chars get a pax `path` record). */
export function tarGz(files: TestFile[]): Buffer {
    const blocks: Buffer[] = [];
    for (const file of files) {
        const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
        if (Buffer.byteLength(file.path) > 100) {
            const record = paxRecord("path", file.path);
            blocks.push(header("PaxHeader", record.length, "x"), pad(record));
        }
        blocks.push(header(file.path.slice(0, 100), data.length, "0"), pad(data));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}

/** Builds a zip archive (first file stored, the others deflated). */
export function zip(files: TestFile[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    files.forEach((file, index) => {
        const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
        const method = index === 0 ? 0 : 8;
        const body = method === 0 ? data : deflateRawSync(data);
        const name = Buffer.from(file.path, "utf8");
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(0, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    });
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

function header(name: string, size: number, type: string): Buffer {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100, "utf8");
    block.write("0000644\0", 100, "latin1");
    block.write("0000000\0", 108, "latin1");
    block.write("0000000\0", 116, "latin1");
    block.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
    block.write("00000000000\0", 136, "latin1");
    block.write(type, 156, "latin1");
    block.write("ustar\0", 257, "latin1");
    block.write("00", 263, "latin1");
    block.fill(32, 148, 156);
    let sum = 0;
    for (const byte of block) {
        sum += byte;
    }
    block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
    return block;
}

function pad(data: Buffer): Buffer {
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    return padded;
}

function paxRecord(key: string, value: string): Buffer {
    const body = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 1;
    while (String(length).length + Buffer.byteLength(body) !== length) {
        length = String(length).length + Buffer.byteLength(body);
    }
    return Buffer.from(`${length}${body}`, "utf8");
}

/** A small stroke icon in the lucide style. */
export function strokeIcon(d: string = "M5 12h14"): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}
