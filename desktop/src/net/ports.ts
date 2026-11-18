import { createServer } from "node:net";

export const LOOPBACK = "127.0.0.1";

/** True when `port` can be bound on the loopback address right now. */
export function isPortFree(port: number, host = LOOPBACK): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.unref();
        server.once("error", () => resolve(false));
        server.listen({ port, host, exclusive: true }, () => {
            server.close(() => resolve(true));
        });
    });
}

/** Asks the OS for a free loopback port. */
export function randomFreePort(host = LOOPBACK): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once("error", reject);
        server.listen({ port: 0, host, exclusive: true }, () => {
            const address = server.address();
            server.close(() => {
                if (address && typeof address === "object") {
                    resolve(address.port);
                } else {
                    reject(new Error("no port assigned"));
                }
            });
        });
    });
}

/**
 * Picks one free port per name: the preferred port when it is still free and not taken by an
 * earlier name, otherwise a random free port. Ports are unique inside one call.
 */
export async function choosePorts<K extends string>(
    names: readonly K[],
    preferred: Partial<Record<K, number | undefined>>,
    host = LOOPBACK,
): Promise<Record<K, number>> {
    const taken = new Set<number>();
    const result = {} as Record<K, number>;
    for (const name of names) {
        const wish = preferred[name];
        let port: number | undefined;
        if (wish && wish > 0 && !taken.has(wish) && (await isPortFree(wish, host))) {
            port = wish;
        }
        while (port === undefined || taken.has(port)) {
            port = await randomFreePort(host);
        }
        taken.add(port);
        result[name] = port;
    }
    return result;
}
