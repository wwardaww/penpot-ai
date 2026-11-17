import { request } from "http";

/**
 * Readiness check of a dev server: an HTTP GET on the loopback interfaces.
 *
 * Any HTTP answer counts (a 404 still means the server is up); refused or timed-out connections
 * do not. Both IPv4 and IPv6 loopback are tried, since dev servers that bind `localhost` may listen
 * on either.
 */
export class HttpProbe {
    private static readonly HOSTS = ["127.0.0.1", "::1"];
    private static readonly REQUEST_TIMEOUT_MS = 2000;

    /**
     * @param path - the path to request
     */
    constructor(private readonly path: string = "/") {}

    /**
     * Checks once whether a server answers on a port.
     *
     * @param port - the port
     */
    public async answers(port: number): Promise<boolean> {
        const results = await Promise.all(HttpProbe.HOSTS.map((host) => this.get(host, port)));
        return results.some((value) => value);
    }

    private get(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const req = request(
                { host, port, path: this.path, method: "GET", timeout: HttpProbe.REQUEST_TIMEOUT_MS },
                (res) => {
                    res.resume();
                    resolve(true);
                }
            );
            req.once("timeout", () => req.destroy());
            req.once("error", () => resolve(false));
            req.end();
        });
    }
}
