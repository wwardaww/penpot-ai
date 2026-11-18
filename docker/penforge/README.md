# Penforge server stack

One `docker compose up` gives a team Penpot with the Penforge AI panels. Users
only need a browser; they sign in with their Penpot account.

```
browser ──https──► penforge-proxy (Caddy, the only published port)
                     ├─ /penforge/agent    ─► penforge-agent :4410  (AI chat, workflows)
                     ├─ /penforge/mcp/ws   ─► penforge-agent :4402  (design plugin bridge)
                     ├─ /penforge/admin/   ─► penforge-agent :4410  (admin page)
                     └─ everything else    ─► penpot-frontend :8080 ─► backend, exporter
penforge-agent ─► penpot-backend (who is this user? may they read this project?)
penforge-agent ─► api.anthropic.com (Claude, with the admin's API key)
```

## What you need

- A Linux host with Docker Engine 24+ and the compose plugin, 4 CPUs, 8 GB RAM.
- A DNS name pointing at it, ports 80 and 443 open (for automatic HTTPS), or a
  local run with `PENFORGE_TLS=internal`.
- An Anthropic API key. Anthropic does not allow claude.ai logins in products
  built on the Claude Agent SDK, so the server uses an API key, which the admin
  enters once on the admin page. Use is governed by Anthropic's Commercial Terms
  (https://www.anthropic.com/legal/commercial-terms).

## Install

```bash
cd docker/penforge
cp env.example .env
# fill in PENFORGE_SITE, PENFORGE_PUBLIC_URI, PENFORGE_TLS and the admin email;
# generate each secret:
openssl rand -base64 32   # PENPOT_SECRET_KEY
openssl rand -base64 32   # PENFORGE_SECRET_KEY
openssl rand -base64 32   # POSTGRES_PASSWORD
docker compose -p penforge up -d --build
```

Then:

1. Open the public URI and register the admin account (its email must be in
   `PENFORGE_ADMIN_EMAILS`).
2. Open `<public URI>/penforge/admin/`, paste the Anthropic API key, check the
   limits.
3. Other users register (or use your SSO, see Penpot's docs) and open a file:
   the AI tab connects by itself.

Keep `.env` safe: `PENFORGE_SECRET_KEY` decrypts the stored API key. Losing it
only means entering the key again; leaking it together with the `penforge_data`
volume leaks the key.

## Build the images

`penforge-agent` builds from this repository with `--build` (Node only).

The frontend, backend and exporter must be Penforge builds to show the AI panels
(the upstream `penpotapp/*` images run plain Penpot). From the repository root,
on a machine with the devenv (JVM builds):

```bash
./manage.sh build-frontend-bundle && ./manage.sh build-frontend-docker-image --tag penforge
./manage.sh build-backend-bundle  && ./manage.sh build-backend-docker-image  --tag penforge
./manage.sh build-exporter-bundle && ./manage.sh build-exporter-docker-image --tag penforge
```

This tags `penpotapp/<image>:penforge`, which `env.example` uses. Push them to
your registry and set `PENFORGE_*_IMAGE` when the server is another machine.

## Settings

| Variable | Meaning |
|---|---|
| `PENFORGE_SITE` | host name Caddy serves (`penforge.example.com`, or `localhost`) |
| `PENFORGE_PUBLIC_URI` | URL users open; add the port if it is not 443 |
| `PENFORGE_HTTP_PORT` / `PENFORGE_HTTPS_PORT` | published ports (80 / 443) |
| `PENFORGE_TLS` | email for Let's Encrypt, or `internal` (Caddy's local CA) |
| `PENPOT_SECRET_KEY` | Penpot's session signing key |
| `PENFORGE_SECRET_KEY` | 32 random bytes, base64: encrypts the API key, derives bridge tokens |
| `POSTGRES_PASSWORD` | database password |
| `PENFORGE_ADMIN_EMAILS` | Penpot accounts allowed on the admin page |
| `PENFORGE_RUNNER` | `api-key` (default) or `fake` (no Anthropic calls, for tests) |
| `PENPOT_FRONTEND_FLAGS` / `PENPOT_BACKEND_FLAGS` | Penpot flags; keep `enable-ai` |

Admin page (`/penforge/admin/`): Anthropic API key (write-only, the page only
shows its last four characters), AI requests per user at once / per minute /
per day, monthly token budget per team, Claude model. Usage per team for the
month is listed there and kept as JSON lines in the `penforge_data` volume
(`server/usage/<yyyy-mm>.jsonl`).

## How users are kept apart

- The agent socket and the plugin bridge read the user's Penpot session cookie
  and ask the backend who it is. Each project folder lives under its Penpot
  team (`/data/teams/<team>/projects/<project>`), and the backend must confirm
  the user may read the project before the agent touches it.
- Claude never sees the API key: each request gets a short-lived ticket for a
  proxy inside the agent, which adds the key.
- On the server Claude may only edit files of its own project; it may not run
  shell commands or fetch URLs.
- Each user's design-plugin connections are keyed by a token derived from their
  profile, so one user's AI request cannot drive another user's open file.

## Not yet supported

- **Build and preview of generated apps.** They need the sandbox runner (one
  hardened container per project, see `wiki/research/server-hosting.md`); until
  it ships the server answers "needs the Penforge sandbox". Chat and the design
  workflows (screens, audit, naming, comments, DESIGN.md, tokens export) run;
  they have been checked with the fake runner, not yet with a real API key.
- Publish to GitHub/Vercel/Netlify with admin-provided tokens.
- Several agent replicas (the MCP Redis bridge is not wired).

## Operations

```bash
docker compose -p penforge logs -f penforge-agent       # daemon log
docker compose -p penforge exec penforge-agent node -e "fetch('http://127.0.0.1:4410/health').then(r=>r.json()).then(console.log)"
docker compose -p penforge pull && docker compose -p penforge up -d --build   # update
docker compose -p penforge down        # stop (volumes kept)
```

Back up the volumes `penpot_postgres_v15`, `penpot_assets` and `penforge_data`.
