import { randomBytes, timingSafeEqual } from "crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { createLogger } from "../../logger";
import type { ApiUsage } from "./UsageLedger";

/** Who a turn ticket was issued for. */
export interface TicketOwner {
    profileId: string;
    teamId?: string;
}

/** A ticket valid for one Claude turn; {@link revoke} it when the turn ends. */
export class TurnTicket {
    constructor(
        /** the ticket Claude presents as its API key */
        public readonly value: string,
        /** base URL Claude sends its API requests to */
        public readonly baseUrl: string,
        private readonly onRevoke: () => void
    ) {}

    /** Invalidates the ticket (idempotent). */
    public revoke(): void {
        this.onRevoke();
    }
}

/** Receives the token usage the proxy read from API answers. */
export interface UsageSink {
    record(owner: TicketOwner, usage: ApiUsage): Promise<void>;
}

/**
 * Credential proxy between Claude and the Anthropic API (server mode).
 *
 * Listens on loopback only. Claude gets `ANTHROPIC_BASE_URL` pointing here and a turn ticket as
 * `ANTHROPIC_API_KEY`; the proxy accepts only live tickets, swaps in the real API key and
 * forwards the request, so the Claude process never holds the key. It reads `usage` from JSON
 * and streamed (SSE) answers for the usage ledger. Only `/v1/*` paths are forwarded.
 */
export class ApiKeyProxy {
    private static readonly MAX_BODY = 64 * 1024 * 1024;
    private static readonly DROPPED_HEADERS = new Set([
        "host",
        "connection",
        "content-length",
        "x-api-key",
        "authorization",
        "cookie",
        "proxy-authorization",
        "transfer-encoding",
        "accept-encoding",
        "keep-alive",
        "upgrade",
    ]);
    private readonly logger = createLogger("ApiKeyProxy");
    private readonly tickets = new Map<string, { owner: TicketOwner; apiKey: string }>();
    private server?: Server;

    /**
     * @param upstream - Anthropic API base URL
     * @param usage - receives the usage of each answer
     * @param fetchFn - HTTP client (tests pass a fake)
     */
    constructor(
        private readonly upstream: string,
        private readonly usage: UsageSink,
        private readonly fetchFn: typeof fetch = fetch
    ) {}

    /** Number of live tickets. */
    public get ticketCount(): number {
        return this.tickets.size;
    }

    /** Starts listening on a free loopback port. */
    public async start(): Promise<void> {
        const server = createServer((req, res) => {
            this.handle(req, res).catch((error: unknown) => {
                this.logger.warn("Proxy request failed: %s", error instanceof Error ? error.message : String(error));
                if (!res.headersSent) {
                    res.writeHead(502, { "Content-Type": "application/json" });
                }
                res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream failed" } }));
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        this.server = server;
    }

    /** Stops listening and revokes every ticket. */
    public async stop(): Promise<void> {
        this.tickets.clear();
        const server = this.server;
        this.server = undefined;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }

    /**
     * Issues a ticket for one turn.
     *
     * @param owner - the user and team the turn runs for
     * @param apiKey - the Anthropic API key to use for it
     */
    public issue(owner: TicketOwner, apiKey: string): TurnTicket {
        const address = this.server?.address();
        if (!address || typeof address !== "object") {
            throw new Error("The API key proxy is not running");
        }
        const value = `pft-${randomBytes(32).toString("base64url")}`;
        this.tickets.set(value, { owner, apiKey });
        return new TurnTicket(value, `http://127.0.0.1:${address.port}`, () => this.tickets.delete(value));
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const entry = this.ticketOf(req);
        const path = req.url ?? "";
        if (!entry) {
            ApiKeyProxy.reject(res, 401, "authentication_error", "Invalid or expired ticket");
            return;
        }
        if (!/^\/v1\/[A-Za-z0-9/_.-]*(\?[A-Za-z0-9=&_.,%-]*)?$/.test(path) || path.includes("..")) {
            ApiKeyProxy.reject(res, 404, "not_found_error", "Not forwarded");
            return;
        }
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await ApiKeyProxy.readBody(req);
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
            if (value !== undefined && !ApiKeyProxy.DROPPED_HEADERS.has(name.toLowerCase())) {
                headers[name] = Array.isArray(value) ? value.join(", ") : value;
            }
        }
        headers["x-api-key"] = entry.apiKey;
        const answer = await this.fetchFn(this.upstream + path, {
            method: req.method,
            headers,
            body,
            redirect: "manual",
        });
        const outHeaders: Record<string, string> = {};
        answer.headers.forEach((value, name) => {
            if (
                !["content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie"].includes(name)
            ) {
                outHeaders[name] = value;
            }
        });
        res.writeHead(answer.status, outHeaders);
        const meter = new UsageMeter(String(answer.headers.get("content-type") ?? ""));
        if (answer.body) {
            const reader = answer.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                meter.feed(value);
                res.write(value);
            }
        }
        res.end();
        const usage = answer.ok ? meter.result() : null;
        if (usage) {
            await this.usage.record(entry.owner, usage).catch((error: unknown) => {
                this.logger.warn("Could not record usage: %s", String(error));
            });
        }
    }

    private ticketOf(req: IncomingMessage): { owner: TicketOwner; apiKey: string } | undefined {
        const header = req.headers["x-api-key"];
        const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
        const candidate = typeof header === "string" ? header : bearer;
        if (!candidate) {
            return undefined;
        }
        for (const [value, entry] of this.tickets) {
            const a = Buffer.from(value);
            const b = Buffer.from(candidate);
            if (a.length === b.length && timingSafeEqual(a, b)) {
                return entry;
            }
        }
        return undefined;
    }

    private static async readBody(req: IncomingMessage): Promise<Buffer> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > ApiKeyProxy.MAX_BODY) {
                throw new Error("Request body too large");
            }
            chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks);
    }

    private static reject(res: ServerResponse, status: number, type: string, message: string): void {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type, message } }));
    }
}

