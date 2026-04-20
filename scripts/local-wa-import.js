#!/usr/bin/env node
/**
 * local-wa-import.js
 *
 * Reads 1:1 messages from the local WhatsApp Mac app SQLite database
 * and imports them into the friends dashboard via the API.
 *
 * Usage:
 *   node scripts/local-wa-import.js                  # Import last 90 days
 *   node scripts/local-wa-import.js --days 180       # Import last 180 days
 *   node scripts/local-wa-import.js --dry-run        # Preview only, no writes
 *   node scripts/local-wa-import.js --url http://localhost:3000  # Custom server
 */

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");

// ── Config ──

const WA_DB_DEFAULT = path.join(
  os.homedir(),
  "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite"
);
const WA_DB_DROPBOX = path.join(__dirname, "../data/ChatStorage.sqlite");
const WA_DB = fs.existsSync(WA_DB_DEFAULT) ? WA_DB_DEFAULT : WA_DB_DROPBOX;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const DAYS = parseInt((args.find(a => a.startsWith("--days="))?.split("=")[1]) ||
  (args.includes("--days") ? args[args.indexOf("--days") + 1] : "90")) || 90;
const SERVER_URL = (args.find(a => a.startsWith("--url="))?.split("=")[1]) ||
  (args.includes("--url") ? args[args.indexOf("--url") + 1] : null) ||
  "https://whatsapp.vonwongdaily.com";
const BATCH_SIZE = 200;

// Load admin token from .env
function loadAdminToken() {
  const envPath = path.join(__dirname, "../.env");
  try {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^ADMIN_TOKEN=(.+)/);
      if (m) return m[1].trim();
    }
  } catch {}
  return process.env.ADMIN_TOKEN || "";
}

// ── Helpers ──

function queryRows(sql) {
  // Write SQL to a temp file to avoid shell escaping issues
  const tmpFile = path.join(os.tmpdir(), `wa-import-${Date.now()}.sql`);
  try {
    fs.writeFileSync(tmpFile, sql, "utf8");
    const result = execSync(`sqlite3 -separator '|' "${WA_DB}" < "${tmpFile}"`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (!result.trim()) return [];
    return result.trim().split("\n").map(line => line.split("|"));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Apple epoch offset: seconds between Unix epoch (1970) and Apple epoch (2001-01-01)
const APPLE_EPOCH_OFFSET = 978307200;

function appleToUnix(ts) {
  return Math.round(parseFloat(ts) + APPLE_EPOCH_OFFSET);
}

// Normalize JID: @s.whatsapp.net → @c.us (match whatsapp-web.js format)
function normalizeJid(jid) {
  if (!jid) return jid;
  return jid.replace(/@s\.whatsapp\.net$/, "@c.us").replace(/@lid$/, "@c.us");
}

// Fingerprint: sha256 of normalizedChatId + normalizedSenderId + rounded timestamp
// Round to 2s to handle minor clock differences between sources
function fingerprint(chatId, senderId, timestamp) {
  const rounded = Math.round(timestamp / 2) * 2;
  return crypto.createHash("sha256")
    .update(`${chatId}|${senderId}|${rounded}`)
    .digest("hex");
}

async function postBatch(url, token, messages) {
  const body = JSON.stringify({ messages });
  const resp = await fetch(`${url}/api/friends/local-import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body,
  });
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Server error: ${text.slice(0, 200)}`); }
}

// ── Main ──

async function main() {
  if (!fs.existsSync(WA_DB)) {
    console.error(`WhatsApp database not found at:\n  ${WA_DB}`);
    process.exit(1);
  }

  const adminToken = loadAdminToken();
  if (!adminToken && !DRY_RUN) {
    console.error("No ADMIN_TOKEN found in .env — cannot write to server.");
    process.exit(1);
  }

  const cutoffApple = (Math.floor(Date.now() / 1000) - DAYS * 86400) - APPLE_EPOCH_OFFSET;

  console.log(`\n=== WhatsApp Local Import ===`);
  console.log(`Mode:    ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`Window:  Last ${DAYS} days`);
  console.log(`Server:  ${SERVER_URL}`);
  console.log(`DB:      ${WA_DB}\n`);

  // Fetch all 1:1 messages in window
  console.log("Querying WhatsApp database...");
  const rows = queryRows(`
SELECT
  m.ZSTANZAID,
  m.ZISFROMME,
  m.ZFROMJID,
  m.ZTOJID,
  m.ZMESSAGETYPE,
  replace(replace(m.ZTEXT, char(10), ' '), '|', ''),
  m.ZMESSAGEDATE,
  s.ZCONTACTJID,
  s.ZPARTNERNAME
FROM ZWAMESSAGE m
JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
WHERE s.ZSESSIONTYPE = 0
  AND m.ZMESSAGEDATE > ${cutoffApple}
  AND m.ZTEXT IS NOT NULL
  AND m.ZTEXT != ''
ORDER BY m.ZMESSAGEDATE ASC;
  `);

  console.log(`Found ${rows.length} messages from last ${DAYS} days in ${rows.length > 0 ? "1:1" : "0"} chats.\n`);

  if (rows.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  // Build message objects
  const messages = [];
  for (const [stanzaId, isFromMe, fromJid, toJid, msgType, text, msgDateRaw, contactJid, partnerName] of rows) {
    if (!stanzaId || !msgDateRaw) continue;

    const timestamp = appleToUnix(msgDateRaw);
    const fromMe = isFromMe === "1";
    const chatId = normalizeJid(contactJid);
    const senderId = fromMe ? "self" : normalizeJid(fromJid || contactJid);
    const senderName = fromMe ? "Me" : (partnerName || "");

    // Generate a stable unique ID for this message
    const msgId = `local_${stanzaId}`;

    const fp = fingerprint(chatId, senderId, timestamp);

    const typeMap = { "0": "text", "1": "image", "2": "audio", "3": "video", "4": "vcard", "7": "url", "14": "text" };
    const messageType = typeMap[msgType] || "text";

    messages.push({
      id: msgId,
      chat_id: chatId,
      sender_id: senderId,
      sender_name: senderName,
      timestamp,
      is_from_me: fromMe,
      message_type: messageType,
      char_count: text.length,
      body: text,
      source: "whatsapp_local",
      local_fingerprint: fp,
    });
  }

  console.log(`Prepared ${messages.length} messages for import.`);

  if (DRY_RUN) {
    // Show sample
    const sample = messages.slice(0, 5);
    console.log("\nSample (first 5):");
    for (const m of sample) {
      console.log(`  [${new Date(m.timestamp * 1000).toISOString().slice(0, 10)}] ${m.sender_name || m.sender_id}: ${m.body.slice(0, 80)}`);
    }
    const chats = new Set(messages.map(m => m.chat_id));
    console.log(`\nWould import from ${chats.size} unique chats.`);
    console.log("Dry run complete — no data written.");
    return;
  }

  // Post in batches
  let totalInserted = 0;
  let totalSkipped = 0;
  const batches = Math.ceil(messages.length / BATCH_SIZE);

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`Batch ${batchNum}/${batches} (${batch.length} msgs)... `);
    try {
      const result = await postBatch(SERVER_URL, adminToken, batch);
      if (!result.ok) throw new Error(result.error || "Unknown error");
      totalInserted += result.inserted || 0;
      totalSkipped += result.skipped || 0;
      console.log(`✓ inserted: ${result.inserted}, skipped: ${result.skipped}`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Inserted: ${totalInserted}`);
  console.log(`Skipped (duplicates): ${totalSkipped}`);
  console.log(`Total processed: ${messages.length}`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
