import { createReadStream, statSync } from "node:fs";
import { Agent, createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
};

export interface GatewayOptions {
    port: number;
    frontendDir: string;
    mcpPluginDir?: string;
    /** Folder of the fs object storage (answers of `x-accel-redirect`). */
    assetsDir: string;
    /** Path prefix the backend puts in `x-accel-redirect` (`PENPOT_ASSETS_PATH`). */
    assetsPath?: string;
    backendPort: number;
    /** Body of `/js/config.js`. */
    configJs: () => string;
}

/** Paths answered by the backend. */
const BACKEND_PREFIXES = ["/api/", "/assets/", "/ws/notifications", "/readyz", "/link-preview"];

/** RPC commands the browser never reaches: the shell calls them on the backend port. */
const BLOCKED_PATHS = [/\/api\/(?:main\/)?(?:methods|rpc\/command)\/penforge-local-login\b/];

/**
 * Resolves `requestPath` inside `root`; undefined when it escapes the folder.
 * Exported for tests.
 */
export function safeJoin(root: string, requestPath: string): string | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(requestPath);
    } catch {
        return undefined;
    }
    if (decoded.includes("\0")) {
        return undefined;
    }
    const base = resolve(root);
    const target = resolve(base, `.${sep}${decoded.replace(/^[/\\]+/, "")}`);
    const rel = relative(base, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        return undefined;
    }
    return target;
}

