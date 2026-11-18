#!/usr/bin/env node
// Penforge: keep a Linux-side mirror of the source tree for the devenv.
//
// On Windows the repository lives on an NTFS drive and the devenv container
// reaches it through the WSL 9p file-sharing bridge. Reading the frontend +
// common sources over that bridge takes ~23 s against ~0.05 s on ext4, and
// the shadow-cljs polling watcher pays it again every few seconds. This
// script copies the working tree into a folder on the WSL ext4 disk and
// keeps it in sync, so the container builds from fast storage while people
// and agents keep editing the Windows checkout.
//
// It runs on the Windows side (native, fast file watching) and is started
// by `scripts/penforge-devenv-mirror` from `./manage.sh run-devenv`.
//
//   node penforge-mirror.mjs --src <repo> --dst <\\wsl.localhost\...> --once
//   node penforge-mirror.mjs --src <repo> --dst <...> --watch
//
// What is mirrored: the files `git ls-files --cached --others
// --exclude-standard` lists (tracked + untracked-not-ignored), plus a few
// ignored files people edit by hand (EXTRA_FILES). Ignored files in the
// mirror (build output, caches, generated wasm artifacts) are never touched,
// and only files this script copied are ever deleted from the mirror.
//
// Edits made inside the mirror are overwritten: edit the Windows checkout.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EXTRA_FILES = ["frontend/resources/public/js/config.js"];
const SKIP_PREFIXES = [".git/", ".claude/", "wiki/"];
const MARKER = ".penforge-mirror-id";
const RECONCILE_MS = 30_000;
const DEBOUNCE_MS = 250;
const COPY_CONCURRENCY = 16;

function parseArgs(argv) {
    const args = { mode: null, src: null, dst: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--once" || a === "--watch" || a === "--stop") args.mode = a.slice(2);
        else if (a === "--src") args.src = argv[++i];
        else if (a === "--dst") args.dst = argv[++i];
        else if (a === "--log") args.log = argv[++i];
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!args.mode || !args.dst || (args.mode !== "stop" && !args.src)) {
        throw new Error("usage: penforge-mirror.mjs --src <repo> --dst <mirror> (--once|--watch)\n" +
                        "       penforge-mirror.mjs --dst <mirror> --stop");
    }
    if (args.src) args.src = path.resolve(args.src);
    return args;
}

let logFile = null;

