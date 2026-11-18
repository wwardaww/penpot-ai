import { createHash } from "crypto";
import type { IncomingHttpHeaders } from "http";
import { createLogger } from "../../logger";
import { PenpotUser } from "./UserScope";

/**
 * Penpot credentials of a browser or script: the session cookie or an access token.
 */
export class PenpotCredentials {
    private constructor(
        private readonly kind: "cookie" | "token",
        private readonly value: string,
        private readonly cookieName: string
    ) {}

    /**
     * Extracts the credentials of a request: the Penpot session cookie, else an
     * `Authorization: Token <access token>` header, else the token of the `auth` message
     * (taken as an access token).
     *
     * @param headers - the request headers (WebSocket upgrade or HTTP)
     * @param cookieName - name of the Penpot session cookie
     * @param authToken - token of the `auth` message, if any
     */
    public static from(headers: IncomingHttpHeaders, cookieName: string, authToken?: string): PenpotCredentials | null {
        const cookie = PenpotCredentials.cookie(headers.cookie, cookieName);
        if (cookie) {
            return new PenpotCredentials("cookie", cookie, cookieName);
        }
        const header = /^Token\s+([A-Za-z0-9._~+/=-]{8,2048})$/i.exec(String(headers.authorization ?? "").trim());
        if (header) {
            return new PenpotCredentials("token", header[1], cookieName);
        }
        const token = authToken?.trim();
        if (token && /^[A-Za-z0-9._~+/=-]{8,2048}$/.test(token)) {
            return new PenpotCredentials("token", token, cookieName);
        }
        return null;
    }

    /** Request headers presenting these credentials to the Penpot backend. */
    public headers(): Record<string, string> {
        return this.kind === "cookie"
            ? { Cookie: `${this.cookieName}=${this.value}` }
            : { Authorization: `Token ${this.value}` };
    }

    /** Digest identifying the credentials in caches (never the value itself). */
    public get fingerprint(): string {
        return createHash("sha256").update(`${this.kind}:${this.value}`).digest("base64url");
    }

    private static cookie(header: string | undefined, name: string): string | undefined {
        for (const part of (header ?? "").split(";")) {
            const index = part.indexOf("=");
            if (index > 0 && part.slice(0, index).trim() === name) {
                const value = part.slice(index + 1).trim();
                return value.length > 0 && value.length <= 4096 ? value : undefined;
            }
        }
        return undefined;
    }
}

/**
 * Client of the Penpot backend that tells who a request belongs to and which projects that
 * user may read.
 *
 * Every check calls the backend with the user's own credentials, so Penpot's permission rules
 * decide (`get-project` answers "not found" without read access). Answers are cached briefly.
 */
export class PenpotIdentity {
    private static readonly ZERO_UUID = "00000000-0000-0000-0000-000000000000";
    private static readonly UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    private readonly logger = createLogger("PenpotIdentity");
    private readonly cache = new Map<string, { expires: number; value: Promise<unknown> }>();

    /**
     * @param backendUri - internal URL of the Penpot backend
     * @param fetchFn - HTTP client (tests pass a fake)
     * @param ttlMs - how long answers are cached
     * @param now - clock
     */
    constructor(
        private readonly backendUri: string,
        private readonly fetchFn: typeof fetch = fetch,
        private readonly ttlMs = 30_000,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * Gets the logged-in user of the credentials.
     *
     * @param credentials - the request's credentials
     * @returns the user, or null for anonymous or invalid credentials
     */
    public user(credentials: PenpotCredentials): Promise<PenpotUser | null> {
        return this.cached(`profile:${credentials.fingerprint}`, async () => {
            const profile = await this.rpc<Record<string, unknown>>("get-profile", {}, credentials);
            const id = typeof profile?.id === "string" ? profile.id : undefined;
            if (!id || id === PenpotIdentity.ZERO_UUID || !PenpotIdentity.UUID.test(id)) {
                return null;
            }
            return new PenpotUser(
                id,
                String(profile?.email ?? "").toLowerCase(),
                String(profile?.fullname ?? profile?.fullName ?? "")
            );
        });
    }

    /**
     * Gets the team of a project the user may read.
     *
     * @param credentials - the request's credentials
     * @param user - the user of the credentials
     * @param projectId - the Penpot project id
     * @returns the team id, or null when the project does not exist or the user may not read it
     */
    public projectTeam(credentials: PenpotCredentials, user: PenpotUser, projectId: string): Promise<string | null> {
        if (!PenpotIdentity.UUID.test(projectId)) {
            return Promise.resolve(null);
        }
        return this.cached(`project:${user.profileId}:${projectId}`, async () => {
            const project = await this.rpc<Record<string, unknown>>("get-project", { id: projectId }, credentials);
            const teamId = project?.teamId ?? project?.["team-id"] ?? project?.team_id;
            return typeof teamId === "string" && PenpotIdentity.UUID.test(teamId) ? teamId.toLowerCase() : null;
        });
    }

    private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
        const now = this.now();
        const hit = this.cache.get(key);
        if (hit && hit.expires > now) {
            return hit.value as Promise<T>;
        }
        if (this.cache.size > 10_000) {
            for (const [k, entry] of this.cache) {
                if (entry.expires <= now) {
                    this.cache.delete(k);
                }
            }
        }
        const value = load();
        this.cache.set(key, { expires: now + this.ttlMs, value });
        // a failed backend call is not remembered
        value.catch(() => this.cache.delete(key));
        return value;
    }

    /**
     * Calls a read-only backend RPC method; null on "not found"/"not authorized" answers.
     */
    private async rpc<T>(
        method: string,
        params: Record<string, string>,
        credentials: PenpotCredentials
    ): Promise<T | null> {
        const url = new URL(`${this.backendUri}/api/main/methods/${method}`);
        for (const [name, value] of Object.entries(params)) {
            url.searchParams.set(name, value);
        }
        const response = await this.fetchFn(url, {
            method: "GET",
            headers: { ...credentials.headers(), Accept: "application/json", "X-Client": "penforge-agent" },
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 200) {
            return (await response.json()) as T;
        }
        await response.body?.cancel();
        if ([400, 401, 403, 404].includes(response.status)) {
            return null;
        }
        this.logger.warn("Penpot backend answered %d to %s", response.status, method);
        throw new Error(`The Penpot backend is not available (${response.status})`);
    }
}
