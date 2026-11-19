// One command for the whole Windows desktop build: backend + frontend in the
// devenv container, the Node parts and the native runtime on Windows, then
// electron-builder. Prints (and writes) a timing table of every step.
//
//   node scripts/desktop-build.mjs [--fast | --release | --baseline] [options]
//
// Profiles:
//   --fast      (default) unpacked app only (release/win-unpacked/Penforge.exe),
//               no installer; reuses every cache; skips unchanged parts.
//   --release   NSIS installer with `compression: maximum`; same caches and skips.
//   --baseline  the W23 procedure, for measuring: sequential, no reuse, cold
//               project caches, upstream frontend steps (example plugins,
//               templates), downloads deleted afterwards, maximum compression.
//
// Options:
//   --installer     with --fast: build the NSIS installer too (compression: store)
//   --compression <store|normal|maximum>  override the installer compression
//   --rebuild       ignore the "unchanged" stamps (rebuild every part, caches kept)
//   --cold          also wipe the project caches (container work dir, build/,
//                   desktop node_modules); the shared download cache stays
//   --no-parallel   run the Windows steps after the container steps
//   --measure       sample CPU/RAM/disk/network every 2 s for the timing table
//   --container <name>   devenv container (default penpot-devenv-ws0-main)
//   --drop-container-work  delete the container work dir afterwards (it keeps
//                   node_modules, shadow-cljs and cargo caches warm between builds)
//   --clean         delete the container work dir, build/ and release/, then exit
//
// Caches (bounded, outside the worktree, shared by every checkout):
//   <main checkout>/desktop/.cache/build-cache/  (or PENFORGE_DESKTOP_CACHE)
//     runtime/downloads Zulu JDK + zonky PostgreSQL archives (deleted once unpacked)
//     runtime/          jlink JRE + extracted PostgreSQL, keyed by version
//     electron-builder/ NSIS, 7-Zip (ELECTRON_BUILDER_CACHE)
//   <main checkout>/.pnpm-store  pnpm store (PENFORGE_PNPM_STORE)
//   Electron zips stay in the standard per-user %LOCALAPPDATA%\electron\Cache.
//   In the container: /home/penpot/desktop-build (node_modules, shadow-cljs and
//   cargo caches; --drop-container-work or --clean removes it).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ROOT, "..");
const WIN = process.platform === "win32";
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};

const PROFILE = flag("--baseline") ? "baseline" : flag("--release") ? "release" : "fast";
const BASELINE = PROFILE === "baseline";
const COLD = flag("--cold") || BASELINE;
const REBUILD = flag("--rebuild") || COLD;
const PARALLEL = !flag("--no-parallel") && !BASELINE;
const MEASURE = flag("--measure");
const CONTAINER = option("--container", process.env.PENPOT_MAIN_CONTAINER_NAME ?? "penpot-devenv-ws0-main");
const INSTALLER = PROFILE !== "fast" || flag("--installer");
const COMPRESSION = option("--compression", PROFILE === "fast" ? "store" : "maximum");
const XMX = process.env.PENFORGE_SHADOW_XMX ?? "1536m";
const WORK = "/home/penpot/desktop-build";

function git(...args) {
    const r = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    }
    return r.stdout;
}

const commonDir = git("rev-parse", "--git-common-dir").trim();
const MAIN = dirname(isAbsolute(commonDir) ? commonDir : resolve(REPO, commonDir));
const CACHE = process.env.PENFORGE_DESKTOP_CACHE ?? join(MAIN, "desktop", ".cache", "build-cache");
const PNPM_STORE = process.env.PENFORGE_PNPM_STORE ?? join(MAIN, ".pnpm-store");
const BUILD = join(ROOT, "build");
const RUNTIME = join(BUILD, "runtime");
const LOGS = join(BUILD, "logs");
const STAMPS = join(BUILD, "stamps.json");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

// ---------------------------------------------------------------- environment

