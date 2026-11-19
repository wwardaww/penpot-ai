#!/usr/bin/env bash
# Penforge desktop: the JVM part of the desktop build, run INSIDE the devenv
# container by scripts/desktop-build.mjs (one `docker exec` per step).
#
#   container-build.sh <step> <work-dir> [version]
#
# <work-dir> holds src/ (the source tree the orchestrator streams in) and
# out/ (what it copies back to Windows). Steps:
#   sync              move src.new/ (fresh tar extract) over src/, keeping caches
#   sync-incremental  the changed files were extracted into src/ directly: delete
#                     the ones in removed-list, restore executable bits
#   backend           backend uberjar -> out/backend/{penpot.jar,log4j2.xml,version.txt}
#   backend-templates also prefetch builtin-templates into out/backend-templates
#                     (upstream bundle step; the desktop app does not ship them)
#   fe-install        frontend pnpm install (+ plugins-runtime, ui packages)
#   fe-wasm           render-wasm release build (cargo + emscripten)
#   fe-mcp-plugin     MCP plugin build (WS_URI=/mcp/ws, as upstream)
#   fe-plugins        upstream example plugins (plugins/dist/apps)
#   fe-assets         styles, fonts, images, translations
#   fe-cljs           shadow-cljs release main worker
#   fe-libs           libs bundle
#   fe-dist           assemble out/frontend (4th argument `with-plugins`:
#                     add the example plugins, as the upstream bundle does)
#
# Every step prints one line `##measure {json}` with wall time, CPU time of
# the step's processes, peak RSS of its process tree, bytes written to disk
# and bytes received from the network, read by the orchestrator.
#
# Env: PENFORGE_SHADOW_XMX (heap of every JVM, default 1536m),
#      PENFORGE_PNPM_STORE (pnpm store dir; default: the devenv's store).

set -euo pipefail

STEP="${1:?step}"
WORK="${2:?work dir}"
VERSION="${3:-develop}"
EXTRA="${4:-}"
SRC="$WORK/src"
OUT="$WORK/out"

# One heap cap for every JVM the step starts (shadow-cljs, tools.build).
export JDK_JAVA_OPTIONS="-Xmx${PENFORGE_SHADOW_XMX:-1536m}"
# The devenv's pnpm store: no network for packages it already holds.
STORE="${PENFORGE_PNPM_STORE:-/home/penpot/penpot/.pnpm-store}"
export npm_config_store_dir="$STORE"
export pnpm_config_store_dir="$STORE"
export CI=true

net_rx() { awk 'NR>2 && $1 !~ /^lo:/ {sub(/:/," "); s+=$2} END {print s+0}' /proc/net/dev; }
io_write() { awk '/^write_bytes/ {print $2}' "/proc/$1/io" 2>/dev/null || echo 0; }

# Sum of the RSS (KiB) of every process below pid $1.
tree_rss() {
    ps -e -o pid=,ppid=,rss= | awk -v root="$1" '
        { parent[$1]=$2; rss[$1]=$3 }
        END {
            total=0
            for (p in parent) {
                q=p
                while (q != "" && q != 0 && q != 1) {
                    if (q == root) { total+=rss[p]; break }
                    q=parent[q]
                }
            }
            print total
        }'
}

# measure <name> <command...>: run, sample, print ##measure.
measure() {
    local name="$1"; shift
    local t0 rx0 w0 peak=0 rss status
    t0=$(date +%s%N); rx0=$(net_rx); w0=$(io_write $$)
    read -r _ _ cu0 cs0 _ < <(cat /proc/$$/stat | awk '{print $1, $2, $16, $17, 0}')
    ( "$@" ) &
    local pid=$!
    while kill -0 "$pid" 2>/dev/null; do
        rss=$(tree_rss "$pid"); (( rss > peak )) && peak=$rss
        sleep 1
    done
    status=0; wait "$pid" || status=$?
    local t1 rx1 w1 cu1 cs1 tck
    t1=$(date +%s%N); rx1=$(net_rx); w1=$(io_write $$)
    read -r _ _ cu1 cs1 _ < <(cat /proc/$$/stat | awk '{print $1, $2, $16, $17, 0}')
    tck=$(getconf CLK_TCK)
    awk -v n="$name" -v st="$status" -v t0="$t0" -v t1="$t1" -v c="$((cu1 + cs1 - cu0 - cs0))" -v tck="$tck" \
        -v peak="$peak" -v w="$((w1 - w0))" -v rx="$((rx1 - rx0))" 'BEGIN {
        printf "##measure {\"step\":\"%s\",\"status\":%d,\"wall_s\":%.1f,\"cpu_s\":%.1f,\"peak_rss_mb\":%d,\"disk_write_mb\":%d,\"net_rx_mb\":%d}\n",
            n, st, (t1 - t0) / 1e9, c / tck, peak / 1024, w / 1048576, rx / 1048576 }'
    return "$status"
}

