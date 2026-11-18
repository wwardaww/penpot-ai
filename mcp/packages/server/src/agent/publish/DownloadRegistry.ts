import { randomBytes } from "crypto";
import type { Readable } from "stream";

/** File waiting to be downloaded once. */
export interface PendingDownload {
    filename: string;
    contentType: string;
    /** the bytes, or a function that starts streaming them when the download begins */
    content: Buffer | (() => Readable);
}

/**
 * Store of files the browser may download once over plain HTTP (`GET /download/<id>`).
 *
 * The page holds no daemon token, so the random id (256 bits) is the only key: each entry can be
 * taken once and expires after a short time.
 */
export class DownloadRegistry {
    /** Default life time of an entry. */
    public static readonly TTL_MS = 2 * 60_000;
    private static readonly ID = /^[A-Za-z0-9_-]{43}$/;
    private static readonly MAX_ENTRIES = 16;

    private readonly entries = new Map<string, PendingDownload & { expiresAt: number }>();

    /**
     * @param ttlMs - life time of an entry
     * @param now - clock
     */
    constructor(
        private readonly ttlMs: number = DownloadRegistry.TTL_MS,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * Adds a file.
     *
     * @param download - the file
     * @returns the id to put in the download URL
     */
    public add(download: PendingDownload): string {
        this.prune();
        while (this.entries.size >= DownloadRegistry.MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value as string;
            this.entries.delete(oldest);
        }
        const id = randomBytes(32).toString("base64url");
        this.entries.set(id, { ...download, expiresAt: this.now() + this.ttlMs });
        return id;
    }

    /**
     * Takes a file out (single use).
     *
     * @param id - the id from the URL
     * @returns the file, or null when unknown, used or expired
     */
    public take(id: string): PendingDownload | null {
        this.prune();
        if (!DownloadRegistry.ID.test(id)) {
            return null;
        }
        const entry = this.entries.get(id);
        if (!entry) {
            return null;
        }
        this.entries.delete(id);
        const { expiresAt: _expiresAt, ...download } = entry;
        return download;
    }

    /** Life time of an entry in seconds. */
    public get ttlSeconds(): number {
        return Math.round(this.ttlMs / 1000);
    }

    private prune(): void {
        const now = this.now();
        for (const [id, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(id);
            }
        }
    }
}
