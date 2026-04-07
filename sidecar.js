/**
 * Certspotter Sidecar
 *
 * Watches certspotter's state directory for STH data
 * and pushes it to the backend API.
 *
 * Two sources of STH data:
 *   1. unverified_sths/{treeSize}-{hash}.json — pending verification
 *   2. state.json → verified_sth — already verified (small logs clear
 *      unverified_sths almost instantly, so we also read the verified STH)
 */

const fs = require("fs");
const path = require("path");

const BACKEND_URL = process.env.BACKEND_URL;
const MONITOR_ID = process.env.MONITOR_ID || "monitor-default";
const MONITOR_API_KEY = process.env.MONITOR_API_KEY;
const STATE_DIR = process.env.CERTSPOTTER_STATE_DIR || "/var/lib/certspotter";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

if (!BACKEND_URL) {
  console.error("[Sidecar] BACKEND_URL environment variable is required");
  process.exit(1);
}

/** Track already-pushed STHs to avoid duplicates: logId -> "tree_size:root_hash" */
const lastPushed = new Map();

/**
 * Scans all log directories for STH data and pushes to backend.
 */
async function scanAndPush() {
  const logsDir = path.join(STATE_DIR, "logs");

  if (!fs.existsSync(logsDir)) {
    console.log("[Sidecar] Logs directory does not exist yet, waiting...");
    return;
  }

  const logDirs = fs.readdirSync(logsDir, { withFileTypes: true });

  for (const logDir of logDirs) {
    if (!logDir.isDirectory() || logDir.name.startsWith(".")) continue;

    const logId = logDir.name; // base64url-encoded log ID
    const logPath = path.join(logsDir, logId);

    // Source 1: unverified STH files (large logs where verification takes time)
    const sthDir = path.join(logPath, "unverified_sths");
    if (fs.existsSync(sthDir)) {
      const sthFiles = fs.readdirSync(sthDir).filter((f) => f.endsWith(".json"));
      for (const sthFile of sthFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sthDir, sthFile), "utf-8"));
          await maybePushSth(logId, data);
        } catch (err) {
          console.error(`[Sidecar] Error processing ${sthFile}:`, err.message);
        }
      }
    }

    // Source 2: verified STH from state.json (small logs where verification is instant)
    const stateFile = path.join(logPath, "state.json");
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        if (state.verified_sth) {
          await maybePushSth(logId, state.verified_sth);
        }
      } catch (err) {
        console.error(`[Sidecar] Error reading state for ${logId}:`, err.message);
      }
    }
  }
}

/**
 * Pushes an STH to the backend if it's new (different tree_size or root_hash).
 */
async function maybePushSth(logIdBase64Url, sth) {
  const key = `${sth.tree_size}:${sth.sha256_root_hash}`;
  if (lastPushed.get(logIdBase64Url) === key) return;

  // Convert base64url to standard padded base64 (matching Google's log_list.json format)
  let logId = logIdBase64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (logId.length % 4)) % 4;
  if (pad) logId += "=".repeat(pad);

  const payload = {
    log_id: logId,
    tree_size: sth.tree_size,
    root_hash: sth.sha256_root_hash,
    timestamp: sth.timestamp,
    monitor_id: MONITOR_ID,
  };

  const headers = { "Content-Type": "application/json" };
  if (MONITOR_API_KEY) headers["Authorization"] = `Bearer ${MONITOR_API_KEY}`;

  const response = await fetch(`${BACKEND_URL}/api/sth`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}: ${await response.text()}`);
  }

  lastPushed.set(logIdBase64Url, key);
  console.log(
    `[Sidecar] Pushed STH for log ${logId.substring(0, 16)}... tree_size=${sth.tree_size}`
  );
}

// Main loop
console.log(`[Sidecar] Starting - backend=${BACKEND_URL} monitor=${MONITOR_ID}`);
console.log(`[Sidecar] Watching state dir: ${STATE_DIR}`);
console.log(`[Sidecar] Poll interval: ${POLL_INTERVAL_MS}ms`);

async function loop() {
  while (true) {
    try {
      await scanAndPush();
    } catch (err) {
      console.error("[Sidecar] Scan error:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

loop();
