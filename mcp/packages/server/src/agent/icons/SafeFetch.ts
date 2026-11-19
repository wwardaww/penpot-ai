import { ALLOWED_HOSTS } from "./IconSource";
import { IconImportError } from "./IconLimits";

/** One HTTP answer, as much as {@link SafeFetch} needs of it. */
export interface HttpAnswer {
    status: number;
    headers: { get(name: string): string | null };
    body: AsyncIterable<Uint8Array> | null;
}

/** GET without following redirects (the caller checks each hop). */
export type HttpGet = (url: string, signal: AbortSignal) => Promise<HttpAnswer>;

const MAX_REDIRECTS = 5;

/** Default {@link HttpGet}: Node's `fetch`, redirects not followed, generic user agent. */
export const nodeHttpGet: HttpGet = async (url, signal) => {
    const response = await fetch(url, {
        redirect: "manual",
        signal,
        headers: { "user-agent": "Penforge-icon-import", accept: "*/*" },
    });
    return {
        status: response.status,
        headers: response.headers,
        body: response.body as unknown as AsyncIterable<Uint8Array> | null,
    };
};

/**
 * Downloads from the allowlisted GitHub hosts only: https, every redirect hop checked against
 * {@link ALLOWED_HOSTS}, a byte cap on the transfer and a time budget. Nothing is written to disk.
 */
export class SafeFetch {
    /**
     * @param get - the HTTP client (tests pass a fake)
     */
    constructor(private readonly get: HttpGet = nodeHttpGet) {}

    /**
     * Streams the body of a URL.
     *
     * @param url - https URL on an allowlisted host
     * @param maxBytes - the stream fails with `too-large` beyond this many bytes
     * @param signal - aborts the transfer
     */
    public async *stream(url: string, maxBytes: number, signal: AbortSignal): AsyncGenerator<Buffer> {
        const answer = await this.open(url, signal);
        const declared = Number(answer.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
            throw tooLarge(maxBytes);
        }
        if (!answer.body) {
            return;
        }
        let total = 0;
        for await (const chunk of answer.body) {
            if (signal.aborted) {
                throw new IconImportError("cancelled", "The download was cancelled");
            }
            total += chunk.byteLength;
            if (total > maxBytes) {
                throw tooLarge(maxBytes);
            }
            yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        }
    }

    /**
     * Downloads a whole body into memory.
     *
     * @param url - https URL on an allowlisted host
     * @param maxBytes - fails with `too-large` beyond this many bytes
     * @param signal - aborts the transfer
     */
    public async download(url: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of this.stream(url, maxBytes, signal)) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    private async open(start: string, signal: AbortSignal): Promise<HttpAnswer> {
        let url = start;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            SafeFetch.checkUrl(url);
            let answer: HttpAnswer;
            try {
                answer = await this.get(url, signal);
            } catch (error) {
                if (signal.aborted) {
                    throw new IconImportError("cancelled", "The download was cancelled");
                }
                throw new IconImportError("download-failed", `Download failed: ${(error as Error).message}`, {
                    status: 0,
                });
            }
            if (answer.status >= 300 && answer.status < 400) {
                const location = answer.headers.get("location");
                if (!location) {
                    throw new IconImportError("download-failed", "GitHub sent a redirect without a target", {
                        status: answer.status,
                    });
                }
                url = new URL(location, url).toString();
                continue;
            }
            if (answer.status !== 200) {
                throw new IconImportError(
                    "download-failed",
                    answer.status === 404
                        ? "GitHub has no such repository, folder or file (or it is private)"
                        : `GitHub answered ${answer.status}`,
                    { status: answer.status }
                );
            }
            return answer;
        }
        throw new IconImportError("download-failed", "Too many redirects", { status: 0 });
    }

    /**
     * Refuses a URL that is not https on an allowlisted host.
     *
     * @throws IconImportError `host-not-allowed`
     */
    public static checkUrl(url: string): void {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new IconImportError("bad-url", "Not a URL");
        }
        const host = parsed.hostname.toLowerCase();
        if (
            parsed.protocol !== "https:" ||
            !ALLOWED_HOSTS.has(host) ||
            parsed.username ||
            parsed.password ||
            parsed.port
        ) {
            throw new IconImportError("host-not-allowed", `Downloads are allowed from GitHub only, not ${host}`, {
                host,
            });
        }
    }
}

function tooLarge(maxBytes: number): IconImportError {
    return new IconImportError("too-large", `The download is larger than ${Math.round(maxBytes / 1048576)} MB`, {
        limitMb: Math.round(maxBytes / 1048576),
    });
}
