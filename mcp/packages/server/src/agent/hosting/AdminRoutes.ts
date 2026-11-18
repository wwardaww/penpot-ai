import type { Express, NextFunction, Request, Response } from "express";
import { createLogger } from "../../logger";
import type { HostingConfig } from "./HostingConfig";
import { PenpotCredentials, type PenpotIdentity } from "./PenpotIdentity";
import type { ServerStore } from "./ServerStore";
import type { UsageLedger } from "./UsageLedger";
import type { PenpotUser } from "./UserScope";

/**
 * Minimal admin page of server mode (`/admin/`, public path `/penforge/admin/`).
 *
 * Only Penpot users whose email is in `PENFORGE_ADMIN_EMAILS` get in (their Penpot session
 * authenticates them). Admins set the install's Anthropic API key (write-only: the page only
 * learns whether one is set and its last four characters), the limits and the model, and see
 * the month's token usage per team. Changes need a JSON body and an `Origin` header (checked
 * against the allowed origins before these routes), so other sites cannot post them.
 */
export class AdminRoutes {
    private readonly logger = createLogger("AdminRoutes");

    constructor(
        private readonly config: HostingConfig,
        private readonly identity: PenpotIdentity,
        private readonly store: ServerStore,
        private readonly ledger: UsageLedger
    ) {}

    /**
     * Installs the routes.
     *
     * @param app - the daemon's Express app
     */
    public install(app: Express): void {
        app.get("/admin", (req, res, next) => {
            // routing ignores the trailing slash; only the bare path is redirected
            if (req.originalUrl.split("?")[0] === "/admin") {
                res.redirect(302, "admin/");
            } else {
                next();
            }
        });
        app.get(
            "/admin/",
            (req, res, next) => this.guard(req, res, next),
            (_req, res) => {
                AdminRoutes.secure(res);
                res.type("html").send(ADMIN_PAGE);
            }
        );
        app.get(
            "/admin/admin.js",
            (req, res, next) => this.guard(req, res, next),
            (_req, res) => {
                AdminRoutes.secure(res);
                res.type("application/javascript").send(ADMIN_SCRIPT);
            }
        );
        app.get(
            "/admin/api/state",
            (req, res, next) => this.guard(req, res, next),
            (_req, res) => {
                void this.state().then((state) => {
                    AdminRoutes.secure(res);
                    res.json(state);
                });
            }
        );
        const json = (req: Request, res: Response, next: NextFunction) => AdminRoutes.readJson(req, res, next);
        app.put(
            "/admin/api/settings",
            (req, res, next) => this.guardChange(req, res, next),
            json,
            (req, res) => {
                const body = (req.body ?? {}) as { limits?: Record<string, unknown>; model?: unknown };
                const limits = typeof body.limits === "object" && body.limits ? body.limits : undefined;
                void this.store
                    .updateSettings({
                        limits: limits as Record<string, number> | undefined,
                        model: typeof body.model === "string" ? body.model.slice(0, 100) : undefined,
                    })
                    .then(() => this.state())
                    .then((state) => {
                        this.logger.info("Admin %s changed the settings", AdminRoutes.userOf(res).email);
                        res.json(state);
                    })
                    .catch((error: unknown) => res.status(400).json({ error: String(error) }));
            }
        );
        app.put(
            "/admin/api/api-key",
            (req, res, next) => this.guardChange(req, res, next),
            json,
            (req, res) => {
                const key = (req.body as { apiKey?: unknown } | undefined)?.apiKey;
                if (typeof key !== "string") {
                    res.status(400).json({ error: "apiKey must be a string" });
                    return;
                }
                void this.store
                    .setApiKey(key)
                    .then(() => this.state())
                    .then((state) => {
                        this.logger.info(
                            "Admin %s %s the API key",
                            AdminRoutes.userOf(res).email,
                            key.trim() ? "set" : "removed"
                        );
                        res.json(state);
                    })
                    .catch((error: unknown) =>
                        res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
                    );
            }
        );
    }

    private async state(): Promise<Record<string, unknown>> {
        return {
            apiKey: await this.store.apiKeyStatus(),
            settings: await this.store.settings(),
            usage: await this.ledger.monthSummary(),
        };
    }

    private guard(req: Request, res: Response, next: NextFunction): void {
        const credentials = PenpotCredentials.from(req.headers, this.config.values.cookieName);
        if (!credentials) {
            res.status(401).json({ error: "Log in to Penpot first" });
            return;
        }
        this.identity
            .user(credentials)
            .then((user) => {
                if (!user) {
                    res.status(401).json({ error: "Log in to Penpot first" });
                } else if (!this.config.isAdmin(user.email)) {
                    res.status(403).json({ error: "Only Penforge admins may open this page" });
                } else {
                    res.locals.penforgeUser = user;
                    next();
                }
            })
            .catch(() => res.status(503).json({ error: "Penpot is not available" }));
    }

