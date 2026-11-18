/** HTTP request to a provider API. */
export interface HttpRequest {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    headers: Record<string, string>;
    body?: Buffer | string;
}

/** HTTP answer of a provider API. */
export interface HttpResponse {
    status: number;
    /** header names in lower case */
    headers: Record<string, string>;
    body: Buffer;
}

/**
 * Sender of HTTP requests (a strategy: tests use a fake provider, never the real APIs).
 */
export interface HttpTransport {
    /**
     * Sends a request.
     *
     * @throws Error when the server cannot be reached (no answer at all)
     */
    send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * Transport over Node's `fetch`, with a time limit per request.
 */
export class FetchTransport implements HttpTransport {
    /**
     * @param timeoutMs - time limit of one request
     */
    constructor(private readonly timeoutMs: number = 120_000) {}

    public async send(request: HttpRequest): Promise<HttpResponse> {
        const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body === undefined ? undefined : new Uint8Array(Buffer.from(request.body)),
            redirect: "error",
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
            headers[name.toLowerCase()] = value;
        });
        return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) };
    }
}