const env = { ...process.env };
if (!BASELINE) {
    env.PENFORGE_PNPM_STORE = PNPM_STORE;
    env.PENFORGE_RUNTIME_CACHE = join(CACHE, "runtime");
    env.ELECTRON_BUILDER_CACHE = join(CACHE, "electron-builder");
} else {
    // W23: electron-builder's tools downloaded again (the Electron zip itself
    // comes from %LOCALAPPDATA%\electron\Cache in every profile)
    env.ELECTRON_BUILDER_CACHE = join(BUILD, "cold-cache", "electron-builder");
}
env.CSC_IDENTITY_AUTO_DISCOVERY = env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false";

// ---------------------------------------------------------------- step runner

const results = [];

function log(...args) {
    console.log(`[desktop-build] ${args.join(" ")}`);
}

/** Runs a command, output to build/logs/<name>.log; resolves with its measures. */
function step(name, command, args, { cwd = ROOT, stdin, pipeTo, parse } = {}) {
    return new Promise((resolvePromise, reject) => {
        mkdirSync(LOGS, { recursive: true });
        const logFile = join(LOGS, `${name.replace(/[^\w.-]+/g, "_")}.log`);
        const out = createWriteStream(logFile);
        const start = Date.now();
        log(`start ${name}`);
        const child = spawn(command, args, { cwd, env, shell: WIN && !pipeTo && !stdin && command !== "docker", stdio: ["pipe", "pipe", "pipe"] });
        let tail = "";
        const measures = [];
        const onText = (chunk) => {
            const text = chunk.toString();
            tail = (tail + text).slice(-4000);
            // seconds since the step started, to see where a long step spends its time
            const at = `[${((Date.now() - start) / 1000).toFixed(1)}s] `;
            out.write(text.replace(/^(?=.)/gm, at));
            for (const line of text.split("\n")) {
                if (line.startsWith("##measure ")) {
                    measures.push(JSON.parse(line.slice(10)));
                }
            }
        };
        if (pipeTo) {
            child.stdout.pipe(pipeTo.stdin);
        } else {
            child.stdout.on("data", onText);
        }
        child.stderr.on("data", onText);
        if (stdin) {
            stdin.pipe(child.stdin);
        } else {
            child.stdin.end();
        }
        child.on("error", reject);
        child.on("close", (code) => {
            out.end();
            const end = Date.now();
            const entry = { name, start, end, wall_s: (end - start) / 1000, status: code, ...(measures[0] ?? {}) };
            if (parse) Object.assign(entry, parse());
            results.push(entry);
            if (code !== 0) {
                reject(new Error(`${name} failed (exit ${code}), log ${logFile}\n${tail}`));
                return;
            }
            log(`done  ${name} ${entry.wall_s.toFixed(1)} s`);
            resolvePromise(entry);
        });
    });
}

function docker(...args) {
    return ["exec", "-i", "-u", "penpot", "-e", `PENFORGE_SHADOW_XMX=${XMX}`, CONTAINER, ...args];
}

function containerStep(name, extra = []) {
    return step(`container:${name}`, "docker", docker("bash", "-l", `${WORK}/src/desktop/scripts/container-build.sh`, name, WORK, VERSION, ...extra));
}

