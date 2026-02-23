/**
 * Certspotter Sidecar
 *
 * Watches certspotter's state directory for new STH files
 * and pushes them to the backend API.
 *
 * Certspotter stores STHs at:
 *   {STATE_DIR}/logs/{logID_base64url}/unverified_sths/{treeSize}-{hash}.json
 *
 * Each JSON file contains:
 *   { tree_size, timestamp, sha256_root_hash, tree_head_signature }
 */

const fs = require("fs");
const path = require("path");

const BACKEND_URL = process.env.BACKEND_URL;
const MONITOR_ID = process.env.MONITOR_ID || "monitor-default";
const STATE_DIR = process.env.CERTSPOTTER_STATE_DIR || "/var/lib/certspotter";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

if (!BACKEND_URL) {
  console.error("[Sidecar] BACKEND_URL environment variable is required");
  process.exit(1);
}

/** Track already-pushed STH files to avoid duplicates */
const pushedFiles = new Set();

/**
 * Scans all log directories for new STH files and pushes them to backend.
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
    const sthDir = path.join(logsDir, logId, "unverified_sths");

    if (!fs.existsSync(sthDir)) continue;

    const sthFiles = fs.readdirSync(sthDir).filter((f) => f.endsWith(".json"));

    for (const sthFile of sthFiles) {
      const filePath = path.join(sthDir, sthFile);

      if (pushedFiles.has(filePath)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        await pushSth(logId, data);
        pushedFiles.add(filePath);
      } catch (err) {
        console.error(`[Sidecar] Error processing ${filePath}:`, err.message);
      }
    }
  }
}

/**
 * Pushes a single STH to the backend API.
 * @param {string} logIdBase64Url - Base64url-encoded log ID (directory name)
 * @param {object} sth - Parsed STH JSON from certspotter
 */
async function pushSth(logIdBase64Url, sth) {
  // Convert base64url to standard base64 for consistency with CT log list format
  const logId = logIdBase64Url.replace(/-/g, "+").replace(/_/g, "/");

  const payload = {
    log_id: logId,
    tree_size: sth.tree_size,
    root_hash: sth.sha256_root_hash,
    timestamp: sth.timestamp,
    monitor_id: MONITOR_ID,
  };

  const response = await fetch(`${BACKEND_URL}/api/sth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}: ${await response.text()}`);
  }

  console.log(
    `[Sidecar] Pushed STH for log ${logId.substring(0, 16)}... tree_size=${sth.tree_size}`
  );
}

/**
 * Cleanup: remove tracked files that no longer exist on disk
 * (certspotter removes STH files after verification)
 */
function cleanupTracked() {
  for (const filePath of pushedFiles) {
    if (!fs.existsSync(filePath)) {
      pushedFiles.delete(filePath);
    }
  }
}

// Main loop
console.log(`[Sidecar] Starting - backend=${BACKEND_URL} monitor=${MONITOR_ID}`);
console.log(`[Sidecar] Watching state dir: ${STATE_DIR}`);
console.log(`[Sidecar] Poll interval: ${POLL_INTERVAL_MS}ms`);

async function loop() {
  while (true) {
    try {
      await scanAndPush();
      cleanupTracked();
    } catch (err) {
      console.error("[Sidecar] Scan error:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

loop();
