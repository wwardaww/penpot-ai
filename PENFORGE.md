# Penforge — developer setup

Penforge is a fork of Penpot that adds an AI design-to-app studio driven by the
local `claude` CLI. This file covers what you need on a new machine to run the
development environment. Upstream Penpot docs still apply
(`docs/technical-guide/developer/devenv.md`).

## 1. Requirements

| | Windows 11 | macOS | Linux |
|---|---|---|---|
| Docker | Docker Desktop, WSL 2 engine | Docker Desktop | Docker Engine + compose plugin |
| Shell for `manage.sh` | Ubuntu on WSL 2 (not Git Bash) | Terminal | any bash |
| Extra tools | `rsync`, `openssl` inside Ubuntu | `openssl` | `rsync`, `openssl` |
| Host tools | Node 22+, `claude` CLI | same | same |

Windows notes:

- Install: `wsl --install`, reboot, then Docker Desktop. In Docker Desktop turn on
  *Settings → Resources → WSL integration → Ubuntu*.
- Give WSL enough memory. `%USERPROFILE%\.wslconfig`:
  ```ini
  [wsl2]
  memory=16GB
  processors=8

  [experimental]
  autoMemoryReclaim=dropcache
  ```
  Then `wsl --shutdown` and restart Docker Desktop. Below ~8 GB the first build
  fails or crawls.
- Keep the repository on an SSD. On a hard disk the first frontend build takes
  close to an hour.
- Run `manage.sh` from Ubuntu (`/mnt/<drive>/...`). Git Bash cannot run it:
  `env -i` hides the Windows environment and `docker compose` is not found.
- The repo forces LF line endings (`.gitattributes`). If you cloned before that,
  run `git config core.autocrlf false` and check out again.

## 2. Start the devenv

```bash
./manage.sh pull-devenv          # first time only
./manage.sh run-devenv --attach  # tmux: 0 frontend, 2 exporter, 3 backend
```

- Wait for `[:main] Build completed` in tmux window 0. Starts keep the
  shadow-cljs and wasm caches and only rebuild what changed (about a minute).
- On Windows the repository sits on an NTFS drive, which the container can
  only read through a slow bridge. `run-devenv` therefore copies the working
  tree to `~/.penforge-devenv/ws0/source` in WSL and starts a hidden Windows
  watcher (`scripts/penforge-mirror.mjs`) that copies every edit there within
  a second. Keep editing the Windows checkout; never edit `~/penpot` inside
  the container. Needs Node.js on Windows. `PENFORGE_MIRROR=0` turns it off.
- If the build looks stale or broken, start once with
  `PENFORGE_CLEAN_BUILD=1 ./manage.sh run-devenv` to wipe the caches.
- Storybook is off by default. To run it (port 3451):
  `PENFORGE_STORYBOOK=1 ./manage.sh run-devenv`.
- Detach with `Ctrl+b d`. Do not kill the tmux session, it runs the app.
- App: https://localhost:3449 (or http://localhost:3450).
- The devenv backend runs with `disable-admin-console enable-ai`
  (`docker/devenv/docker-compose.main.yml`). Penpot's admin console (Nitrate) is
  not available locally; with it enabled every profile request fails with
  `nitrate-unavailable`.

## 3. Trusted HTTPS (once per machine)

`run-devenv` calls `scripts/penforge-devenv-tls`, which creates a local CA and a
`localhost` certificate in `docker/devenv/files/local-tls/` (git-ignored). The CA
is name-constrained: it can only sign for `localhost`, `127.0.0.1` and `::1`, and
its key never leaves the machine. On first run the script prints the command that
trusts the CA for your OS, for example on Windows:

```powershell
Import-Certificate -FilePath "<repo>\docker\devenv\files\local-tls\ca.crt" -CertStoreLocation Cert:\CurrentUser\Root
```

Restart the browser afterwards. Do not trust the certificate bundled in the
devenv image: its CA private key is public.

## 4. Penforge AI daemon (host side)

The AI daemon runs on the host, where `claude` is logged in (`claude auth login`).
It extends the MCP server in `mcp/`:

```bash
node mcp/scripts/penforge.mjs   # from the repository root, any shell or OS
```

It installs dependencies on first run, builds, starts the daemon and prints a
pairing link (`https://localhost:3449/#/penforge/pair?token=...`). Open it, or
paste it into the AI tab's pairing box.

Ports on the host: 4401 (MCP), 4402 (plugin bridge), 4410 (agent WebSocket). The
devenv container's own MCP server is published on 14401 so it does not clash.

## 5. Known issues

- **Blank page with `unexpected Temporal __proto__`**: a browser extension
  (crypto wallets and similar) injects a non-standard `Temporal`. The plugin
  runtime now repairs or removes it and, if that fails, keeps the app running
  with plugins disabled. If you still see it, try a window without extensions.
- **Unstyled app / `ui.css` 404**: fixed in the ui package build; on old
  checkouts copy `frontend/packages/ui/dist/ui.css` to
  `frontend/resources/public/css/ui.css`.
- **Storybook errors** (`Failed to resolve import ... target/storybook`, only with
  `PENFORGE_STORYBOOK=1`): harmless until the storybook build finishes; the app
  does not need Storybook.
