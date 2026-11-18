import { createSocket } from "dgram";
import { connect } from "net";
import { networkInterfaces } from "os";

/**
 * Source of the machine's own network addresses (a strategy, so tests can name addresses).
 */
export interface AddressSource {
    /** Gets the addresses of this machine that other machines may reach (no loopback). */
    externalAddresses(): string[];
}

/**
 * Addresses of the machine's network interfaces, without loopback and IPv6 link-local ones
 * (those need a scope to connect to).
 */
export class InterfaceAddressSource implements AddressSource {
    public externalAddresses(): string[] {
        const result: string[] = [];
        for (const entries of Object.values(networkInterfaces())) {
            for (const entry of entries ?? []) {
                if (entry.internal || (entry.family === "IPv6" && entry.address.toLowerCase().startsWith("fe80"))) {
                    continue;
                }
                result.push(entry.address);
            }
        }
        return result;
    }
}

/**
 * Check of where a dev server can be reached.
 *
 * Connects to the server's port on each of the machine's own non-loopback addresses: a server
 * bound to `127.0.0.1` refuses those connections, a server bound to all interfaces (`0.0.0.0`,
 * `::`) accepts them, so other machines on the network could open it too. A connection to the
 * machine's own address is local, so it is answered at once; one that gets no answer quickly (a
 * virtual adapter that drops packets) counts as not reachable.
 */
export class ExposureCheck {
    private static readonly MAX_ADDRESSES = 32;
    private static readonly CONNECT_TIMEOUT_MS = 500;

    /**
     * @param addresses - the machine's own addresses
     */
    constructor(private readonly addresses: AddressSource = new InterfaceAddressSource()) {}

    /**
     * Gets the non-loopback addresses on which a port accepts connections.
     *
     * @param port - the port to check
     * @returns the addresses that accepted a connection (empty when the server is loopback only)
     */
    public async exposedOn(port: number): Promise<string[]> {
        const candidates = this.addresses.externalAddresses().slice(0, ExposureCheck.MAX_ADDRESSES);
        const results = await Promise.all(
            candidates.map(async (host) => ((await ExposureCheck.accepts(host, port)) ? host : null))
        );
        return results.filter((host): host is string => host !== null);
    }

    /**
     * Gets the address of this machine that a phone on the same network most likely reaches.
     *
     * Asks the operating system which local address it would use for the default route (a UDP
     * "connect" sends no packet), and falls back to the first private IPv4 address of a physical
     * looking interface.
     *
     * @returns the address, or null when the machine has no network address
     */
    public async lanAddress(): Promise<string | null> {
        const routed = await ExposureCheck.defaultRouteAddress();
        const external = this.addresses.externalAddresses().filter((address) => !address.includes(":"));
        if (routed !== null && external.includes(routed)) {
            return routed;
        }
        const rank = (address: string): number =>
            address.startsWith("192.168.") ? 0 : address.startsWith("10.") ? 1 : address.startsWith("172.") ? 2 : 3;
        return [...external].sort((a, b) => rank(a) - rank(b))[0] ?? routed;
    }

    private static accepts(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = connect({ host, port });
            const done = (value: boolean) => {
                socket.destroy();
                resolve(value);
            };
            socket.setTimeout(ExposureCheck.CONNECT_TIMEOUT_MS, () => done(false));
            socket.once("connect", () => done(true));
            socket.once("error", () => done(false));
        });
    }

    private static defaultRouteAddress(): Promise<string | null> {
        return new Promise((resolve) => {
            const socket = createSocket("udp4");
            const finish = (value: string | null) => {
                try {
                    socket.close();
                } catch {
                    // already closed
                }
                resolve(value);
            };
            socket.once("error", () => finish(null));
            try {
                // a documentation-range address (TEST-NET-1): only selects the route, sends nothing
                socket.connect(9, "192.0.2.1", () => {
                    try {
                        finish(socket.address().address);
                    } catch {
                        finish(null);
                    }
                });
            } catch {
                finish(null);
            }
        });
    }
}
