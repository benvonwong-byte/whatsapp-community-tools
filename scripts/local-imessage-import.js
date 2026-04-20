#!/usr/bin/env node
/**
 * local-imessage-import.js
 *
 * Reads 1:1 iMessages from the local macOS chat.db and imports them
 * into the friends dashboard via the existing /api/friends/imessage/sync endpoint.
 * Safe to re-run — guids are deduplicated server-side.
 *
 * Usage:
 *   node scripts/local-imessage-import.js                  # Import last 90 days
 *   node scripts/local-imessage-import.js --days 180       # Import last 180 days
 *   node scripts/local-imessage-import.js --dry-run        # Preview only, no writes
 *   node scripts/local-imessage-import.js --url http://localhost:3000
 */

const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

// ── Config ──

const CHAT_DB_DEFAULT = path.join(os.homedir(), "Library/Messages/chat.db");
const CHAT_DB_DROPBOX = path.join(__dirname, "../data/chat.db");
const CHAT_DB = fs.existsSync(CHAT_DB_DEFAULT) ? CHAT_DB_DEFAULT : CHAT_DB_DROPBOX;

const AB_DIR_DEFAULT = path.join(os.homedir(), "Library/Application Support/AddressBook/Sources");
const AB_DIR_DROPBOX = path.join(__dirname, "../data/AddressBook/Sources");
const AB_DIR = fs.existsSync(AB_DIR_DEFAULT) ? AB_DIR_DEFAULT : AB_DIR_DROPBOX;
const APPLE_EPOCH_OFFSET = 978307200;
const BATCH_SIZE = 200;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const DAYS = parseInt(
  (args.find(a => a.startsWith("--days="))?.split("=")[1]) ||
  (args.includes("--days") ? args[args.indexOf("--days") + 1] : "90")
) || 90;
const SERVER_URL =
  (args.find(a => a.startsWith("--url="))?.split("=")[1]) ||
  (args.includes("--url") ? args[args.indexOf("--url") + 1] : null) ||
  "https://whatsapp.vonwongdaily.com";

function loadCredentials() {
  const envPath = path.join(__dirname, "../.env");
  let adminToken = process.env.ADMIN_TOKEN || "";
  let syncKey = process.env.IMESSAGE_SYNC_KEY || "";
  try {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const [k, v] = line.split("=");
      if (k?.trim() === "ADMIN_TOKEN" && v) adminToken = v.trim();
      if (k?.trim() === "IMESSAGE_SYNC_KEY" && v) syncKey = v.trim();
    }
  } catch {}
  return { adminToken, syncKey };
}

// ── Helpers ──

function queryDb(sql) {
  const result = spawnSync("sqlite3", ["-json", "-readonly", CHAT_DB, sql], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const err = (result.stderr || "").trim();
    if (err.includes("authorization denied") || err.includes("unable to open")) {
      console.error("Cannot read chat.db — grant Full Disk Access to Terminal in System Settings > Privacy & Security.");
      process.exit(1);
    }
    throw new Error(`sqlite3 error: ${err}`);
  }
  const out = (result.stdout || "").trim();
  return out ? JSON.parse(out) : [];
}

function normalizePhone(id) {
  return (id || "").replace(/\D/g, "");
}

