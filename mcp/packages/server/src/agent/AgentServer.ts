import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createServer, type IncomingMessage, type Server } from "http";
import type { Duplex } from "stream";
import type { Express, NextFunction, Request, Response } from "express";
import { WebSocketServer } from "ws";
import { createLogger } from "../logger";
import { AgentConfig } from "./AgentConfig";
import { AgentSession, type AgentSessionDeps } from "./AgentSession";
import type { DownloadRegistry } from "./publish/DownloadRegistry";
import type { SessionGateFactory } from "./SessionGate";

/** Additions of a hosting mode (W24 server mode) to the endpoint. */
export interface AgentServerHosting {
    /** access control of each connection, instead of the pairing token */
    gates: SessionGateFactory;
    /** extra HTTP routes (e.g. the admin page), installed after the Host/Origin checks */
    routes?: (app: Express) => void;
}

/**
 * Ephemeral pairing token of the daemon.
 */
export class PairingToken {
    private readonly digest: Buffer;

    /**
     * @param value - the token; random when omitted
     */
    constructor(public readonly value: string = randomBytes(32).toString("base64url")) {
        this.digest = PairingToken.hash(value);
    }

    /**
     * Checks a candidate token in constant time.
     */
    public verify(candidate: string): boolean {
        return typeof candidate === "string" && timingSafeEqual(this.digest, PairingToken.hash(candidate));
    }

    /**
     * Prints the pairing URL on the daemon's terminal only.
     *
     * The URL holds the token, so it never goes through the logger, whose file and Loki
     * transports would keep it; the log gets the URL with the token masked.
     *
     * @param publicUri - public URI of the Penpot frontend
     * @param write - console writer (standard error by default)
     */
    public announce(publicUri: string, write: (line: string) => void = PairingToken.writeStderr): void {
        write(`Pair Penforge with your browser: ${this.pairUrl(publicUri)}
`);
    }

    /**
     * Gets the pairing URL with the token masked, for logs.
     *
     * @param publicUri - public URI of the Penpot frontend
     */
    public maskedPairUrl(publicUri: string): string {
        return `${publicUri}/#/penforge/pair?token=<printed on the daemon console>`;
    }

    /**
     * Gets the URL that pairs a browser with the daemon.
     *
     * @param publicUri - public URI of the Penpot frontend
     */
    public pairUrl(publicUri: string): string {
        return `${publicUri}/#/penforge/pair?token=${encodeURIComponent(this.value)}`;
    }

    private static writeStderr(line: string): void {
        process.stderr.write(line);
    }

    private static hash(value: string): Buffer {
        return createHash("sha256").update(value, "utf8").digest();
    }
}

/**
 * HTTP and WebSocket endpoint of the daemon (`/health`, `/pair`, `/agent`).
 *
 * Binds to the configured host (127.0.0.1 by default). Every request must name the daemon in its
 * `Host` header (against DNS rebinding) and, when it carries an `Origin`, come from an allowed
 * origin; WebSocket upgrades must carry an allowed `Origin`. Sessions from an allowed origin need
 * the pairing token only when `requirePairing` is on. `/pair` prints the pairing URL to the
 * daemon's log and returns it only to clients without an `Origin` (local programs, not web pages).
 * `/download/<id>` serves a file of the {@link DownloadRegistry} once (W20 ZIP download).
 */
export class AgentServer {
    private static readonly LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
    private readonly logger = createLogger("AgentServer");
    private allowedHosts = new Set<string>();
    private readonly allowedOrigins: Set<string>;
    private readonly wsServer: WebSocketServer;
    private readonly sessions = new Set<AgentSession>();
    private httpServer?: Server;

    /**
     * @param config - the daemon configuration
     * @param token - the pairing token
     * @param sessionDeps - services passed to each session
     * @param health - extra fields reported by `/health`
     * @param downloads - files the browser may download once
     * @param hosting - additions of a hosting mode
     */
    constructor(
        private readonly config: AgentConfig,
        private readonly token: PairingToken,
        private readonly sessionDeps: Omit<AgentSessionDeps, "verifyToken">,
        private readonly health: () => Record<string, unknown>,
        private readonly downloads?: DownloadRegistry,
        private readonly hosting?: AgentServerHosting
    ) {
        this.allowedOrigins = new Set(config.allowedOrigins);
        this.wsServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    }

    /** Pairing URL to open in the browser. */
    public get pairUrl(): string {
        return this.token.pairUrl(this.config.publicUri);
    }

    /** Port the endpoint listens on (the configured one, or the one picked for port 0). */
    public get port(): number {
        const address = this.httpServer?.address();
        return address && typeof address === "object" ? address.port : this.config.port;
    }

    /** HTTP base URL of the endpoint (`http://127.0.0.1:4410`). */
    public get baseUrl(): string {
        const host = this.config.host.includes(":") ? `[${this.config.host}]` : this.config.host;
        return `http://${host}:${this.port}`;
    }

    /** Number of connected sessions. */
    public get sessionCount(): number {
        return this.sessions.size;
    }

