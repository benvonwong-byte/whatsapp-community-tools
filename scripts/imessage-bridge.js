#!/usr/bin/env node

/**
 * iMessage Bridge Script
 *
 * Polls the server for pending iMessage send tasks,
 * executes them via AppleScript on the local Mac, and reports results.
 *
 * Reuses ~/.imessage-sync-config.json from imessage-sync.js.
 *
 * Usage:
 *   node imessage-bridge.js              # Run bridge (foreground)
 *   node imessage-bridge.js --install    # Install as LaunchAgent (always-on)
 *   node imessage-bridge.js --uninstall  # Remove LaunchAgent
 */

const { execFile, execSync } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Paths (reuses same config as imessage-sync.js)
const CONFIG_PATH = path.join(os.homedir(), ".imessage-sync-config.json");
const LOG_PATH = path.join(os.homedir(), "Library/Logs/imessage-bridge.log");
const PLIST_NAME = "com.friendsdashboard.imessage-bridge";
const PLIST_PATH = path.join(os.homedir(), "Library/LaunchAgents", PLIST_NAME + ".plist");
const POLL_INTERVAL_MS = 15000; // Poll every 15 seconds

const IS_LAUNCHD = !process.stdin.isTTY && !process.env.TERM;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [bridge] ${msg}`;
  console.log(line);
  if (!IS_LAUNCHD) {
    try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch { /* ignore */ }
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("No config found at " + CONFIG_PATH);
    console.error("Run imessage-sync.js --install first to set up.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

// ── HTTP helper ──

function apiRequest(method, urlPath, config, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.apiUrl + urlPath);
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;

    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method,
      headers: {
        "x-sync-key": config.syncKey,
        "Authorization": "Bearer " + config.adminToken,
        ...(bodyStr ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        } : {}),
      },
    };

    const req = mod.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(responseBody) });
        } catch {
          resolve({ status: res.statusCode, data: responseBody });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Request timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── AppleScript execution ──

function sendImessage(phone, message) {
  return new Promise((resolve, reject) => {
    const escapedMessage = message
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");

    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = iMessage
        set targetBuddy to participant "${phone}" of targetService
        send "${escapedMessage}" to targetBuddy
      end tell
    `;

    execFile("/usr/bin/osascript", ["-e", script], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ── Main poll loop ──

async function pollLoop() {
  const config = loadConfig();
  log("Bridge started. Polling " + config.apiUrl + " every " + (POLL_INTERVAL_MS / 1000) + "s");
  log("Press Ctrl+C to stop.");

  let consecutiveErrors = 0;
  const MAX_BACKOFF_MS = 60000;

  while (true) {
    try {
      const { status, data } = await apiRequest("GET", "/api/friends/imessage/bridge/pending", config);

      if (status === 401) {
        log("ERROR: Authentication failed. Check syncKey in " + CONFIG_PATH);
        consecutiveErrors++;
      } else if (status >= 200 && status < 300) {
        consecutiveErrors = 0;
        const tasks = data.tasks || [];

        for (const task of tasks) {
          log(`Processing task ${task.id}: send to ${task.phone}`);
          try {
            await sendImessage(task.phone, task.message);
            log(`Task ${task.id}: sent successfully`);
            await apiRequest("POST", "/api/friends/imessage/bridge/result", config, {
              taskId: task.id,
              ok: true,
            });
          } catch (err) {
            log(`Task ${task.id}: FAILED — ${err.message}`);
            await apiRequest("POST", "/api/friends/imessage/bridge/result", config, {
              taskId: task.id,
              ok: false,
              error: err.message,
            });
          }
        }
      } else {
        log(`WARN: Unexpected status ${status}`);
        consecutiveErrors++;
      }
    } catch (err) {
      consecutiveErrors++;
      log(`ERROR polling: ${err.message}`);
    }

    // Backoff on consecutive errors
    const delay = consecutiveErrors > 0
      ? Math.min(POLL_INTERVAL_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS)
      : POLL_INTERVAL_MS;

    await new Promise(r => setTimeout(r, delay));
  }
}

// ── LaunchAgent install/uninstall ──

function install() {
  loadConfig(); // Verify config exists
  log("Installing iMessage bridge LaunchAgent...");

  const scriptPath = path.resolve(__filename);
  const nodePath = process.execPath;

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
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

  const launchDir = path.join(os.homedir(), "Library/LaunchAgents");
  if (!fs.existsSync(launchDir)) fs.mkdirSync(launchDir, { recursive: true });

  fs.writeFileSync(PLIST_PATH, plistContent);
  console.log("LaunchAgent written to " + PLIST_PATH);

  try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch { /* ignore */ }
  try {
    execSync(`launchctl load "${PLIST_PATH}"`);
    console.log("LaunchAgent loaded — bridge is now running in the background.");
  } catch (err) {
    console.log("Could not auto-load. Run manually:");
    console.log(`  launchctl load "${PLIST_PATH}"`);
  }

  console.log("\nBridge polls every " + (POLL_INTERVAL_MS / 1000) + " seconds.");
  console.log("Logs: " + LOG_PATH);
}

function uninstall() {
  console.log("Uninstalling iMessage bridge...");
  try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch { /* ignore */ }
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
    console.log("Removed " + PLIST_PATH);
  }
  console.log("LaunchAgent removed.");
}

// ── Entry point ──

const arg = process.argv[2];
if (arg === "--install") {
  install();
} else if (arg === "--uninstall") {
  uninstall();
} else {
  pollLoop().catch(err => { log("Fatal: " + err.message); process.exit(1); });
}
