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
// Stale unverified STH files (certspotter never finished verifying them — e.g.
// log is unreachable, sidecar pushed them already, or verification is stuck).
// Default 6h: certspotter normally verifies within minutes; anything older is
// effectively orphaned and just wastes disk.
const UNVERIFIED_STH_MAX_AGE_MS = parseInt(
  process.env.UNVERIFIED_STH_MAX_AGE_MS || `${6 * 60 * 60 * 1000}`,
  10
);
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

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

/**
 * Removes unverified STH files older than UNVERIFIED_STH_MAX_AGE_MS.
 * certspotter normally moves verified STHs to state.json and deletes them
 * from unverified_sths/ within minutes; files that linger past the cutoff
 * are stuck (log unreachable, verification failed, etc.) and just waste disk.
 * Safe to delete behind certspotter's back: it'll re-fetch on the next poll
 * if it still needs them.
 */
function cleanupStaleUnverifiedSths() {
  const logsDir = path.join(STATE_DIR, "logs");
  if (!fs.existsSync(logsDir)) return;

  const cutoff = Date.now() - UNVERIFIED_STH_MAX_AGE_MS;
  let deleted = 0;

  for (const logDir of fs.readdirSync(logsDir, { withFileTypes: true })) {
    if (!logDir.isDirectory() || logDir.name.startsWith(".")) continue;
    const sthDir = path.join(logsDir, logDir.name, "unverified_sths");
    if (!fs.existsSync(sthDir)) continue;

    for (const file of fs.readdirSync(sthDir)) {
      if (!file.endsWith(".json")) continue; // skip certspotter's .tmp.* files
      const filePath = path.join(sthDir, file);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (err) {
        // file vanished mid-iteration — fine, certspotter cleaned it up
        if (err.code !== "ENOENT") {
          console.error(`[Cleanup] Error processing ${filePath}:`, err.message);
        }
      }
    }
  }

  if (deleted > 0) {
    const ageHours = (UNVERIFIED_STH_MAX_AGE_MS / 3600000).toFixed(1);
    console.log(`[Cleanup] Removed ${deleted} unverified STH files older than ${ageHours}h`);
  }
}

// Main loop
console.log(`[Sidecar] Starting - backend=${BACKEND_URL} monitor=${MONITOR_ID}`);
console.log(`[Sidecar] Watching state dir: ${STATE_DIR}`);
console.log(`[Sidecar] Poll interval: ${POLL_INTERVAL_MS}ms`);
console.log(
  `[Sidecar] Unverified STH cleanup: max age ${UNVERIFIED_STH_MAX_AGE_MS}ms, interval ${CLEANUP_INTERVAL_MS}ms`
);

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

// Run cleanup once at startup, then on a slow interval
cleanupStaleUnverifiedSths();
setInterval(cleanupStaleUnverifiedSths, CLEANUP_INTERVAL_MS);

loop();