function log(msg) {
    const line = `[penforge-mirror ${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
    if (logFile) {
        try {
            fs.appendFileSync(logFile, line);
        } catch {
            // logging must never stop the mirror
        }
    } else {
        process.stdout.write(line);
    }
}

function stateDir() {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache");
    return path.join(base, "Penforge", "mirror");
}

function stateKey(dst) {
    return createHash("sha1").update(dst.toLowerCase()).digest("hex").slice(0, 12);
}

const toPosix = (p) => p.split(path.sep).join("/");
const skipped = (rel) => SKIP_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));

function gitFileList(src) {
    const res = spawnSync("git", ["-C", src, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        maxBuffer: 256 * 1024 * 1024,
    });
    if (res.status !== 0) throw new Error(`git ls-files failed: ${res.stderr?.toString()}`);
    const files = res.stdout.toString("utf8").split("\0").filter(Boolean);
    return [...new Set([...files, ...EXTRA_FILES])].filter((f) => !skipped(f));
}

function gitIgnored(src, rels) {
    if (rels.length === 0) return new Set();
    const res = spawnSync("git", ["-C", src, "check-ignore", "-z", "--stdin"], {
        input: Buffer.from(rels.join("\0") + "\0", "utf8"),
    });
    // Exit 1 means "nothing ignored"; anything above is an error.
    if (res.status > 1) throw new Error(`git check-ignore failed: ${res.stderr?.toString()}`);
    return new Set(res.stdout.toString("utf8").split("\0").filter(Boolean));
}

class Mirror {
    constructor(src, dst) {
        this.src = src;
        this.dst = dst;
        this.statePath = path.join(stateDir(), `${stateKey(dst)}.json`);
        this.manifest = { id: null, files: {} };
        this.dirty = false;
    }

    async loadState() {
        try {
            this.manifest = JSON.parse(await fsp.readFile(this.statePath, "utf8"));
        } catch {
            this.manifest = { id: null, files: {} };
        }
        let markerId = null;
        try {
            markerId = (await fsp.readFile(path.join(this.dst, MARKER), "utf8")).trim();
        } catch {
            // missing marker: new or wiped mirror
        }
        if (!markerId || markerId !== this.manifest.id) {
            // The mirror does not match what we copied last time: start over.
            this.manifest = { id: randomUUID(), files: {} };
            await fsp.mkdir(this.dst, { recursive: true });
            await fsp.writeFile(path.join(this.dst, MARKER), this.manifest.id + "\n");
            this.dirty = true;
        }
    }

    async saveState() {
        if (!this.dirty) return;
        await fsp.mkdir(path.dirname(this.statePath), { recursive: true });
        const tmp = this.statePath + ".tmp";
        await fsp.writeFile(tmp, JSON.stringify(this.manifest));
        await fsp.rename(tmp, this.statePath);
        this.dirty = false;
    }

    async copy(rel) {
        const from = path.join(this.src, rel);
        let st;
        try {
            st = await fsp.stat(from);
        } catch {
            return this.remove(rel);
        }
        if (!st.isFile()) return false;
        const sig = [Math.trunc(st.mtimeMs), st.size];
        const prev = this.manifest.files[rel];
        if (prev && prev[0] === sig[0] && prev[1] === sig[1]) return false;
        const to = path.join(this.dst, rel);
        const data = await fsp.readFile(from);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        // writeFile truncates an existing file in place, which keeps its
        // Linux mode bits (executable scripts stay executable).
        await fsp.writeFile(to, data);
        this.manifest.files[rel] = sig;
        this.dirty = true;
        return true;
    }

    async remove(rel) {
        if (!(rel in this.manifest.files)) return false;
        await fsp.rm(path.join(this.dst, rel), { force: true });
        delete this.manifest.files[rel];
        this.dirty = true;
        return true;
    }

    async runPool(items, fn) {
        let next = 0;
        let changed = 0;
        const worker = async () => {
            while (next < items.length) {
                const item = items[next++];
                try {
                    if (await fn(item)) changed++;
                } catch (err) {
                    log(`failed ${item}: ${err.message}`);
                }
            }
        };
        await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker));
        return changed;
    }

    async fullSync() {
        const started = Date.now();
        const files = gitFileList(this.src);
        const wanted = new Set(files);
        const copied = await this.runPool(files, (rel) => this.copy(rel));
        const stale = Object.keys(this.manifest.files).filter((rel) => !wanted.has(rel));
        const removed = await this.runPool(stale, (rel) => this.remove(rel));
        await this.saveState();
        if (copied || removed) {
            log(`synced ${files.length} files: ${copied} copied, ${removed} removed (${Date.now() - started} ms)`);
        }
        return { copied, removed };
    }

    async syncPaths(rels) {
        const candidates = [...new Set(rels)].filter((rel) => rel && !skipped(rel));
        const ignored = gitIgnored(this.src, candidates);
        const extra = new Set(EXTRA_FILES);
        const todo = candidates.filter((rel) => extra.has(rel) || !ignored.has(rel));
        const changed = await this.runPool(todo, (rel) => this.copy(rel));
        await this.saveState();
        if (changed) log(`${changed} change(s): ${todo.slice(0, 3).join(", ")}${todo.length > 3 ? ", ..." : ""}`);
    }
}

const lockPath = (dst) => path.join(stateDir(), `${stateKey(dst)}.pid`);

function stopWatcher(dst) {
    try {
        const old = Number(fs.readFileSync(lockPath(dst), "utf8"));
        if (old && old !== process.pid) {
            process.kill(old);
            log(`stopped watcher (pid ${old})`);
        }
    } catch {
        // no watcher running
    }
}

function takeLock(dst) {
    // One watcher per mirror: a new one replaces the old one.
    const lock = lockPath(dst);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    stopWatcher(dst);
    fs.writeFileSync(lock, String(process.pid));
    const release = () => {
        try {
            if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.rmSync(lock);
        } catch {
            // ignore
        }
    };
    process.on("exit", release);
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
}

async function watch(mirror) {
    takeLock(mirror.dst);
    await mirror.fullSync();
    log(`watching ${mirror.src} -> ${mirror.dst}`);

    let pending = new Set();
    let timer = null;
    let busy = Promise.resolve();
    const flush = () => {
        const batch = [...pending];
        pending = new Set();
        timer = null;
        busy = busy.then(() => mirror.syncPaths(batch)).catch((err) => log(`sync error: ${err.message}`));
    };

    const watcher = fs.watch(mirror.src, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = toPosix(filename.toString());
        if (skipped(rel) || rel.includes("/node_modules/") || rel.startsWith("node_modules/")) return;
        pending.add(rel);
        if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
    });
    watcher.on("error", (err) => {
        log(`watch error (${err.message}); relying on the periodic full sync`);
    });

    // File watching on Windows can drop events (buffer overflow on big
    // checkouts); a periodic full pass catches anything missed. It only
    // stats the NTFS side, so it is cheap.
    setInterval(() => {
        busy = busy.then(() => mirror.fullSync()).catch((err) => log(`full sync error: ${err.message}`));
    }, RECONCILE_MS);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.log) {
        logFile = args.log;
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, "");
    }
    if (args.mode === "stop") {
        stopWatcher(args.dst);
        return;
    }
    const mirror = new Mirror(args.src, args.dst);
    await mirror.loadState();
    if (args.mode === "once") {
        const started = Date.now();
        const { copied, removed } = await mirror.fullSync();
        log(`mirror up to date (${copied} copied, ${removed} removed, ${Date.now() - started} ms)`);
        return;
    }
    await watch(mirror);
}

main().catch((err) => {
    log(err.stack || String(err));
    process.exit(1);
});
