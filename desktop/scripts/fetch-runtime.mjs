// Downloads the native runtime of the desktop app for one target and puts it in
// build/runtime/{jre,postgres}:
//   - Azul Zulu JDK 26 (same release as docker/images/Dockerfile.backend), turned
//     into a small JRE with jlink; the JDK is deleted afterwards.
//   - PostgreSQL 17 binaries repackaged by zonky (Maven Central).
// Checksums are verified (Azul metadata API, Maven .sha1). Downloads are kept in
// .cache/downloads (inside the worktree) and reused.
//
// Usage: node scripts/fetch-runtime.mjs [--target win-x64|mac-arm64|mac-x64|linux-x64] [--keep-downloads]
// jlink runs on the host, so the target must match the host OS and arch.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache", "downloads");
const RUNTIME = join(ROOT, "build", "runtime");

const ZULU = "zulu26.32.203-ca-jdk26.0.2.1";
const PG_VERSION = "17.5.0";

// Same module list as the backend docker image (docker/images/Dockerfile.backend),
// without the debugging/compiler tools a desktop user never runs.
const JRE_MODULES = [
    "java.base", "java.se", "jdk.net", "jdk.management", "jdk.unsupported", "jdk.jfr",
    "jdk.crypto.cryptoki", "jdk.charsets", "jdk.localedata", "jdk.zipfs", "jdk.naming.dns",
    "jdk.httpserver", "jdk.compiler",
];

const TARGETS = {
    "win-x64": { zulu: `${ZULU}-win_x64.zip`, pg: "windows-amd64", exe: ".exe" },
    "mac-arm64": { zulu: `${ZULU}-macosx_aarch64.tar.gz`, pg: "darwin-arm64v8", exe: "" },
    "mac-x64": { zulu: `${ZULU}-macosx_x64.tar.gz`, pg: "darwin-amd64", exe: "" },
    "linux-x64": { zulu: `${ZULU}-linux_x64.tar.gz`, pg: "linux-amd64", exe: "" },
};

function hostTarget() {
    const os = { win32: "win", darwin: "mac", linux: "linux" }[process.platform];
    return `${os}-${process.arch}`;
}

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: "inherit", ...options });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.message})`);
    }
}

async function hashFile(file, algorithm) {
    const hash = createHash(algorithm);
    await pipeline(createReadStream(file), hash);
    return hash.digest("hex");
}

async function download(url, file) {
    if (existsSync(file)) {
        return file;
    }
    mkdirSync(dirname(file), { recursive: true });
    console.log(`download ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`${url}: HTTP ${res.status}`);
    }
    const tmp = `${file}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    renameSync(tmp, file);
    return file;
}

async function zuluSha256(name) {
    const list = await (await fetch(`https://api.azul.com/metadata/v1/zulu/packages/?java_version=26.0.2&java_package_type=jdk&release_status=ga&page_size=200`)).json();
    const entry = list.find((p) => p.name === name);
    if (!entry) {
        throw new Error(`Azul metadata has no package ${name}`);
    }
    const detail = await (await fetch(`https://api.azul.com/metadata/v1/zulu/packages/${entry.package_uuid}`)).json();
    return detail.sha256_hash;
}

async function verify(file, algorithm, expected) {
    const actual = await hashFile(file, algorithm);
    if (actual.toLowerCase() !== String(expected).trim().split(/\s+/)[0].toLowerCase()) {
        rmSync(file, { force: true });
        throw new Error(`${file}: ${algorithm} mismatch (expected ${expected}, got ${actual})`);
    }
}

function extract(archive, dest) {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    // bsdtar (Windows 10+, macOS) reads zip, tar.gz and txz; GNU tar reads tar.gz and txz.
    // On Windows call the system bsdtar: a GNU tar from Git Bash reads `E:` as a remote host.
    const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    run(tar, ["-xf", archive, "-C", dest]);
}

function single(dir) {
    const entries = readdirSync(dir);
    return entries.length === 1 && statSync(join(dir, entries[0])).isDirectory() ? join(dir, entries[0]) : dir;
}

async function fetchJre(target) {
    const spec = TARGETS[target];
    const archive = await download(`https://cdn.azul.com/zulu/bin/${spec.zulu}`, join(CACHE, spec.zulu));
    await verify(archive, "sha256", await zuluSha256(spec.zulu));
    const jdkDir = join(ROOT, ".cache", "jdk");
    extract(archive, jdkDir);
    let home = single(jdkDir);
    // macOS archives nest the JDK under <name>/zulu-26.jdk/Contents/Home
    const macHome = readdirSync(home).find((e) => e.endsWith(".jdk"));
    if (macHome) {
        home = join(home, macHome, "Contents", "Home");
    }
    const out = join(RUNTIME, "jre");
    rmSync(out, { recursive: true, force: true });
    run(join(home, "bin", `jlink${spec.exe}`), [
        "--add-modules", JRE_MODULES.join(","),
        "--strip-debug", "--no-man-pages", "--no-header-files",
        "--compress", "zip-6",
        "--output", out,
    ]);
    rmSync(jdkDir, { recursive: true, force: true });
    console.log(`jre ready in ${out}`);
}

async function fetchPostgres(target) {
    const spec = TARGETS[target];
    const name = `embedded-postgres-binaries-${spec.pg}-${PG_VERSION}.jar`;
    const url = `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${spec.pg}/${PG_VERSION}/${name}`;
    const jar = await download(url, join(CACHE, name));
    const sha1 = await (await fetch(`${url}.sha1`)).text();
    await verify(jar, "sha1", sha1);
    const jarDir = join(ROOT, ".cache", "pgjar");
    extract(jar, jarDir);
    const txz = readdirSync(jarDir).find((e) => e.endsWith(".txz"));
    const out = join(RUNTIME, "postgres");
    extract(join(jarDir, txz), out);
    rmSync(jarDir, { recursive: true, force: true });
    // pgAdmin/wx and test leftovers of the Windows build, never used by the server
    for (const file of existsSync(join(out, "bin")) ? readdirSync(join(out, "bin")) : []) {
        if (/^wx.*\.dll$|^testplug\.dll$/i.test(file)) {
            rmSync(join(out, "bin", file), { force: true });
        }
    }
    for (const dir of ["include", "doc", join("share", "doc")]) {
        rmSync(join(out, dir), { recursive: true, force: true });
    }
    console.log(`postgres ready in ${out}`);
}

const target = arg("--target") ?? hostTarget();
if (!TARGETS[target]) {
    throw new Error(`unknown target ${target} (${Object.keys(TARGETS).join(", ")})`);
}
if (target !== hostTarget()) {
    throw new Error(`jlink needs the target OS: host is ${hostTarget()}, target ${target}`);
}
mkdirSync(RUNTIME, { recursive: true });
await fetchJre(target);
await fetchPostgres(target);
if (!process.argv.includes("--keep-downloads")) {
    rmSync(CACHE, { recursive: true, force: true });
}
