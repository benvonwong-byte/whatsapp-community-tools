#!/usr/bin/env node

/**
 * iMessage Sync Script
 *
 * Reads ~/Library/Messages/chat.db and syncs messages to the Friends Dashboard.
 * Uses macOS built-in sqlite3 CLI — zero npm dependencies.
 *
 * Usage:
 *   node imessage-sync.js --install    # First-time setup + install launchd agent
 *   node imessage-sync.js              # Manual sync
 *   node imessage-sync.js --uninstall  # Remove launchd agent
 */

const { execSync, spawnSync } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");

// Paths
const CHAT_DB = path.join(os.homedir(), "Library/Messages/chat.db");
const CONFIG_PATH = path.join(os.homedir(), ".imessage-sync-config.json");
const CURSOR_PATH = path.join(os.homedir(), ".imessage-sync-cursor");
const PLIST_NAME = "com.friendsdashboard.imessage-sync";
const PLIST_PATH = path.join(os.homedir(), "Library/LaunchAgents", PLIST_NAME + ".plist");
const LOG_PATH = path.join(os.homedir(), "Library/Logs/imessage-sync.log");

// Apple epoch offset: seconds between Unix epoch (1970) and Apple epoch (2001-01-01)
const APPLE_EPOCH_OFFSET = 978307200;

// ── Helpers ──

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch { /* ignore */ }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("No config found. Run with --install first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function loadCursor() {
  try {
    return parseInt(fs.readFileSync(CURSOR_PATH, "utf-8").trim()) || 0;
  } catch {
    return 0;
  }
}

function saveCursor(rowid) {
  fs.writeFileSync(CURSOR_PATH, String(rowid));
}

function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

/**
 * Query chat.db using macOS built-in sqlite3 CLI.
 * Returns parsed JSON rows.
 */
function queryDb(sql) {
  try {
    const result = spawnSync("sqlite3", ["-json", "-readonly", CHAT_DB, sql], {
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf-8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      // sqlite3 might not support -json; fall back to separator mode
      return queryDbFallback(sql);
    }
    const out = result.stdout.trim();
    return out ? JSON.parse(out) : [];
  } catch (err) {
    // Try fallback if JSON mode fails
    return queryDbFallback(sql);
  }
}

/**
 * Fallback: use -separator mode for older sqlite3 versions.
 */
function queryDbFallback(sql) {
  const result = spawnSync("sqlite3", ["-header", "-separator", "\t", "-readonly", CHAT_DB, sql], {
    maxBuffer: 50 * 1024 * 1024,
    encoding: "utf-8",
  });
  if (result.error) throw result.error;
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).map(line => {
    const vals = line.split("\t");
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return obj;
  });
}

/**
 * POST data to the Railway API.
 */
function postToApi(apiUrl, syncKey, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiUrl + "/api/friends/imessage/sync");
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;

    const body = JSON.stringify(data);
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-sync-key": syncKey,
      },
    };

    const req = mod.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(responseBody));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Sync Logic ──