/**
 * Reader of the token usage in an Anthropic API answer, fed chunk by chunk: a JSON message
 * (`usage` at the top level) or a stream of server-sent events (`message_start` carries the
 * input and cache tokens, `message_delta` the output tokens).
 */
class UsageMeter {
    private static readonly MAX_JSON = 4 * 1024 * 1024;
    private readonly sse: boolean;
    private readonly decoder = new TextDecoder();
    private text = "";
    private overflow = false;
    private usage: ApiUsage | null = null;

    constructor(contentType: string) {
        this.sse = contentType.includes("text/event-stream");
    }

    public feed(chunk: Uint8Array): void {
        this.text += this.decoder.decode(chunk, { stream: true });
        if (this.sse) {
            const lines = this.text.split("\n");
            this.text = lines.pop() ?? "";
            for (const line of lines) {
                if (line.startsWith("data:")) {
                    this.event(line.slice(5).trim());
                }
            }
        } else if (this.text.length > UsageMeter.MAX_JSON) {
            this.overflow = true;
            this.text = "";
        }
    }

    public result(): ApiUsage | null {
        if (!this.sse && !this.overflow) {
            try {
                const message = JSON.parse(this.text) as { model?: string; usage?: Record<string, number> };
                if (message.usage) {
                    this.merge(message.model, message.usage);
                }
            } catch {
                // not a JSON message (e.g. count_tokens or an empty answer)
            }
        }
        return this.usage;
    }

    private event(data: string): void {
        try {
            const event = JSON.parse(data) as {
                type?: string;
                message?: { model?: string; usage?: Record<string, number> };
                usage?: Record<string, number>;
            };
            if (event.type === "message_start" && event.message?.usage) {
                this.merge(event.message.model, event.message.usage);
            } else if (event.type === "message_delta" && event.usage) {
                this.merge(undefined, event.usage);
            }
        } catch {
            // not JSON (ping or a split line)
        }
    }

    private merge(model: string | undefined, usage: Record<string, number>): void {
        const current = this.usage ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
        };
        const number = (value: unknown, fallback: number) =>
            typeof value === "number" && value >= 0 ? value : fallback;
        this.usage = {
            model: model ?? current.model,
            inputTokens: number(usage.input_tokens, current.inputTokens),
            // message_delta carries the running output total
            outputTokens: number(usage.output_tokens, current.outputTokens),
            cacheReadTokens: number(usage.cache_read_input_tokens, current.cacheReadTokens),
            cacheCreationTokens: number(usage.cache_creation_input_tokens, current.cacheCreationTokens),
        };
    }
}
