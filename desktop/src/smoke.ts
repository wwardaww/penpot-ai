import { request } from "node:http";
import { localLogin } from "./auth/localLogin";
import type { RunningApp } from "./boot";
import { isPortFree } from "./net/ports";

export interface SmokeCheck {
    name: string;
    ok: boolean;
    detail?: string;
}

interface Answer {
    status?: number;
    body: string;
}

function get(url: string, headers: Record<string, string> = {}): Promise<Answer> {
    return new Promise((resolve) => {
        const req = request(url, { method: "GET", headers, timeout: 15_000 }, (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => (body += chunk.toString()));
            res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        req.on("timeout", () => req.destroy());
        req.on("error", (error) => resolve({ body: error.message }));
        req.end();
    });
}

/**
 * Checks a booted app end to end over HTTP: the frontend and its config, the local login, an
 * authenticated RPC through the gateway, the daemon, and that the login RPC is not reachable
 * from the browser side.
 */
export async function smokeChecks(app: RunningApp): Promise<SmokeCheck[]> {
    const checks: SmokeCheck[] = [];
    const { origin, ports, state } = app.context;
    const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

    const index = await get(`${origin}/`);
    add("frontend index", index.status === 200 && /<html/i.test(index.body), `status ${index.status}`);

    const config = await get(`${origin}/js/config.js`);
    add("config.js", config.status === 200 && config.body.includes(`ws://127.0.0.1:${ports.agent}/agent`), `status ${config.status}`);

    const blocked = await get(`${origin}/api/main/methods/penforge-local-login`);
    add("login RPC hidden from the browser", blocked.status === 404, `status ${blocked.status}`);

    const foreignHost = await get(`${origin}/`, { host: "evil.example:80" });
    add("foreign Host refused", foreignHost.status === 403, `status ${foreignHost.status}`);

    try {
        const login = await localLogin(ports.backend, state.localLoginSecret);
        const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const profile = await get(`${origin}/api/main/methods/get-profile`, { cookie, accept: "application/json" });
        add("authenticated RPC through the gateway", profile.status === 200 && profile.body.includes(login.profileId), `status ${profile.status}`);
    } catch (error) {
        add("local login", false, (error as Error).message);
    }

    if (app.supervisor.statuses().some((s) => s.name === "daemon")) {
        const health = await get(`http://127.0.0.1:${ports.agent}/health`);
        add("daemon health", health.status === 200, `status ${health.status}`);
    }
    const media = await get(`http://127.0.0.1:${ports.mediaProcessor}/api/health`);
    add("media-processor health", media.status === 200, `status ${media.status}`);

    return checks;
}

/** After `stop()`: no supervised process alive and every port free again. */
export async function shutdownChecks(app: RunningApp): Promise<SmokeCheck[]> {
    const checks: SmokeCheck[] = [];
    const leftovers = app.supervisor.leftovers();
    checks.push({ name: "no process left", ok: leftovers.length === 0, detail: leftovers.join(", ") });
    for (const [name, port] of Object.entries(app.context.ports)) {
        checks.push({ name: `port ${name} released`, ok: await isPortFree(port), detail: String(port) });
    }
    return checks;
}