/** True when the `Host` header names this gateway on loopback (no DNS rebinding). */
export function allowedHost(host: string | undefined, port: number): boolean {
    if (!host) {
        return false;
    }
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

/**
 * The local web server the window loads: built frontend, generated `config.js`, the MCP plugin,
 * and a reverse proxy to the backend (HTTP + the notifications WebSocket). Assets stored by the
 * fs storage come back from the backend as `x-accel-redirect` and are read from disk here, like
 * nginx does in the docker images. Listens on 127.0.0.1 only.
 */
export class Gateway {
    private server?: Server;
    private readonly sockets = new Set<Socket>();
    /** Keep-alive connections to the backend, closed with the gateway. */
    private readonly agent = new Agent({ keepAlive: true, maxSockets: 64 });

    constructor(private readonly options: GatewayOptions) {}

    public get origin(): string {
        return `http://127.0.0.1:${this.options.port}`;
    }

    public start(): Promise<void> {
        const server = createServer((req, res) => this.handle(req, res));
        server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => this.upgrade(req, socket, head));
        server.on("connection", (socket) => {
            this.sockets.add(socket);
            socket.once("close", () => this.sockets.delete(socket));
        });
        this.server = server;
        return new Promise((resolvePromise, reject) => {
            server.once("error", reject);
            server.listen(this.options.port, "127.0.0.1", () => resolvePromise());
        });
    }

    public stop(): Promise<void> {
        const server = this.server;
        if (!server) {
            return Promise.resolve();
        }
        for (const socket of this.sockets) {
            socket.destroy();
        }
        this.agent.destroy();
        server.closeAllConnections();
        return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }

    private handle(req: IncomingMessage, res: ServerResponse): void {
        if (!allowedHost(req.headers.host, this.options.port)) {
            this.plain(res, 403, "forbidden host");
            return;
        }
        const url = new URL(req.url ?? "/", "http://gateway");
        const path = url.pathname;
        if (BLOCKED_PATHS.some((pattern) => pattern.test(path))) {
            this.plain(res, 404, "not found");
            return;
        }
        if (BACKEND_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))) {
            this.proxy(req, res);
            return;
        }
        if (path === "/js/config.js") {
            const body = this.options.configJs();
            res.writeHead(200, {
                "content-type": CONTENT_TYPES[".js"]!,
                "cache-control": "no-store",
                "content-length": Buffer.byteLength(body),
            });
            res.end(body);
            return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
            this.plain(res, 405, "method not allowed");
            return;
        }
        if (this.options.mcpPluginDir && (path === "/plugins/mcp" || path.startsWith("/plugins/mcp/"))) {
            this.serveStatic(req, res, this.options.mcpPluginDir, path.slice("/plugins/mcp".length) || "/index.html", false);
            return;
        }
        this.serveStatic(req, res, this.options.frontendDir, path === "/" ? "/index.html" : path, true);
    }

    private serveStatic(req: IncomingMessage, res: ServerResponse, root: string, path: string, spaFallback: boolean): void {
        let file = safeJoin(root, path);
        let stat = file ? statOrUndefined(file) : undefined;
        if (stat?.isDirectory()) {
            file = join(file!, "index.html");
            stat = statOrUndefined(file);
        }
        if ((!stat || !stat.isFile()) && spaFallback && extname(path) === "") {
            file = join(root, "index.html");
            stat = statOrUndefined(file);
        }
        if (!file || !stat || !stat.isFile()) {
            this.plain(res, 404, "not found");
            return;
        }
        this.sendFile(req, res, file, stat.size, stat.mtime, {
            "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
            "cache-control": extname(file) === ".html" ? "no-store" : "no-cache",
        });
    }

    private sendFile(
        req: IncomingMessage,
        res: ServerResponse,
        file: string,
        size: number,
        mtime: Date,
        headers: Record<string, string>,
    ): void {
        const lastModified = mtime.toUTCString();
        const since = req.headers["if-modified-since"];
        if (since && since === lastModified) {
            res.writeHead(304, { ...headers, "last-modified": lastModified });
            res.end();
            return;
        }
        res.writeHead(200, {
            ...headers,
            "content-length": size,
            "last-modified": lastModified,
            "x-content-type-options": "nosniff",
        });
        if (req.method === "HEAD") {
            res.end();
            return;
        }
        const stream = createReadStream(file);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
    }

    private proxy(req: IncomingMessage, res: ServerResponse): void {
        const upstream = httpRequest(
            {
                host: "127.0.0.1",
                port: this.options.backendPort,
                agent: this.agent,
                method: req.method,
                path: req.url,
                headers: { ...req.headers, "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http" },
            },
            (upstreamRes) => {
                const redirect = upstreamRes.headers["x-accel-redirect"];
                if (typeof redirect === "string" && upstreamRes.statusCode !== undefined && upstreamRes.statusCode < 300) {
                    upstreamRes.resume();
                    this.serveAsset(req, res, redirect, upstreamRes.headers);
                    return;
                }
                res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.rawHeaders);
                upstreamRes.pipe(res);
            },
        );
        upstream.on("error", () => {
            if (!res.headersSent) {
                this.plain(res, 502, "backend unavailable");
            } else {
                res.destroy();
            }
        });
        req.pipe(upstream);
    }

    private serveAsset(req: IncomingMessage, res: ServerResponse, redirect: string, headers: IncomingMessage["headers"]): void {
        const prefix = this.options.assetsPath ?? "/internal/assets/";
        const path = redirect.split("?")[0]!;
        if (!path.startsWith(prefix)) {
            this.plain(res, 404, "not found");
            return;
        }
        const file = safeJoin(this.options.assetsDir, path.slice(prefix.length));
        const stat = file ? statOrUndefined(file) : undefined;
        if (!file || !stat || !stat.isFile()) {
            this.plain(res, 404, "not found");
            return;
        }
        const out: Record<string, string> = {
            "content-type": String(headers["content-type"] ?? "application/octet-stream"),
        };
        if (headers["cache-control"]) {
            out["cache-control"] = String(headers["cache-control"]);
        }
        if (headers["content-disposition"]) {
            out["content-disposition"] = String(headers["content-disposition"]);
        }
        this.sendFile(req, res, file, stat.size, stat.mtime, out);
    }

    private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
        const path = new URL(req.url ?? "/", "http://gateway").pathname;
        if (!allowedHost(req.headers.host, this.options.port) || !path.startsWith("/ws/notifications")) {
            socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            return;
        }
        const upstream = connect(this.options.backendPort, "127.0.0.1", () => {
            let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
            }
            upstream.write(`${raw}\r\n`);
            if (head.length > 0) {
                upstream.write(head);
            }
            socket.pipe(upstream).pipe(socket);
        });
        this.sockets.add(upstream);
        upstream.once("close", () => this.sockets.delete(upstream));
        const close = () => {
            socket.destroy();
            upstream.destroy();
        };
        upstream.on("error", close);
        socket.on("error", close);
        socket.on("close", () => upstream.destroy());
        upstream.on("close", () => socket.destroy());
    }

    private plain(res: ServerResponse, status: number, message: string): void {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(message) });
        res.end(message);
    }
}

function statOrUndefined(file: string) {
    try {
        return statSync(file);
    } catch {
        return undefined;
    }
}