function loadContactNames() {
  const phoneToName = {};
  try {
    const sources = fs.readdirSync(AB_DIR);
    for (const src of sources) {
      const dbPath = path.join(AB_DIR, src, "AddressBook-v22.abcddb");
      if (!fs.existsSync(dbPath)) continue;
      const result = spawnSync("sqlite3", ["-json", "-readonly", dbPath,
        "SELECT c.ZFIRSTNAME, c.ZLASTNAME, p.ZFULLNUMBER FROM ZABCDRECORD c JOIN ZABCDPHONENUMBER p ON p.ZOWNER = c.Z_PK WHERE c.ZFIRSTNAME IS NOT NULL"
      ], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      if (result.stdout?.trim()) {
        for (const r of JSON.parse(result.stdout.trim())) {
          const name = [r.ZFIRSTNAME, r.ZLASTNAME].filter(Boolean).join(" ").trim();
          const phone = normalizePhone(r.ZFULLNUMBER || "");
          if (name && phone.length >= 7) phoneToName[phone] = name;
        }
      }
    }
  } catch {}
  return phoneToName;
}

// Apple nanoseconds → Unix seconds
function appleNsToUnix(appleDate) {
  const n = parseInt(appleDate) || 0;
  if (n > 1e15) return Math.floor(n / 1e9) + APPLE_EPOCH_OFFSET;
  if (n > 1e9)  return Math.floor(n / 1e6) + APPLE_EPOCH_OFFSET;
  return n + APPLE_EPOCH_OFFSET;
}

// Extract plain text from NSAttributedString blob
function extractAttributedText(hexStr) {
  if (!hexStr) return "";
  const buf = Buffer.from(hexStr, "hex");
  const marker = Buffer.from([0x01, 0x2B]);
  const idx = buf.indexOf(marker);
  if (idx < 0) return "";
  let start = idx + 2;
  let length = buf[start];
  if (length === 0x81) { length = buf[start + 1]; start += 2; }
  else if (length === 0x82) { length = (buf[start + 1] << 8) | buf[start + 2]; start += 3; }
  else if (length === 0x83) { length = (buf[start + 1] << 16) | (buf[start + 2] << 8) | buf[start + 3]; start += 4; }
  else { start += 1; }
  if (start + length > buf.length) return "";
  return buf.subarray(start, start + length).toString("utf-8").replace(/\uFFFC/g, "").trim();
}

async function postBatch(syncKey, adminToken, messages) {
  const resp = await fetch(`${SERVER_URL}/api/friends/imessage/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sync-key": syncKey,
      "Authorization": `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ messages }),
  });
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Server error (${resp.status}): ${text.slice(0, 200)}`); }
}

// ── Main ──

async function main() {
  if (!fs.existsSync(CHAT_DB)) {
    console.error(`chat.db not found at:\n  ${CHAT_DB}`);
    process.exit(1);
  }

  const { adminToken, syncKey } = loadCredentials();
  if (!syncKey && !DRY_RUN) {
    console.error("No IMESSAGE_SYNC_KEY found in .env");
    process.exit(1);
  }

  const cutoffUnix = Math.floor(Date.now() / 1000) - DAYS * 86400;
  // Convert to Apple nanoseconds
  const cutoffAppleNs = (cutoffUnix - APPLE_EPOCH_OFFSET) * 1e9;

  console.log(`\n=== iMessage Local Import ===`);
  console.log(`Mode:    ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`Window:  Last ${DAYS} days`);
  console.log(`Server:  ${SERVER_URL}\n`);

  console.log("Loading contact names from macOS Contacts...");
  const contactNames = loadContactNames();
  console.log(`Loaded ${Object.keys(contactNames).length} contact names.\n`);

  console.log("Querying iMessage database...");
  const rows = queryDb(`
    SELECT
      m.guid,
      m.text,
      hex(m.attributedBody) as attributed_hex,
      m.date as apple_date,
      m.is_from_me,
      m.service,
      h.id as handle_id
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.associated_message_type = 0
      AND (m.cache_roomnames IS NULL OR m.cache_roomnames = '')
      AND (m.text IS NOT NULL AND m.text != '' OR m.attributedBody IS NOT NULL)
      AND m.date > ${cutoffAppleNs}
    ORDER BY m.date ASC
  `);

  console.log(`Found ${rows.length} raw messages, filtering...\n`);

  const messages = [];
  for (const row of rows) {
    const phone = normalizePhone(row.handle_id || "");
    if (!phone || phone.length < 7) continue; // Skip email handles

    const timestamp = appleNsToUnix(row.apple_date);
    const body = (row.text?.trim()) || extractAttributedText(row.attributed_hex);
    if (!body) continue;

    const senderName = contactNames[phone] || "";

    messages.push({
      guid: row.guid,
      phone,
      sender_name: senderName,
      text: body,
      timestamp,
      is_from_me: row.is_from_me === "1" || row.is_from_me === 1,
    });
  }

  console.log(`Prepared ${messages.length} messages for import.`);

  if (DRY_RUN) {
    const sample = messages.slice(0, 5);
    console.log("\nSample (first 5):");
    for (const m of sample) {
      const who = m.is_from_me ? "Me" : (m.sender_name || `+${m.phone}`);
      console.log(`  [${new Date(m.timestamp * 1000).toISOString().slice(0, 10)}] ${who}: ${m.text.slice(0, 80)}`);
    }
    const phones = new Set(messages.map(m => m.phone));
    console.log(`\nWould import from ${phones.size} unique contacts.`);
    console.log("Dry run complete — no data written.");
    return;
  }

  let totalImported = 0;
  let totalSkipped = 0;
  const batches = Math.ceil(messages.length / BATCH_SIZE);

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`Batch ${batchNum}/${batches} (${batch.length} msgs)... `);
    try {
      const result = await postBatch(syncKey, adminToken, batch);
      totalImported += result.imported || 0;
      totalSkipped += result.updated || result.skipped || 0;
      console.log(`✓ imported: ${result.imported}, skipped: ${result.updated ?? result.skipped ?? 0}`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Imported: ${totalImported}`);
  console.log(`Skipped (duplicates): ${totalSkipped}`);
  console.log(`Total processed: ${messages.length}`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
