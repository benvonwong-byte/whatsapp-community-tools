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
 * Build a phone→name map from macOS Contacts database.
 */
function loadContactNames() {
  const phoneToName = {};
  const abDir = path.join(os.homedir(), "Library/Application Support/AddressBook/Sources");
  try {
    const sources = fs.readdirSync(abDir);
    for (const src of sources) {
      const dbPath = path.join(abDir, src, "AddressBook-v22.abcddb");
      if (!fs.existsSync(dbPath)) continue;
      try {
        const result = spawnSync("sqlite3", ["-json", "-readonly", dbPath,
          "SELECT c.ZFIRSTNAME, c.ZLASTNAME, p.ZFULLNUMBER FROM ZABCDRECORD c JOIN ZABCDPHONENUMBER p ON p.ZOWNER = c.Z_PK WHERE c.ZFIRSTNAME IS NOT NULL"
        ], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        if (result.stdout && result.stdout.trim()) {
          const rows = JSON.parse(result.stdout.trim());
          for (const r of rows) {
            const name = [r.ZFIRSTNAME, r.ZLASTNAME].filter(Boolean).join(" ").trim();
            const phone = normalizePhone(r.ZFULLNUMBER || "");
            if (name && phone.length >= 7) phoneToName[phone] = name;
          }
        }
      } catch { /* skip this source */ }
    }
  } catch { /* no contacts access */ }
  log(`Loaded ${Object.keys(phoneToName).length} contact names from macOS Contacts.`);
  return phoneToName;
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
function postToApi(apiUrl, syncKey, adminToken, data) {
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
        "Authorization": "Bearer " + adminToken,
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

/**
 * Extract plain text from NSAttributedString typedstream (attributedBody hex).
 * The text lives after the NSString type marker (\x01\x2B) + length byte(s).
 */
function extractTextFromHex(hexStr) {
  if (!hexStr) return "";
  const buf = Buffer.from(hexStr, "hex");
  // Find the \x01\x2B marker (NSString '+' type code)
  const marker = Buffer.from([0x01, 0x2B]);
  const idx = buf.indexOf(marker);
  if (idx < 0) return "";

  let start = idx + 2;
  let length = buf[start];

  // Multi-byte length encoding (NSArchiver format)
  if (length === 0x81) {
    length = buf[start + 1];
    start += 2;
  } else if (length === 0x82) {
    length = (buf[start + 1] << 8) | buf[start + 2];
    start += 3;
  } else if (length === 0x83) {
    length = (buf[start + 1] << 16) | (buf[start + 2] << 8) | buf[start + 3];
    start += 4;
  } else {
    start += 1;
  }

  if (start + length > buf.length) return "";
  return buf.subarray(start, start + length).toString("utf-8").replace(/\uFFFC/g, "").trim();
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
  const contactNames = loadContactNames();

  log(`Syncing iMessages (cursor: ROWID > ${lastRowId})...`);

  // Query new messages since last sync
  // Only 1:1 chats (not group), only actual messages (not reactions/tapbacks)
  // Read both text and hex(attributedBody) — modern macOS stores content in attributedBody
  let rows = queryDb(`
    SELECT
      m.ROWID as rowid,
      m.guid,
      m.text,
      hex(m.attributedBody) as attributed_hex,
      m.date as apple_date,
      m.is_from_me,
      m.service,
      h.id as handle_id
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.ROWID > ${lastRowId}
      AND m.associated_message_type = 0
      AND (m.text IS NOT NULL AND m.text != '' OR m.attributedBody IS NOT NULL)
      AND h.id IS NOT NULL
      AND m.cache_roomnames IS NULL
    ORDER BY m.ROWID ASC
    LIMIT 5000
  `);

  let grandTotal = 0;
  let currentCursor = lastRowId;

  // Loop until no more messages (handles 176K+ messages in chunks of 5000)
  while (true) {
    if (rows.length === 0) {
      if (grandTotal === 0) log("No new messages to sync.");
      break;
    }

    log(`Found ${rows.length} new messages (cursor: ${currentCursor}).`);

    // Convert to sync format
    const messages = [];
    let maxRowId = currentCursor;

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

      // Extract text: prefer text column, fall back to attributedBody extraction
      const bodyText = (row.text && row.text.trim()) || extractTextFromHex(row.attributed_hex);
      if (!bodyText) continue; // Skip empty messages (attachments without text, etc.)

      messages.push({
        guid: row.guid,
        phone: phone,
        sender_name: contactNames[phone] || "",
        text: bodyText,
        timestamp: unixTimestamp,
        is_from_me: row.is_from_me === "1" || row.is_from_me === 1,
      });
    }

    if (messages.length === 0) {
      log("No phone-based messages in this batch (email-only handles skipped).");
      saveCursor(maxRowId);
      currentCursor = maxRowId;
      // Still try next batch since there may be phone messages later
      if (rows.length < 5000) break;
      rows = queryDb(`
        SELECT m.ROWID as rowid, m.guid, m.text, hex(m.attributedBody) as attributed_hex,
               m.date as apple_date, m.is_from_me, m.service, h.id as handle_id
        FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.ROWID > ${currentCursor} AND m.associated_message_type = 0
          AND (m.text IS NOT NULL AND m.text != '' OR m.attributedBody IS NOT NULL)
          AND h.id IS NOT NULL AND m.cache_roomnames IS NULL
        ORDER BY m.ROWID ASC LIMIT 5000
      `);
      continue;
    }

    // Send in batches of 500
    const BATCH_SIZE = 500;
    let batchImported = 0;

    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      try {
        const result = await postToApi(config.apiUrl, config.syncKey, config.adminToken, { messages: batch });
        batchImported += result.imported || 0;
        log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: imported ${result.imported}, skipped ${result.updated}`);
      } catch (err) {
        log(`ERROR posting batch: ${err.message}`);
        saveCursor(maxRowId);
        return;
      }
    }

    grandTotal += batchImported;
    saveCursor(maxRowId);
    currentCursor = maxRowId;

    // If we got fewer than the limit, we're done
    if (rows.length < 5000) break;

    // Fetch next chunk
    rows = queryDb(`
      SELECT m.ROWID as rowid, m.guid, m.text, hex(m.attributedBody) as attributed_hex,
             m.date as apple_date, m.is_from_me, m.service, h.id as handle_id
      FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.ROWID > ${currentCursor} AND m.associated_message_type = 0
        AND (m.text IS NOT NULL AND m.text != '' OR m.attributedBody IS NOT NULL)
        AND h.id IS NOT NULL AND m.cache_roomnames IS NULL
      ORDER BY m.ROWID ASC LIMIT 5000
    `);
  }

  log(`Sync complete! ${grandTotal} new messages imported total.`);
}

// ── Audio Sync Logic ──

const AUDIO_DONE_PATH = path.join(os.homedir(), ".imessage-sync-audio-done");

function loadAudioDone() {
  try {
    return new Set(fs.readFileSync(AUDIO_DONE_PATH, "utf-8").trim().split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveAudioDone(doneSet) {
  fs.writeFileSync(AUDIO_DONE_PATH, [...doneSet].join("\n"));
}

function getAudioDuration(filePath) {
  try {
    const result = spawnSync("afinfo", [filePath], { encoding: "utf-8", timeout: 5000 });
    const match = (result.stdout || "").match(/estimated duration:\s*([\d.]+)/i);
    return match ? parseFloat(match[1]) : 30;
  } catch {
    return 30;
  }
}

function appleTimestampToUnix(appleDate) {
  appleDate = parseInt(appleDate) || 0;
  if (appleDate > 1e15) return Math.floor(appleDate / 1e9) + APPLE_EPOCH_OFFSET;
  if (appleDate > 1e9) return Math.floor(appleDate / 1e6) + APPLE_EPOCH_OFFSET;
  return appleDate + APPLE_EPOCH_OFFSET;
}

async function transcribeWithGroq(filePath, mimeType, groqApiKey) {
  const audioBuffer = fs.readFileSync(filePath);
  const blob = new Blob([audioBuffer], { type: mimeType || "audio/amr" });

  const form = new FormData();
  form.append("file", blob, path.basename(filePath));
  form.append("model", "whisper-large-v3");
  form.append("response_format", "text");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + groqApiKey },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq ${res.status}: ${errText}`);
  }

  return (await res.text()).trim();
}

// Groq free tier limits with 20% safety buffer
const GROQ_MAX_RPM = 16;             // 20 RPM limit → 16 with buffer
const GROQ_DELAY_MS = Math.ceil(60000 / GROQ_MAX_RPM); // ~3750ms between requests
const GROQ_MAX_AUDIO_SEC_PER_HOUR = 5760;  // 7200/hr limit → 5760 with buffer
const GROQ_MAX_AUDIO_SEC_PER_DAY = 23040;  // 28800/day limit → 23040 with buffer

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function syncAudio(maxDurationSeconds) {
  const config = loadConfig();
  if (!config.groqApiKey) {
    log("No groqApiKey in config — skipping audio transcription.");
    log("Add it to ~/.imessage-sync-config.json to enable voice note transcription.");
    return;
  }

  const contactNames = loadContactNames();

  // Cap to daily limit
  maxDurationSeconds = Math.min(maxDurationSeconds, GROQ_MAX_AUDIO_SEC_PER_DAY);
  log(`Syncing iMessage audio (max ${Math.round(maxDurationSeconds / 60)} min, throttled to ${GROQ_MAX_RPM} req/min)...`);

  const doneBefore = loadAudioDone();

  // Query all audio messages with file paths, most recent first
  const rows = queryDb(`
    SELECT
      m.guid,
      m.date as apple_date,
      m.is_from_me,
      h.id as handle_id,
      a.filename,
      a.mime_type
    FROM message m
    JOIN message_attachment_join maj ON maj.message_id = m.ROWID
    JOIN attachment a ON a.ROWID = maj.attachment_id
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE a.mime_type LIKE 'audio%'
      AND a.filename IS NOT NULL
      AND h.id IS NOT NULL
      AND m.cache_roomnames IS NULL
    ORDER BY m.date DESC
  `);

  if (rows.length === 0) {
    log("No audio messages found.");
    return;
  }

  log(`Found ${rows.length} total audio messages. Filtering already done...`);

  // Filter out already-done, resolve paths, get durations
  const candidates = [];
  let totalDuration = 0;

  for (const row of rows) {
    if (doneBefore.has(row.guid)) continue;

    const phone = normalizePhone(row.handle_id);
    if (!phone || phone.length < 7) continue;

    // Resolve file path (replace ~ with home dir)
    const filePath = (row.filename || "").replace(/^~/, os.homedir());
    if (!fs.existsSync(filePath)) continue;

    const duration = getAudioDuration(filePath);
    if (totalDuration + duration > maxDurationSeconds) {
      log(`Reached ${Math.round(totalDuration / 60)} min limit, stopping collection.`);
      break;
    }

    totalDuration += duration;
    candidates.push({
      guid: row.guid,
      phone,
      timestamp: appleTimestampToUnix(row.apple_date),
      is_from_me: row.is_from_me === "1" || row.is_from_me === 1,
      filePath,
      mimeType: row.mime_type,
      duration,
    });
  }

  if (candidates.length === 0) {
    log("No new audio messages to transcribe.");
    return;
  }

  log(`Transcribing ${candidates.length} voice notes (${Math.round(totalDuration / 60)} min total)...`);
  log(`  Rate limits: ${GROQ_MAX_RPM} req/min, ${Math.round(GROQ_MAX_AUDIO_SEC_PER_HOUR / 60)} min audio/hr, ${Math.round(GROQ_MAX_AUDIO_SEC_PER_DAY / 60)} min audio/day`);

  const voiceNotes = [];
  const doneSet = new Set(doneBefore);
  let transcribed = 0;
  let failed = 0;
  let audioSecsThisHour = 0;
  let hourStart = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];

    // Check hourly audio limit — if approaching, pause until the hour resets
    if (audioSecsThisHour + c.duration > GROQ_MAX_AUDIO_SEC_PER_HOUR) {
      const elapsed = Date.now() - hourStart;
      const waitMs = Math.max(0, 3600000 - elapsed) + 5000; // wait until hour + 5s buffer
      log(`  Hourly audio limit reached (${Math.round(audioSecsThisHour / 60)} min). Waiting ${Math.round(waitMs / 60000)} min for reset...`);
      await sleep(waitMs);
      audioSecsThisHour = 0;
      hourStart = Date.now();
    }

    // Throttle: wait between requests to stay under RPM limit
    await sleep(GROQ_DELAY_MS);

    try {
      const transcript = await transcribeWithGroq(c.filePath, c.mimeType, config.groqApiKey);
      audioSecsThisHour += c.duration;
      if (transcript) {
        voiceNotes.push({
          guid: c.guid,
          phone: c.phone,
          sender_name: contactNames[c.phone] || "",
          timestamp: c.timestamp,
          is_from_me: c.is_from_me,
          transcript,
          duration: c.duration,
        });
        transcribed++;
      } else {
        failed++;
      }
    } catch (err) {
      log(`  ERROR [${i + 1}/${candidates.length}]: ${err.message}`);
      failed++;
      // If rate limited despite our throttling, wait longer
      if (err.message.includes("429")) {
        // Parse wait time from error if available
        const waitMatch = err.message.match(/try again in (\d+)m(\d+)?s?/);
        const waitSec = waitMatch ? (parseInt(waitMatch[1]) * 60 + (parseInt(waitMatch[2]) || 0) + 10) : 120;
        log(`  Rate limited — waiting ${waitSec}s...`);
        await sleep(waitSec * 1000);
        i--; // retry this one
        continue;
      }
    }

    doneSet.add(c.guid);

    // Log progress every 10
    if ((i + 1) % 10 === 0) {
      log(`  Progress: ${i + 1}/${candidates.length} (${transcribed} ok, ${failed} failed, ${Math.round(audioSecsThisHour / 60)} min this hour)`);
    }

    // Send batch every 50 transcripts and save progress
    if (voiceNotes.length >= 50) {
      try {
        const result = await postToApi(config.apiUrl, config.syncKey, config.adminToken, { voiceNotes });
        log(`  Sent batch: ${result.voiceImported} imported`);
      } catch (err) {
        log(`  ERROR sending batch: ${err.message}`);
      }
      voiceNotes.length = 0;
      saveAudioDone(doneSet);
    }
  }

  // Send remaining
  if (voiceNotes.length > 0) {
    try {
      const result = await postToApi(config.apiUrl, config.syncKey, config.adminToken, { voiceNotes });
      log(`  Final batch: ${result.voiceImported} imported`);
    } catch (err) {
      log(`  ERROR sending final batch: ${err.message}`);
    }
  }

  saveAudioDone(doneSet);
  log(`Audio sync complete! ${transcribed} transcribed, ${failed} failed.`);
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

  // Get admin token
  let adminToken = await ask("ADMIN_TOKEN from Railway env vars: ");

  // Generate or get sync key
  const syncKey = crypto.randomBytes(32).toString("hex");
  console.log("\nGenerated sync key (set this as IMESSAGE_SYNC_KEY env var on Railway):");
  console.log(`\n  ${syncKey}\n`);

  // Save config
  const config = { apiUrl, syncKey, adminToken };
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
} else if (arg === "--audio") {
  // Audio-only sync with optional max duration in seconds (default: 6 hours)
  const maxSec = parseInt(process.argv[3]) || 21600;
  syncAudio(maxSec).catch(err => { log("Audio sync failed: " + err.message); process.exit(1); });
} else {
  sync().catch(err => { log("Sync failed: " + err.message); process.exit(1); });
}