    private guardChange(req: Request, res: Response, next: NextFunction): void {
        // the Origin was checked against the allowed origins; here it must also be present
        if (req.headers.origin === undefined || !req.is("application/json")) {
            res.status(403).json({ error: "Changes need a same-site JSON request" });
            return;
        }
        this.guard(req, res, next);
    }

    private static userOf(res: Response): PenpotUser {
        return res.locals.penforgeUser as PenpotUser;
    }

    private static secure(res: Response): void {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
        );
    }

    /** Reads a small JSON body into `req.body`. */
    private static readJson(req: Request, res: Response, next: NextFunction): void {
        const chunks: Buffer[] = [];
        let size = 0;
        let failed = false;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 16 * 1024 && !failed) {
                failed = true;
                res.status(413).json({ error: "Body too large" });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (failed) {
                return;
            }
            try {
                req.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                next();
            } catch {
                res.status(400).json({ error: "Invalid JSON" });
            }
        });
    }
}

const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Penforge admin</title>
<style>
body { font: 14px/1.5 system-ui, sans-serif; max-width: 640px; margin: 32px auto; padding: 0 16px; color: #1f1f1f; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
label { display: block; margin: 8px 0 2px; }
input { font: inherit; padding: 6px 8px; width: 100%; box-sizing: border-box; }
button { font: inherit; padding: 6px 14px; margin-top: 10px; }
.note { color: #666; } .error { color: #b00020; } table { border-collapse: collapse; } td { padding: 2px 12px 2px 0; }
</style>
</head>
<body>
<h1>Penforge admin</h1>
<p id="message" class="note"></p>
<h2>Anthropic API key</h2>
<p id="key-status" class="note"></p>
<form id="key-form" autocomplete="off">
<label for="api-key">New key (it is stored encrypted and never shown again)</label>
<input id="api-key" type="password" autocomplete="off" spellcheck="false">
<button type="submit">Save key</button> <button type="button" id="key-remove">Remove key</button>
</form>
<h2>Limits</h2>
<form id="limits-form">
<label for="concurrentTurnsPerUser">AI requests at the same time, per user</label><input id="concurrentTurnsPerUser" type="number" min="0">
<label for="turnsPerMinutePerUser">AI requests per minute, per user</label><input id="turnsPerMinutePerUser" type="number" min="0">
<label for="turnsPerDayPerUser">AI requests per day, per user</label><input id="turnsPerDayPerUser" type="number" min="0">
<label for="monthlyTokensPerTeam">Tokens per month, per team (0 = no limit)</label><input id="monthlyTokensPerTeam" type="number" min="0">
<label for="model">Claude model (empty = default)</label><input id="model" type="text" spellcheck="false">
<button type="submit">Save limits</button>
</form>
<h2>Usage this month</h2>
<table id="usage"></table>
<script src="admin.js"></script>
</body>
</html>
`;

const ADMIN_SCRIPT = `"use strict";
const LIMITS = ["concurrentTurnsPerUser", "turnsPerMinutePerUser", "turnsPerDayPerUser", "monthlyTokensPerTeam"];
const $ = (id) => document.getElementById(id);
function show(text, error) { const m = $("message"); m.textContent = text; m.className = error ? "error" : "note"; }
function render(state) {
  $("key-status").textContent = state.apiKey.configured ? "A key is set (ends with " + state.apiKey.hint + ")." : "No key is set: AI features do not work yet.";
  for (const name of LIMITS) { $(name).value = state.settings.limits[name]; }
  $("model").value = state.settings.model || "";
  const table = $("usage"); table.textContent = "";
  const teams = Object.entries(state.usage.teams);
  if (teams.length === 0) { const row = table.insertRow(); row.insertCell().textContent = "No usage in " + state.usage.month; }
  for (const [team, tokens] of teams) { const row = table.insertRow(); row.insertCell().textContent = team; row.insertCell().textContent = String(tokens); }
}
async function call(method, path, body) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { throw new Error(data.error || ("HTTP " + response.status)); }
  return data;
}
async function save(path, body, done) {
  try { render(await call("PUT", path, body)); show(done, false); } catch (error) { show(error.message, true); }
}
$("key-form").addEventListener("submit", (event) => { event.preventDefault(); const key = $("api-key").value.trim(); if (!key) { return; } $("api-key").value = ""; save("api/api-key", { apiKey: key }, "Key saved."); });
$("key-remove").addEventListener("click", () => save("api/api-key", { apiKey: "" }, "Key removed."));
$("limits-form").addEventListener("submit", (event) => { event.preventDefault(); const limits = {}; for (const name of LIMITS) { limits[name] = Number($(name).value); } save("api/settings", { limits, model: $("model").value }, "Limits saved."); });
call("GET", "api/state").then(render).catch((error) => show(error.message, true));
`;
