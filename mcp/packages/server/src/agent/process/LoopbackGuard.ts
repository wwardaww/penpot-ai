import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Node preload that keeps the servers of a dev command on the loopback interface.
 *
 * Some dev servers ignore every host setting: Expo's Metro calls `listen(port)` without a host,
 * so it listens on all interfaces even with `--host localhost` (that flag only changes the URL it
 * prints). The preload replaces `net.Server.prototype.listen` in every Node process of the dev
 * command (passed with `NODE_OPTIONS=--require …`, which child Node processes inherit): a TCP
 * listen without a host, or on a non-loopback host, binds `127.0.0.1` instead. Pipes, file
 * descriptors and handles are left alone. Programs that are not Node (or reset `NODE_OPTIONS`)
 * are not covered; the dev server's exposure check catches them.
 */
export class LoopbackGuard {
    /** Host the preload binds to. */
    public static readonly HOST = "127.0.0.1";

    private static readonly PRELOAD = `"use strict";
// Penforge: keeps the servers of this dev command on the loopback interface.
const net = require("net");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const HOST = ${JSON.stringify(LoopbackGuard.HOST)};
const original = net.Server.prototype.listen;
function loopback(host) {
    return typeof host === "string" && LOOPBACK.has(host.toLowerCase()) ? host : HOST;
}
function isPort(value) {
    return value === undefined || value === null || typeof value === "number" ||
        (typeof value === "string" && /^\\d+$/.test(value));
}
net.Server.prototype.listen = function penforgeLoopbackListen(...args) {
    const first = args[0];
    if (typeof first === "function") {
        args.unshift(0, HOST);
    } else if (first !== null && typeof first === "object") {
        const isHandle = first._handle !== undefined || first.fd !== undefined || first.path !== undefined;
        if (!isHandle && !(first instanceof net.Server)) {
            args[0] = Object.assign({}, first, { host: loopback(first.host) });
        }
    } else if (isPort(first)) {
        if (args.length === 0) {
            args.push(0);
        }
        if (typeof args[1] === "string") {
            args[1] = loopback(args[1]);
        } else {
            args.splice(1, 0, HOST);
        }
    }
    return original.apply(this, args);
};
`;

    private static preloadPath?: string;

    /**
     * Gets the `NODE_OPTIONS` value that loads the preload.
     *
     * The preload is written once per daemon process to a new private temporary folder.
     */
    public static nodeOptions(): string {
        const path = LoopbackGuard.ensurePreload();
        // NODE_OPTIONS reads backslashes inside double quotes as escapes
        const quoted = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `--require "${quoted}"`;
    }

    private static ensurePreload(): string {
        if (!LoopbackGuard.preloadPath) {
            const dir = mkdtempSync(join(tmpdir(), "penforge-loopback-"));
            const path = join(dir, "loopback.cjs");
            writeFileSync(path, LoopbackGuard.PRELOAD, { encoding: "utf8", mode: 0o600 });
            LoopbackGuard.preloadPath = path;
        }
        return LoopbackGuard.preloadPath;
    }
}