function systemTar() {
    return WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

// ---------------------------------------------------------------- change keys

const BACKEND_PATHS = ["backend", "common", "CHANGES.md", "deps.edn"];
const FRONTEND_PATHS = ["frontend", "common", "render-wasm", "plugins", "mcp/packages/plugin", "mcp/packages/common", "mcp/package.json", "mcp/pnpm-lock.yaml", "mcp/pnpm-workspace.yaml", "deps.edn", "package.json", "pnpm-lock.yaml"];
const DAEMON_PATHS = ["mcp"];
const MEDIA_PATHS = ["media-processor"];

/**
 * Content key of a set of paths: the git tree of HEAD plus the uncommitted
 * diff and the untracked files, so a dirty working tree gets its own key.
 */
function changeKey(paths, extra = "") {
    const hash = createHash("sha256");
    hash.update(extra);
    for (const p of paths) {
        hash.update(spawnSync("git", ["-C", REPO, "rev-parse", `HEAD:${p}`], { encoding: "utf8" }).stdout ?? "");
    }
    hash.update(git("diff", "HEAD", "--binary", "--", ...paths));
    const untracked = git("ls-files", "-z", "--others", "--exclude-standard", "--", ...paths).split("\0").filter(Boolean);
    for (const file of untracked) {
        hash.update(file);
        hash.update(readFileSync(join(REPO, file)));
    }
    return hash.digest("hex").slice(0, 16);
}

function readStamps() {
    try {
        return JSON.parse(readFileSync(STAMPS, "utf8"));
    } catch {
        return {};
    }
}

function writeStamp(part, key) {
    const stamps = readStamps();
    stamps[part] = key;
    mkdirSync(RUNTIME, { recursive: true });
    writeFileSync(STAMPS, JSON.stringify(stamps, null, 2));
}

function unchanged(part, key, ...dirs) {
    return !REBUILD && readStamps()[part] === key && dirs.every((d) => existsSync(join(RUNTIME, d)));
}

// ---------------------------------------------------------------- container part

async function sendSource() {
    // tracked + untracked-not-ignored files of the parts the container builds
    // (all of mcp/: its workspace install needs every package.json)
    const paths = [...new Set([...BACKEND_PATHS, ...FRONTEND_PATHS, "mcp", "desktop/scripts/container-build.sh", "LICENSE"])];
    const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths)
        .split("\0").filter((f) => f && existsSync(join(REPO, f)));
    const execs = git("ls-files", "-s", "--", ...paths).split("\n")
        .filter((l) => l.startsWith("100755")).map((l) => l.split("\t")[1]);
    mkdirSync(BUILD, { recursive: true });

    // Incremental upload: the manifest (size + mtime per file) of the last upload is
    // kept on both sides under one id; when the container still holds that upload,
    // only new or changed files travel and removed ones are deleted there.
    const manifestFile = join(BUILD, "source-manifest.json");
    const signatures = Object.fromEntries(files.map((f) => {
        const st = statSync(join(REPO, f));
        return [f, `${st.size}:${Math.round(st.mtimeMs)}`];
    }));
    let previous;
    try {
        previous = JSON.parse(readFileSync(manifestFile, "utf8"));
    } catch {
        previous = undefined;
    }
    const remoteId = COLD ? "" : spawnSync("docker", docker("cat", `${WORK}/src/.penforge-source-id`), { encoding: "utf8" }).stdout?.trim();
    const incremental = Boolean(!COLD && previous && remoteId && previous.id === remoteId);
    const send = incremental ? files.filter((f) => previous.files[f] !== signatures[f]) : files;
    const removed = incremental ? Object.keys(previous.files).filter((f) => !(f in signatures)) : [];
    const id = createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
    const target = incremental ? `${WORK}/src` : `${WORK}/src.new`;
    log(incremental ? `upload: ${send.length} changed, ${removed.length} removed files` : `upload: all ${files.length} files`);

    const list = join(BUILD, "source-files.txt");
    writeFileSync(list, send.join("\n"));
    const prep = COLD ? `rm -rf ${WORK};` : "";
    const fresh = incremental ? "" : `rm -rf ${WORK}/src.new && mkdir -p ${WORK}/src.new &&`;
    spawnSync("docker", docker("bash", "-c", `${prep} mkdir -p ${WORK} && ${fresh} cat > ${WORK}/exec-list`), { input: execs.join("\n") });
    spawnSync("docker", docker("bash", "-c", `cat > ${WORK}/removed-list`), { input: removed.join("\n") });
    if (send.length > 0) {
        const receiver = spawn("docker", docker("tar", "-x", "-C", target), { stdio: ["pipe", "inherit", "inherit"] });
        const received = new Promise((ok) => receiver.on("close", ok));
        await step("source-to-container", systemTar(), ["-c", "-f", "-", "-T", list], { cwd: REPO, pipeTo: receiver });
        const code = await received;
        if (code !== 0) {
            throw new Error(`tar -x in the container failed (${code})`);
        }
    }
    // a full sync runs from the fresh copy (src/ may not exist yet)
    const script = `${WORK}/${incremental ? "src" : "src.new"}/desktop/scripts/container-build.sh`;
    await step("container:sync", "docker", docker("bash", "-l", script, incremental ? "sync-incremental" : "sync", WORK, VERSION));
    spawnSync("docker", docker("bash", "-c", `printf %s ${id} > ${WORK}/src/.penforge-source-id`));
    writeFileSync(manifestFile, JSON.stringify({ id, files: signatures }));
}

