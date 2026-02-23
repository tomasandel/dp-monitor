#!/bin/bash
set -e

echo "[Entrypoint] Starting certspotter + sidecar"
echo "[Entrypoint] MONITOR_ID=${MONITOR_ID}"
echo "[Entrypoint] BACKEND_URL=${BACKEND_URL}"

# Start certspotter daemon in background
# -start_at_end: don't download historical entries, start from current log state
# -verbose: log activity to stderr
certspotter -state_dir /var/lib/certspotter -watchlist /var/lib/certspotter/watchlist -start_at_end -stdout -verbose &
CERTSPOTTER_PID=$!

# Wait briefly for certspotter to create state directory structure
sleep 5

# Start sidecar
node /app/sidecar.js &
SIDECAR_PID=$!

echo "[Entrypoint] certspotter PID=${CERTSPOTTER_PID}, sidecar PID=${SIDECAR_PID}"

# Wait for either process to exit - if one dies, stop the other
wait -n ${CERTSPOTTER_PID} ${SIDECAR_PID}
echo "[Entrypoint] A process exited, shutting down"
kill ${CERTSPOTTER_PID} ${SIDECAR_PID} 2>/dev/null || true
wait
