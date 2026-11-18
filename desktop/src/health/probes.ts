import { request } from "node:http";
import { connect } from "node:net";

/** One HTTP GET; answers the status code, or undefined when the server does not answer. */
export function httpStatus(url: string, timeoutMs = 2000): Promise<number | undefined> {
    return new Promise((resolve) => {
        const req = request(url, { method: "GET", timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode);
        });
        req.on("timeout", () => {
            req.destroy();
            resolve(undefined);
        });
        req.on("error", () => resolve(undefined));
        req.end();
    });
}

/**
 * True when PostgreSQL accepts connections: it answers a startup message with an
 * authentication request ('R'). While starting up or shutting down it answers an error ('E').
 */
export function postgresReady(port: number, host = "127.0.0.1", user = "penpot", timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ port, host });
        let settled = false;
        const done = (value: boolean) => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve(value);
            }
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once("error", () => done(false));
        socket.once("connect", () => {
            const params = Buffer.from(`user\0${user}\0database\0postgres\0\0`, "utf8");
            const header = Buffer.alloc(8);
            header.writeInt32BE(8 + params.length, 0);
            header.writeInt32BE(196608, 4); // protocol 3.0
            socket.write(Buffer.concat([header, params]));
        });
        socket.once("data", (data: Buffer) => done(data.length > 0 && data[0] === 0x52 /* 'R' */));
    });
}

export interface WaitOptions {
    timeoutMs: number;
    intervalMs?: number;
    /** Stops waiting early (e.g. the process exited). Answer a reason to fail with it. */
    abort?: () => string | undefined;
}

/** Polls `check` until it answers true; rejects on timeout or abort. */
export async function waitUntil(what: string, check: () => Promise<boolean>, options: WaitOptions): Promise<void> {
    const deadline = Date.now() + options.timeoutMs;
    const interval = options.intervalMs ?? 250;
    for (;;) {
        const reason = options.abort?.();
        if (reason) {
            throw new Error(`${what}: ${reason}`);
        }
        if (await check()) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`${what}: not ready after ${Math.round(options.timeoutMs / 1000)} s`);
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
}

/** `waitUntil` for an HTTP endpoint answering a 2xx status. */
export function waitForHttp(url: string, options: WaitOptions): Promise<void> {
    return waitUntil(url, async () => {
        const status = await httpStatus(url);
        return status !== undefined && status >= 200 && status < 300;
    }, options);
}