async function copyOut(parts) {
    for (const part of parts) {
        rmSync(join(RUNTIME, part), { recursive: true, force: true });
    }
    mkdirSync(RUNTIME, { recursive: true });
    const extract = spawn(systemTar(), ["-x", "-f", "-", "-C", RUNTIME], { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise((ok) => extract.on("close", ok));
    await step(`copy-out:${parts.join("+")}`, "docker", docker("tar", "-c", "-f", "-", "-C", `${WORK}/out`, ...parts), { pipeTo: extract });
    if ((await done) !== 0) {
        throw new Error("extracting the container output failed");
    }
}

// The Windows steps wait for the source upload: run next to it, their disk
// load slowed the tar stream from 7 s to 59 s.
let sourceSent;
const sourceSentPromise = new Promise((ok) => { sourceSent = ok; });

async function containerPart() {
    const backendKey = changeKey(BACKEND_PATHS, VERSION + (BASELINE ? "templates" : ""));
    const frontendKey = changeKey(FRONTEND_PATHS, VERSION + (BASELINE ? "upstream" : ""));
    const needBackend = !unchanged("backend", backendKey, "backend/penpot.jar");
    const needFrontend = !unchanged("frontend", frontendKey, "frontend/index.html", "mcp-plugin");
    if (!needBackend && !needFrontend) {
        log("backend and frontend unchanged, container build skipped");
        sourceSent();
        return;
    }
    try {
        await sendSource();
    } finally {
        sourceSent();
    }
    if (needBackend) {
        await containerStep("backend");
        if (BASELINE) await containerStep("backend-templates");
    }
    if (needFrontend) {
        await containerStep("fe-install");
        await containerStep("fe-wasm");
        await containerStep("fe-mcp-plugin");
        if (BASELINE) await containerStep("fe-plugins");
        await containerStep("fe-assets");
        await containerStep("fe-cljs");
        await containerStep("fe-libs");
        await containerStep("fe-dist", BASELINE ? ["with-plugins"] : []);
    }
    const parts = [needBackend && "backend", needFrontend && "frontend"].filter(Boolean);
    await copyOut(parts);
    if (needFrontend) {
        // the MCP plugin of the frontend bundle is the one the gateway serves
        rmSync(join(RUNTIME, "mcp-plugin"), { recursive: true, force: true });
        cpSync(join(RUNTIME, "frontend", "plugins", "mcp"), join(RUNTIME, "mcp-plugin"), { recursive: true });
        writeStamp("frontend", frontendKey);
    }
    if (needBackend) writeStamp("backend", backendKey);
    if (BASELINE || flag("--drop-container-work")) {
        spawnSync("docker", docker("rm", "-rf", WORK));
    }
}

// ---------------------------------------------------------------- Windows part

async function stagePart(part, key, dir) {
    if (unchanged(part, key, dir)) {
        log(`${part} unchanged, staging skipped`);
        return;
    }
    const extra = part === "daemon" && !BASELINE ? ["--no-mcp-plugin"] : [];
    await step(`stage:${part}`, "node", ["scripts/stage.mjs", "--parts", part, ...extra]);
    writeStamp(part, key);
}

async function runtimePart() {
    const args = ["scripts/fetch-runtime.mjs"];
    if (!BASELINE) args.push("--keep-downloads");
    await step("fetch-runtime", "node", args);
}

async function desktopDeps() {
    if (COLD) {
        rmSync(join(ROOT, "node_modules"), { recursive: true, force: true });
    }
    const store = BASELINE ? [] : [`--config.store-dir=${PNPM_STORE}`];
    await step("desktop:install", "corepack", ["pnpm", "install", "--frozen-lockfile", ...store]);
    await step("desktop:esbuild", "node", ["scripts/build.mjs"]);
}

async function windowsPart() {
    const daemonKey = changeKey(DAEMON_PATHS);
    const mediaKey = changeKey(MEDIA_PATHS);
    const tasks = [
        async () => {
            await stagePart("daemon", daemonKey, "daemon/dist/index.js");
            await stagePart("media-processor", mediaKey, "media-processor/dist");
        },
        runtimePart,
        desktopDeps,
    ];
    if (PARALLEL) {
        await sourceSentPromise;
        await Promise.all(tasks.map((t) => t()));
    } else {
        for (const t of tasks) await t();
    }
}

/** Content key of what electron-builder puts around the runtime: the shell bundle, the
 * renderer pages, the packaging config and the Electron version. */
function shellKey() {
    const hash = createHash("sha256");
    const add = (path) => {
        if (!existsSync(path)) return;
        if (statSync(path).isDirectory()) {
            for (const entry of readdirSync(path).sort()) add(join(path, entry));
        } else {
            hash.update(path.slice(ROOT.length));
            hash.update(readFileSync(path));
        }
    };
    for (const p of ["dist", "renderer", "build-resources", "package.json", "electron-builder.yml", join("node_modules", "electron", "package.json")]) {
        add(join(ROOT, p));
    }
    hash.update(INSTALLER ? "nsis" : "dir");
    return hash.digest("hex").slice(0, 16);
}

async function packageApp() {
    await step("stage:finish", "node", ["scripts/stage.mjs", "--parts", "none"]);
    const key = shellKey();
    const unpacked = join(ROOT, "release", "win-unpacked");
    if (!INSTALLER && !REBUILD && readStamps().shell === key && existsSync(join(unpacked, "Penforge.exe"))) {
        // Same shell and asar: only the runtime changed. Mirror it into the unpacked app
        // (robocopy copies changed files only) instead of packaging everything again.
        const robocopy = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "robocopy.exe");
        await step("update-unpacked-runtime", robocopy, [RUNTIME, join(unpacked, "resources", "runtime"), "/MIR", "/NFL", "/NDL", "/NJH", "/NP", "/R:1", "/W:1", "/MT:16"])
            .catch((e) => {
                // robocopy: exit codes 0-7 are success (1 = files copied)
                const last = results[results.length - 1];
                if (last && last.status < 8) {
                    last.status = 0;
                    return last;
                }
                throw e;
            });
        return;
    }
    const builder = join(ROOT, "node_modules", ".bin", WIN ? "electron-builder.cmd" : "electron-builder");
    const args = ["--win", "--config", "electron-builder.yml", "--publish", "never", `-c.compression=${COMPRESSION}`];
    if (!INSTALLER) args.push("--dir");
    rmSync(join(ROOT, "release"), { recursive: true, force: true });
    await step(INSTALLER ? `electron-builder:nsis(${COMPRESSION})` : "electron-builder:dir", builder, args);
    writeStamp("shell", key);
}

// ---------------------------------------------------------------- measuring

function startSampler() {
    if (!MEASURE || !WIN) return null;
    const csv = join(LOGS, "samples.csv");
    const stop = join(LOGS, "sampler.stop");
    mkdirSync(LOGS, { recursive: true });
    rmSync(stop, { force: true });
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "perf-sampler.ps1"), "-Out", csv, "-StopFile", stop], { stdio: "ignore" });
    return { csv, stop, child };
}

