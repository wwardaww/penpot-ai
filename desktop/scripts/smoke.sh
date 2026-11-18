#!/usr/bin/env bash
# Smoke test of the Penforge desktop app on macOS (and Linux AppImage builds).
#
# Starts the app with --smoke on a fresh data folder: it boots PostgreSQL, the
# backend (with its migrations), media-processor and the daemon, checks the
# gateway, the local login and an authenticated RPC, and shuts everything down.
# The script samples the memory of the app's processes while it runs and checks
# afterwards that no postgres/java/node process of the app is left.
#
# Usage: scripts/smoke.sh <path to Penforge.app or executable> [timeout seconds]
set -euo pipefail

APP_PATH="${1:?usage: smoke.sh <Penforge.app|executable> [timeout]}"
TIMEOUT="${2:-600}"

if [[ -d "$APP_PATH" && "$APP_PATH" == *.app ]]; then
    EXE="$APP_PATH/Contents/MacOS/Penforge"
    APP_DIR="$(cd "$APP_PATH" && pwd)"
else
    EXE="$APP_PATH"
    APP_DIR="$(cd "$(dirname "$APP_PATH")" && pwd)"
fi
[[ -x "$EXE" ]] || { echo "app not found: $EXE" >&2; exit 1; }

DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/penforge-smoke-XXXXXX")"
OUT="$DATA_DIR/smoke-stdout.txt"

app_pids() {
    # processes whose command lives inside the app bundle
    ps -axo pid=,command= | awk -v dir="$APP_DIR" 'index($0, dir) > 0 { print $1 }'
}

START=$(date +%s)
PENFORGE_DESKTOP_DATA="$DATA_DIR" "$EXE" --smoke >"$OUT" 2>"$DATA_DIR/smoke-stderr.txt" &
PID=$!
PEAK_KB=0
while kill -0 "$PID" 2>/dev/null; do
    if (( $(date +%s) - START > TIMEOUT )); then
        for p in $(app_pids); do kill -9 "$p" 2>/dev/null || true; done
        echo "smoke run timed out after $TIMEOUT s" >&2
        exit 1
    fi
    PIDS=$(app_pids | paste -sd, -)
    if [[ -n "$PIDS" ]]; then
        TOTAL=$(ps -o rss= -p "$PIDS" | awk '{ s += $1 } END { print s + 0 }')
        (( TOTAL > PEAK_KB )) && PEAK_KB=$TOTAL
    fi
    sleep 1
done
set +e
wait "$PID"
CODE=$?
set -e
ELAPSED=$(( $(date +%s) - START ))
sleep 2
LEFT=$(app_pids | paste -sd' ' -)

cat "$OUT"
echo "exit code: $CODE, total ${ELAPSED} s"
echo "peak memory of the app's processes: $(( PEAK_KB / 1024 )) MB"
[[ -n "$LEFT" ]] && echo "LEFTOVER PROCESSES: $LEFT"
echo "logs: $DATA_DIR/logs"

if [[ "$CODE" -eq 0 && -z "$LEFT" ]]; then
    rm -rf "$DATA_DIR"
    exit 0
fi
exit 1