    /**
     * Finds the connected client (browser tab) whose Penpot MCP session is the given one, so that
     * an MCP tool call made by that tab's Claude turn is served with that tab's context.
     *
     * @param mcpSessionId - the Penpot MCP plugin session
     */
    public clientForMcpSession(mcpSessionId: string): AgentSession | undefined {
        return [...this.sessions].find((session) => session.mcpSessionId() === mcpSessionId);
    }

    /**
     * Asks every tab with an open file to restart its hidden MCP plugin (`mcp.restart`), for a
     * design tool that found no plugin session.
     *
     * @returns how many tabs were asked
     */
    public requestPluginRestart(): number {
        let asked = 0;
        for (const session of this.sessions) {
            if (session.showsFile) {
                session.send({ type: "mcp.restart" });
                asked++;
            }
        }
        return asked;
    }

    /**
     * Starts listening.
     */
    public async start(): Promise<void> {
        const { default: express } = await import("express");
        const app = express();
        this.routes(app);
        const server = createServer(app);
        server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.config.port, this.config.host, () => {
                server.off("error", reject);
                resolve();
            });
        });
        this.httpServer = server;
        const hostNames = new Set([...AgentServer.LOOPBACK_HOSTS, this.config.host.toLowerCase()]);
        this.allowedHosts = new Set([
            ...[...hostNames].map((host) => `${host}:${this.port}`),
            ...this.config.allowedHosts,
        ]);
        this.logger.info("Penforge agent endpoint: ws://%s:%d/agent", this.config.host, this.port);
    }

    /**
     * Closes all sessions and stops listening.
     */
    public async stop(): Promise<void> {
        for (const client of this.wsServer.clients) {
            client.close(1001, "Daemon stopping");
        }
        this.wsServer.close();
        const server = this.httpServer;
        this.httpServer = undefined;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }

    private routes(app: Express): void {
        app.disable("x-powered-by");
        app.use((req: Request, res: Response, next: NextFunction) => this.checkRequest(req, res, next));
        app.get("/health", (_req, res) => {
            res.json({ ok: true, ...this.health() });
        });
        this.hosting?.routes?.(app);
        app.get("/pair", (req, res) => {
            if (this.hosting) {
                // hosting modes authenticate through Penpot, there is nothing to pair
                res.status(404).json({ error: "not found" });
                return;
            }
            this.token.announce(this.config.publicUri);
            this.logger.info("Pairing URL printed on the console: %s", this.token.maskedPairUrl(this.config.publicUri));
            if (req.headers.origin === undefined) {
                res.json({ printed: true, pairUrl: this.pairUrl });
            } else {
                res.json({ printed: true });
            }
        });
        app.get("/download/:id", (req, res) => {
            const download = this.downloads?.take(String(req.params.id));
            if (!download) {
                res.status(404).json({ error: "not found" });
                return;
            }
            const filename = download.filename.replace(/[^A-Za-z0-9._-]/g, "_");
            res.setHeader("Content-Type", download.contentType);
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Referrer-Policy", "no-referrer");
            if (Buffer.isBuffer(download.content)) {
                res.end(download.content);
                return;
            }
            const stream = download.content();
            stream.once("error", (error) => {
                this.logger.warn("Download %s failed: %s", filename, error.message);
                res.destroy(error);
            });
            stream.pipe(res);
        });
    }

    private checkRequest(req: Request, res: Response, next: NextFunction): void {
        if (!this.isAllowedHost(req.headers.host)) {
            res.status(403).json({ error: "host not allowed" });
            return;
        }
        const origin = req.headers.origin;
        if (origin !== undefined) {
            if (!this.isAllowedOrigin(origin)) {
                res.status(403).json({ error: "origin not allowed" });
                return;
            }
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
        }
        next();
    }

    private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        const path = (request.url ?? "").split("?")[0];
        const refusal =
            path !== "/agent"
                ? "404 Not Found"
                : !this.isAllowedHost(request.headers.host)
                  ? "403 Forbidden"
                  : !this.isAllowedOrigin(request.headers.origin)
                    ? "403 Forbidden"
                    : null;
        if (refusal) {
            this.logger.warn(
                "Refused agent connection: path=%s host=%s origin=%s",
                path,
                request.headers.host,
                request.headers.origin
            );
            socket.end(`HTTP/1.1 ${refusal}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            return;
        }
        this.wsServer.handleUpgrade(request, socket, head, (ws) => {
            const session = new AgentSession(ws, {
                ...this.sessionDeps,
                gate: this.hosting?.gates.open(request),
                // The upgrade passed the Origin check above; without required pairing that is
                // enough (see AgentConfig.requirePairing).
                verifyToken: (candidate) => !this.config.requirePairing || this.token.verify(candidate),
            });
            this.sessions.add(session);
            ws.on("close", () => this.sessions.delete(session));
        });
    }

    private isAllowedHost(host: string | undefined): boolean {
        return host !== undefined && this.allowedHosts.has(host.toLowerCase());
    }

    private isAllowedOrigin(origin: string | undefined): boolean {
        return origin !== undefined && this.allowedOrigins.has(AgentConfig.normalizeOrigin(origin));
    }
}