async function sync() {
  if (!fs.existsSync(CHAT_DB)) {
    log("ERROR: chat.db not found at " + CHAT_DB);
    log("Make sure you have Full Disk Access enabled for Terminal.");
    process.exit(1);
  }

  const config = loadConfig();
  const lastRowId = loadCursor();

  log(`Syncing iMessages (cursor: ROWID > ${lastRowId})...`);

  // Query new messages since last sync
  // Only 1:1 chats (not group), only actual messages (not reactions/tapbacks)
  const rows = queryDb(`
    SELECT
      m.ROWID as rowid,
      m.guid,
      m.text,
      m.date as apple_date,
      m.is_from_me,
      m.service,
      h.id as handle_id
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.ROWID > ${lastRowId}
      AND m.associated_message_type = 0
      AND m.text IS NOT NULL
      AND m.text != ''
      AND h.id IS NOT NULL
      AND m.cache_roomnames IS NULL
    ORDER BY m.ROWID ASC
    LIMIT 2000
  `);

  if (rows.length === 0) {
    log("No new messages to sync.");
    return;
  }

  log(`Found ${rows.length} new messages.`);

  // Convert to sync format
  const messages = [];
  let maxRowId = lastRowId;

  for (const row of rows) {
    const rowid = parseInt(row.rowid);
    if (rowid > maxRowId) maxRowId = rowid;

    // Convert Apple timestamp to Unix timestamp
    const appleDate = parseInt(row.apple_date) || 0;
    // chat.db dates can be in nanoseconds (newer macOS) or seconds (older)
    const unixTimestamp = appleDate > 1e15
      ? Math.floor(appleDate / 1e9) + APPLE_EPOCH_OFFSET
      : appleDate > 1e9
        ? Math.floor(appleDate / 1e6) + APPLE_EPOCH_OFFSET
        : appleDate + APPLE_EPOCH_OFFSET;

    const phone = normalizePhone(row.handle_id);
    if (!phone || phone.length < 7) continue; // Skip non-phone handles (emails etc.)

    messages.push({
      guid: row.guid,
      phone: phone,
      sender_name: "", // iMessage doesn't store names in chat.db
      text: row.text,
      timestamp: unixTimestamp,
      is_from_me: row.is_from_me === "1" || row.is_from_me === 1,
    });
  }

  if (messages.length === 0) {
    log("No phone-based messages to sync (email-only handles skipped).");
    saveCursor(maxRowId);
    return;
  }

  // Send in batches of 500
  const BATCH_SIZE = 500;
  let totalImported = 0;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      const result = await postToApi(config.apiUrl, config.syncKey, { messages: batch });
      totalImported += result.imported || 0;
      log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: imported ${result.imported}, skipped ${result.updated}`);
    } catch (err) {
      log(`ERROR posting batch: ${err.message}`);
      // Save cursor at last successful point
      if (i > 0) saveCursor(parseInt(messages[i - 1].guid) || maxRowId);
      return;
    }
  }

  saveCursor(maxRowId);
  log(`Sync complete! ${totalImported} new messages imported.`);
}

// ── Install / Uninstall ──

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function install() {
  console.log("\n=== iMessage Sync Setup ===\n");

  // Check chat.db access
  if (!fs.existsSync(CHAT_DB)) {
    console.log("WARNING: Cannot access " + CHAT_DB);
    console.log("Grant Full Disk Access to Terminal in System Settings > Privacy & Security.\n");
  }

  // Get API URL
  let apiUrl = await ask("Railway API URL (e.g. https://whatsapp-events-nyc-production.up.railway.app): ");
  apiUrl = apiUrl.replace(/\/$/, ""); // strip trailing slash

  // Generate or get sync key
  const syncKey = crypto.randomBytes(32).toString("hex");
  console.log("\nGenerated sync key (set this as IMESSAGE_SYNC_KEY env var on Railway):");
  console.log(`\n  ${syncKey}\n`);

  // Save config
  const config = { apiUrl, syncKey };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`Config saved to ${CONFIG_PATH}`);

  // Get interval
  const intervalStr = await ask("Sync interval in hours (default: 2): ");
  const intervalHours = parseInt(intervalStr) || 2;
  const intervalSeconds = intervalHours * 3600;

  // Create launchd plist
  const scriptPath = path.resolve(__filename);
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

  // Ensure LaunchAgents directory exists
  const launchDir = path.join(os.homedir(), "Library/LaunchAgents");
  if (!fs.existsSync(launchDir)) fs.mkdirSync(launchDir, { recursive: true });

  fs.writeFileSync(PLIST_PATH, plistContent);
  console.log(`\nLaunchAgent installed at ${PLIST_PATH}`);

  // Unload if already loaded, then load
  try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch { /* ignore */ }
  try {
    execSync(`launchctl load "${PLIST_PATH}"`);
    console.log("LaunchAgent loaded — sync will run every " + intervalHours + " hour(s).");
  } catch (err) {
    console.log("Could not load agent automatically. Run manually:");
    console.log(`  launchctl load "${PLIST_PATH}"`);
  }

  // Do initial sync
  console.log("\nRunning initial sync...\n");
  await sync();

  console.log("\n=== Setup Complete ===");
  console.log("IMPORTANT: Set this env var on Railway:");
  console.log(`  IMESSAGE_SYNC_KEY=${syncKey}`);
  console.log(`\nLogs: ${LOG_PATH}`);
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Cursor: ${CURSOR_PATH}`);
}

function uninstall() {
  console.log("Uninstalling iMessage sync...");
  try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch { /* ignore */ }
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
    console.log("Removed " + PLIST_PATH);
  }
  console.log("LaunchAgent removed. Config and cursor files preserved.");
  console.log(`To fully clean up, delete: ${CONFIG_PATH} and ${CURSOR_PATH}`);
}

// ── Main ──

const arg = process.argv[2];
if (arg === "--install") {
  install().catch(err => { console.error("Install failed:", err); process.exit(1); });
} else if (arg === "--uninstall") {
  uninstall();
} else {
  sync().catch(err => { log("Sync failed: " + err.message); process.exit(1); });
}
