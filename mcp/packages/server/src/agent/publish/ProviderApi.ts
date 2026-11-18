import type { HttpRequest, HttpResponse, HttpTransport } from "./HttpTransport";
import { PublishError, SecretMask } from "./PublishError";

/** Options of one API call. */
export interface ApiCallOptions {
    /** raw body (sent as is) instead of JSON */
    raw?: Buffer;
    /** extra headers */
    headers?: Record<string, string>;
    /** statuses returned to the caller instead of raising (e.g. 404 for "does not exist") */
    accept?: number[];
}

/** Answer of an API call: status and parsed JSON body (null when empty or not JSON). */
export interface ApiAnswer<T> {
    status: number;
    headers: Record<string, string>;
    data: T;
}

/**
 * Client of one provider's REST API, authenticated with the user's token.
 *
 * Sends the token only in the `Authorization` header of requests to the provider's own API host,
 * and turns failures into {@link PublishError}s whose texts are masked: a provider answer is
 * reduced to its status and error message, never echoed with headers.
 */
export class ProviderApi {
    private static readonly MAX_ERROR_CHARS = 300;

    /**
     * @param provider - provider name, for messages ("GitHub")
     * @param baseUrl - API base URL, without a trailing slash
     * @param token - the user's token
     * @param transport - sends the requests
     * @param mask - removes secrets from texts
     * @param authScheme - `Authorization` scheme (`Bearer`, `token`)
     * @param extraHeaders - headers of every request
     */
    constructor(
        public readonly provider: string,
        private readonly baseUrl: string,
        private readonly token: string,
        private readonly transport: HttpTransport,
        private readonly mask: SecretMask,
        private readonly authScheme: string = "Bearer",
        private readonly extraHeaders: Record<string, string> = {}
    ) {}

    /**
     * Calls the API.
     *
     * @param method - HTTP method
     * @param path - path below the base URL (starting with `/`)
     * @param body - JSON body
     * @param options - raw body, extra headers, accepted error statuses
     * @throws PublishError on network failures and refused requests
     */
    public async call<T = any>(
        method: HttpRequest["method"],
        path: string,
        body?: unknown,
        options: ApiCallOptions = {}
    ): Promise<ApiAnswer<T>> {
        const headers: Record<string, string> = {
            Accept: "application/json",
            "User-Agent": "Penforge",
            ...this.extraHeaders,
            ...options.headers,
            Authorization: `${this.authScheme} ${this.token}`,
        };
        let payload: Buffer | string | undefined;
        if (options.raw !== undefined) {
            payload = options.raw;
            headers["Content-Type"] ??= "application/octet-stream";
        } else if (body !== undefined) {
            payload = JSON.stringify(body);
            headers["Content-Type"] = "application/json";
        }
        let response: HttpResponse;
        try {
            response = await this.transport.send({ method, url: `${this.baseUrl}${path}`, headers, body: payload });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (/timeout|aborted/i.test(reason)) {
                throw new PublishError("timeout", `${this.provider} did not answer in time`, {
                    provider: this.provider,
                });
            }
            throw new PublishError("network", `${this.provider} cannot be reached: ${this.mask.mask(reason)}`, {
                provider: this.provider,
            });
        }
        const data = ProviderApi.parse(response.body) as T;
        if (response.status >= 400 && !(options.accept ?? []).includes(response.status)) {
            throw this.failure(response, data);
        }
        return { status: response.status, headers: response.headers, data };
    }

    /**
     * Maps a refused request to a publish error.
     *
     * @param response - the answer
     * @param data - its parsed body
     */
    protected failure(response: HttpResponse, data: unknown): PublishError {
        const params = { provider: this.provider };
        const text = this.errorText(data);
        const detail = `${response.status}${text ? `: ${text}` : ""}`;
        if (response.status === 401) {
            return new PublishError("token-invalid", `${this.provider} refused the token (${detail})`, params, detail);
        }
        if (response.status === 429 || response.headers["x-ratelimit-remaining"] === "0") {
            return new PublishError("rate-limited", `${this.provider} asks to wait (${detail})`, params, detail);
        }
        if (response.status === 403) {
            return new PublishError(
                "token-scope",
                `The ${this.provider} token may not do this (${detail})`,
                params,
                detail
            );
        }
        return new PublishError("provider", `${this.provider} refused the request (${detail})`, params, detail);
    }

    /**
     * Gets the error text of an answer body, masked and shortened.
     *
     * @param data - the parsed body
     */
    public errorText(data: unknown): string {
        const value = data as { message?: unknown; error?: unknown; errors?: unknown } | null;
        const nested = value?.error as { message?: unknown } | string | undefined;
        const raw =
            typeof value?.message === "string"
                ? value.message
                : typeof nested === "string"
                  ? nested
                  : typeof nested?.message === "string"
                    ? nested.message
                    : "";
        return this.mask.mask(raw).slice(0, ProviderApi.MAX_ERROR_CHARS);
    }

    private static parse(body: Buffer): unknown {
        if (body.length === 0) {
            return null;
        }
        try {
            return JSON.parse(body.toString("utf8"));
        } catch {
            return null;
        }
    }
}
