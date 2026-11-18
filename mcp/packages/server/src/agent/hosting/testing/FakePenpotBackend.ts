/**
 * Fake Penpot backend for server-mode tests: answers `get-profile` and `get-project` like the
 * real RPC (JSON, camelCase keys, the zero uuid for anonymous, 404 without read permission).
 */
export class FakePenpotBackend {
    /** session cookie value or access token → profile */
    private readonly sessions = new Map<string, { id: string; email: string; fullname: string }>();
    /** project id → team id */
    private readonly projects = new Map<string, string>();
    /** profile id → team ids */
    private readonly members = new Map<string, Set<string>>();
    /** backend calls seen, as `<method> <credential kind>` */
    public readonly calls: string[] = [];

    /**
     * Adds a user with a session cookie value (also accepted as access token).
     */
    public addUser(session: string, profile: { id: string; email: string; fullname?: string }, teams: string[]): this {
        this.sessions.set(session, { fullname: "User", ...profile });
        this.members.set(profile.id, new Set(teams));
        return this;
    }

    /** Adds a project of a team. */
    public addProject(projectId: string, teamId: string): this {
        this.projects.set(projectId, teamId);
        return this;
    }

    /** The `fetch` replacement. */
    public readonly fetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        const cookie = /auth-token=([^;]+)/.exec(headers.get("cookie") ?? "")?.[1];
        const token = /^Token (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
        const session = cookie ?? token;
        const method = url.pathname.split("/").pop();
        this.calls.push(`${method} ${cookie ? "cookie" : token ? "token" : "none"}`);
        const profile = session ? this.sessions.get(session) : undefined;
        if (method === "get-profile") {
            return FakePenpotBackend.json(
                profile ?? { id: "00000000-0000-0000-0000-000000000000", fullname: "Anonymous User" }
            );
        }
        if (method === "get-project") {
            const id = url.searchParams.get("id") ?? "";
            const teamId = this.projects.get(id);
            if (!profile || !teamId || !this.members.get(profile.id)?.has(teamId)) {
                return FakePenpotBackend.json({ type: "not-found", code: "object-not-found" }, 404);
            }
            return FakePenpotBackend.json({ id, teamId, name: "Project" });
        }
        return FakePenpotBackend.json({ type: "not-found" }, 404);
    };

    private static json(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }
}
