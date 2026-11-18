import { request } from "node:http";

export interface SessionCookie {
    name: string;
    value: string;
    /** Seconds since the epoch, when the backend sent an expiry. */
    expirationDate?: number;
    httpOnly: boolean;
    path: string;
}

/** Parses one `Set-Cookie` header value. */
export function parseSetCookie(header: string): SessionCookie | undefined {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    const eq = pair?.indexOf("=") ?? -1;
    if (!pair || eq <= 0) {
        return undefined;
    }
    const cookie: SessionCookie = {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        httpOnly: false,
        path: "/",
    };
    for (const attribute of attributes) {
        const [rawKey, ...rest] = attribute.split("=");
        const key = rawKey!.toLowerCase();
        const value = rest.join("=");
        if (key === "httponly") {
            cookie.httpOnly = true;
        } else if (key === "path" && value) {
            cookie.path = value;
        } else if (key === "max-age" && value) {
            const seconds = Number.parseInt(value, 10);
            if (Number.isFinite(seconds)) {
                cookie.expirationDate = Math.floor(Date.now() / 1000) + seconds;
            }
        } else if (key === "expires" && value && cookie.expirationDate === undefined) {
            const time = Date.parse(value);
            if (Number.isFinite(time)) {
                cookie.expirationDate = Math.floor(time / 1000);
            }
        }
    }
    return cookie;
}

export interface LocalLoginResult {
    profileId: string;
    cookies: SessionCookie[];
}

export interface LocalLoginProfile {
    /** Used only when the profile is created (first login). */
    fullname?: string;
    persona?: "designer" | "developer";
}

/**
 * Logs the single local profile in by calling `penforge-local-login` on the backend port
 * directly (never through the gateway, so the secret stays out of the browser). Answers the
 * session cookie(s) for the window's cookie jar.
 */
export function localLogin(backendPort: number, secret: string, profile: LocalLoginProfile = {}, timeoutMs = 30_000): Promise<LocalLoginResult> {
    const body = JSON.stringify({
        secret,
        ...(profile.fullname ? { fullname: profile.fullname } : {}),
        ...(profile.persona ? { persona: profile.persona } : {}),
    });
    return new Promise((resolve, reject) => {
        const req = request(
            {
                host: "127.0.0.1",
                port: backendPort,
                method: "POST",
                path: "/api/main/methods/penforge-local-login",
                timeout: timeoutMs,
                headers: {
                    "content-type": "application/json",
                    accept: "application/json",
                    "content-length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let text = "";
                res.on("data", (chunk: Buffer) => (text += chunk.toString()));
                res.on("end", () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`local login failed (${res.statusCode}): ${text.slice(0, 500)}`));
                        return;
                    }
                    const cookies = (res.headers["set-cookie"] ?? [])
                        .map(parseSetCookie)
                        .filter((cookie): cookie is SessionCookie => cookie !== undefined);
                    if (cookies.length === 0) {
                        reject(new Error("local login answered without a session cookie"));
                        return;
                    }
                    let profileId = "";
                    try {
                        profileId = String((JSON.parse(text) as { id?: string }).id ?? "");
                    } catch {
                        profileId = "";
                    }
                    resolve({ profileId, cookies });
                });
            },
        );
        req.on("timeout", () => req.destroy(new Error("local login timed out")));
        req.on("error", reject);
        req.end(body);
    });
}
