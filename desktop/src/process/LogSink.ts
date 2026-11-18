import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only log file of one service, plus the last lines in memory (shown when a service
 * fails). The file is rotated once at open when it is bigger than `maxBytes` (one `.1` copy).
 */
export class LogSink {
    private stream: WriteStream;
    private readonly tail: string[] = [];
    private partial = "";

    constructor(
        public readonly file: string,
        maxBytes = 10 * 1024 * 1024,
        private readonly tailLines = 200,
    ) {
        mkdirSync(dirname(file), { recursive: true });
        if (existsSync(file) && statSync(file).size > maxBytes) {
            const old = `${file}.1`;
            rmSync(old, { force: true });
            renameSync(file, old);
        }
        this.stream = createWriteStream(file, { flags: "a" });
    }

    /** Writes raw output of the process. */
    public write(chunk: Buffer | string): void {
        const text = chunk.toString();
        this.stream.write(text);
        const lines = (this.partial + text).split(/\r?\n/);
        this.partial = lines.pop() ?? "";
        for (const line of lines) {
            this.remember(line);
        }
    }

    /** Writes one line from the supervisor itself, with a timestamp. */
    public note(message: string): void {
        const line = `[${new Date().toISOString()}] [desktop] ${message}`;
        this.stream.write(`${line}\n`);
        this.remember(line);
    }

    /** The last lines written, oldest first. */
    public lastLines(count = 40): string[] {
        const lines = this.partial ? [...this.tail, this.partial] : [...this.tail];
        return lines.slice(-count);
    }

    public close(): Promise<void> {
        return new Promise((resolve) => this.stream.end(resolve));
    }

    private remember(line: string): void {
        this.tail.push(line);
        if (this.tail.length > this.tailLines) {
            this.tail.shift();
        }
    }
}