async function stopSampler(sampler) {
    if (!sampler) return [];
    writeFileSync(sampler.stop, "");
    await new Promise((ok) => {
        const timer = setTimeout(() => { sampler.child.kill(); ok(); }, 15000);
        sampler.child.on("close", () => { clearTimeout(timer); ok(); });
    });
    const lines = readFileSync(sampler.csv, "utf8").trim().split(/\r?\n/).slice(1);
    return lines.map((l) => l.split(",").map(Number)).map(([t, cpu, committed, avail, w, r, rx, wsl]) => ({ t, cpu, committed, avail, w, r, rx, wsl }));
}

function annotate(samples) {
    if (!samples.length) return;
    const base = samples[0];
    for (const r of results) {
        const inside = samples.filter((s) => s.t >= r.start && s.t <= r.end);
        if (!inside.length) continue;
        const interval = 2; // seconds (approximate, WMI calls add a little)
        r.sys_cpu_pct = Math.round(inside.reduce((a, s) => a + s.cpu, 0) / inside.length);
        r.sys_ram_peak_gb = +(Math.max(...inside.map((s) => s.committed)) / 1024).toFixed(1);
        r.ram_over_start_gb = +((Math.max(...inside.map((s) => s.committed)) - base.committed) / 1024).toFixed(1);
        r.wsl_ws_peak_gb = +(Math.max(...inside.map((s) => s.wsl)) / 1024).toFixed(1);
        r.sys_disk_write_mb = Math.round(inside.reduce((a, s) => a + s.w, 0) * interval / 1048576);
        r.sys_net_rx_mb = Math.round(inside.reduce((a, s) => a + s.rx, 0) * interval / 1048576);
    }
}

