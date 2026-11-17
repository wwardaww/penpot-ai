import { createConnection, createServer } from "net";

/**
 * Pool of TCP ports for dev servers (default 5200-5299).
 *
 * A port is handed out only when no other dev server of this daemon holds it, nothing answers on
 * it (IPv4 or IPv6 loopback) and it can be bound on 127.0.0.1. So two projects, or another program
 * already using a port, never collide.
 */
export class PortPool {
    /** Default first port of the pool. */
    public static readonly DEFAULT_FIRST = 5200;
    /** Default last port of the pool. */
    public static readonly DEFAULT_LAST = 5299;

    private static readonly CONNECT_TIMEOUT_MS = 500;
    private readonly taken = new Set<number>();
    private next: number;

    /**
     * @param first - first port of the range
     * @param last - last port of the range (inclusive)
     */
    constructor(
        public readonly first: number = PortPool.DEFAULT_FIRST,
        public readonly last: number = PortPool.DEFAULT_LAST
    ) {
        if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 65535 || first > last) {
            throw new Error(`Invalid port range ${first}-${last}`);
        }
        this.next = first;
    }

    /**
     * Creates a pool from a `<first>-<last>` range string, falling back to the default range.
     *
     * @param range - e.g. `5200-5299`; undefined for the default
     */
    public static fromRange(range: string | undefined): PortPool {
        const match = range?.trim().match(/^(\d+)\s*-\s*(\d+)$/);
        if (!match) {
            return new PortPool();
        }
        return new PortPool(Number(match[1]), Number(match[2]));
    }

    /**
     * Reserves a free port.
     *
     * @throws Error when every port of the range is busy
     */
    public async acquire(): Promise<number> {
        const size = this.last - this.first + 1;
        for (let i = 0; i < size; i++) {
            const port = this.next;
            this.next = port >= this.last ? this.first : port + 1;
            if (this.taken.has(port)) {
                continue;
            }
            // reserve before the async check, so that concurrent calls skip it
            this.taken.add(port);
            if (await PortPool.isFree(port)) {
                return port;
            }
            this.taken.delete(port);
        }
        throw new Error(`No free port between ${this.first} and ${this.last}`);
    }

    /**
     * Returns a port to the pool.
     *
     * @param port - a port returned by {@link acquire}
     */
    public release(port: number): void {
        this.taken.delete(port);
    }

    /**
     * Checks whether a port is free on the loopback interfaces.
     *
     * @param port - the port
     */
    public static async isFree(port: number): Promise<boolean> {
        const answered = await Promise.all([PortPool.answers("127.0.0.1", port), PortPool.answers("::1", port)]);
        if (answered.some((value) => value)) {
            return false;
        }
        return PortPool.canBind(port);
    }

    private static answers(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = createConnection({ host, port });
            const finish = (value: boolean) => {
                socket.destroy();
                resolve(value);
            };
            socket.setTimeout(PortPool.CONNECT_TIMEOUT_MS, () => finish(false));
            socket.once("connect", () => finish(true));
            socket.once("error", () => finish(false));
        });
    }

    private static canBind(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = createServer();
            server.unref();
            server.once("error", () => resolve(false));
            server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
                server.close(() => resolve(true));
            });
        });
    }
}
