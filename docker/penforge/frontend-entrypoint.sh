#!/usr/bin/env bash
# Adds the Penforge endpoints to the frontend's config.js, then starts the
# image's own entrypoint. The endpoints sit below the public URI, behind the
# same TLS entry point, so the browser sends its Penpot session cookie.
set -euo pipefail

config=/var/www/app/js/config.js
public="${PENPOT_PUBLIC_URI%/}"
ws="${public/#https:/wss:}"
ws="${ws/#http:/ws:}"

if ! grep -q "penforgeAgentURI" "$config"; then
  {
    echo "var penforgeAgentURI = \"${ws}/penforge/agent\";"
    echo "var penforgeMcpBridgeURI = \"${ws}/penforge/mcp/ws\";"
  } >> "$config"
fi

exec /bin/bash /entrypoint.sh "$@"