do_sync() {
    mkdir -p "$SRC"
    # Keep the ignored build caches in src/ (node_modules, .shadow-cljs,
    # target dirs); replace every source file. Checksums are not needed:
    # tar keeps the mtimes, so unchanged files keep their shadow-cljs cache.
    rsync -a --delete \
        --exclude 'node_modules/' --exclude '.shadow-cljs/' --exclude '.cpcache/' \
        --exclude '/frontend/target/' --exclude '/frontend/resources/public/' \
        --exclude '/backend/target/' --exclude '/render-wasm/target/' \
        --exclude '/plugins/dist/' --exclude '/plugins/libs/*/dist/' \
        --exclude '/mcp/packages/*/dist/' --exclude '/frontend/packages/*/dist/' \
        --exclude '/.pnpm-store' --exclude '/frontend/src/app/render_wasm/api/shared.js' \
        "$WORK/src.new/" "$SRC/"
    rm -rf "$WORK/src.new"
    # every pnpm-workspace.yaml points at <repo>/.pnpm-store
    [[ -e "$SRC/.pnpm-store" ]] || ln -s "$STORE" "$SRC/.pnpm-store"
    restore_exec_bits
}

# tar on Windows loses the executable bit: restore it from the git index
# (the orchestrator writes the list of 100755 paths to exec-list)
restore_exec_bits() {
    if [[ -f "$WORK/exec-list" ]]; then
        (cd "$SRC" && tr '\n' '\0' < "$WORK/exec-list" | xargs -0 -r chmod +x 2>/dev/null || true)
    fi
}

do_sync_incremental() {
    if [[ -s "$WORK/removed-list" ]]; then
        (cd "$SRC" && tr '\n' '\0' < "$WORK/removed-list" | xargs -0 -r rm -f --)
    fi
    restore_exec_bits
}

do_backend() {
    cd "$SRC/backend"
    rm -rf target
    mkdir -p target/classes
    echo "$VERSION" > target/classes/version.txt
    cp ../CHANGES.md target/classes/changelog.md
    clojure -T:build jar
    rm -rf "$OUT/backend"; mkdir -p "$OUT/backend"
    mv target/penpot.jar "$OUT/backend/penpot.jar"
    cp resources/log4j2.xml "$OUT/backend/log4j2.xml"
    echo "$VERSION" > "$OUT/backend/version.txt"
    rm -rf target
}

do_backend_templates() {
    cd "$SRC/backend"
    rm -rf builtin-templates; mkdir builtin-templates
    bb ./scripts/prefetch-templates.clj resources/app/onboarding.edn builtin-templates/
    # next to the bundle, not in it: the desktop app does not ship them
    rm -rf "$OUT/backend-templates"
    mv builtin-templates "$OUT/backend-templates"
}

do_fe_install() {
    cd "$SRC/frontend"
    pnpm install --frozen-lockfile
    (cd ../plugins/libs/plugins-runtime && pnpm install --frozen-lockfile && pnpm run build)
    (cd packages/ui && pnpm run build)
}

do_fe_wasm() {
    cd "$SRC/frontend"
    NODE_ENV=production VERSION="$VERSION" pnpm run build:wasm
}

do_fe_mcp_plugin() {
    cd "$SRC/mcp"
    # as upstream frontend/scripts/build: not frozen (the image's pnpm is
    # older than the pinned one and reads the overrides differently)
    ./scripts/setup
    pnpm --filter mcp-common run build
    WS_URI="/mcp/ws" pnpm --filter mcp-plugin run build
}

do_fe_plugins() {
    cd "$SRC/plugins"
    rm -rf dist/apps
    pnpm -r install
    pnpm run build:plugins
}

do_fe_assets() {
    cd "$SRC/frontend"
    NODE_ENV=production pnpm run build:app:assets
}

do_fe_cljs() {
    cd "$SRC/frontend"
    NODE_ENV=production clojure -M:dev:shadow-cljs release main worker
}

do_fe_libs() {
    cd "$SRC/frontend"
    NODE_ENV=production pnpm run build:app:libs
}

do_fe_dist() {
    cd "$SRC/frontend"
    local tag="${VERSION}-$(date +%s)"
    sed -i "s/\.\/render.js/.\/render.js?version=$tag/g" resources/public/js/worker/main*.js
    local dist="$OUT/frontend"
    rm -rf "$dist"; mkdir -p "$dist"
    # what the desktop never serves (same filter as stage.mjs): config.js (the
    # gateway writes it), source maps, the wasm playground, and the pictures of
    # old release notes (images/features), which a new profile never sees
    rsync -a --exclude '*.map' --exclude 'wasm-playground*' --exclude '/js/config.js' \
        --exclude '/images/features/' resources/public/ "$dist/"
    if [[ "$EXTRA" == "with-plugins" && -d ../plugins/dist/apps ]]; then
        mkdir -p "$dist/plugins"
        rsync -a ../plugins/dist/apps/ "$dist/plugins/"
    fi
    if [[ -d ../mcp/packages/plugin/dist ]]; then
        mkdir -p "$dist/plugins/mcp"
        rsync -a ../mcp/packages/plugin/dist/ "$dist/plugins/mcp/"
    fi
    echo "$VERSION" > "$dist/version.txt"
}

fn="do_${STEP//-/_}"
if ! declare -F "$fn" >/dev/null; then
    echo "unknown step: $STEP" >&2
    exit 2
fi
mkdir -p "$WORK" "$OUT"
measure "$STEP" "$fn"