function report(totalS) {
    const cols = ["name", "wall_s", "cpu_s", "peak_rss_mb", "disk_write_mb", "net_rx_mb", "sys_cpu_pct", "ram_over_start_gb", "wsl_ws_peak_gb", "sys_disk_write_mb", "sys_net_rx_mb"];
    const fmt = (v) => (v === undefined ? "" : typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v));
    const lines = [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`];
    for (const r of results) lines.push(`| ${cols.map((c) => fmt(r[c])).join(" | ")} |`);
    lines.push(`| **total** | **${totalS.toFixed(1)}** |`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(BUILD, "timings");
    mkdirSync(dir, { recursive: true });
    const header = `profile=${PROFILE} cold=${COLD} rebuild=${REBUILD} parallel=${PARALLEL} installer=${INSTALLER} compression=${COMPRESSION}`;
    writeFileSync(join(dir, `${stamp}-${PROFILE}.md`), `${header}\n\n${lines.join("\n")}\n`);
    writeFileSync(join(dir, `${stamp}-${PROFILE}.json`), JSON.stringify({ header, totalS, results }, null, 2));
    console.log(`\n${header}\n${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------- main

if (!WIN) {
    throw new Error("this script builds the Windows app; see .github/workflows/penforge-desktop.yml for macOS");
}
if (COLD || flag("--clean")) {
    spawnSync("docker", docker("rm", "-rf", WORK));
    rmSync(BUILD, { recursive: true, force: true });
}
if (BASELINE && resolve(REPO) !== resolve(MAIN)) {
    // W23 used the worktree's own (empty) pnpm store; never the main checkout's
    rmSync(join(REPO, ".pnpm-store"), { recursive: true, force: true });
}
if (flag("--clean")) {
    rmSync(join(ROOT, "release"), { recursive: true, force: true });
    log("removed the container work dir, build/ and release/");
    process.exit(0);
}
mkdirSync(BUILD, { recursive: true });
rmSync(LOGS, { recursive: true, force: true });
const sampler = startSampler();
const t0 = Date.now();
let failure;
try {
    log(`profile ${PROFILE}, cache ${BASELINE ? "(none)" : CACHE}`);
    if (PARALLEL) {
        await Promise.all([containerPart(), windowsPart()]);
    } else {
        await containerPart();
        await windowsPart();
    }
    await packageApp();
    if (BASELINE) {
        rmSync(join(BUILD, "cold-cache"), { recursive: true, force: true });
    }
} catch (e) {
    failure = e;
}
const total = (Date.now() - t0) / 1000;
annotate(await stopSampler(sampler));
report(total);
if (failure) {
    console.error(failure.message);
    process.exit(1);
}
const out = INSTALLER
    ? readdirSync(join(ROOT, "release")).filter((f) => f.endsWith(".exe")).map((f) => join(ROOT, "release", f))
    : [join(ROOT, "release", "win-unpacked", "Penforge.exe")];
for (const f of out) {
    log(`output ${f} (${Math.round(statSync(f).size / 1048576)} MB)`);
}
