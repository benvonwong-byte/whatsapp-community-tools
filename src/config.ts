import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";

dotenv.config();

// Parse a comma-separated env var into a lowercase string array
function parseList(val: string | undefined): string[] {
  if (!val) return [];
  return val.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Parse a JSON env var into a Record, returning fallback on parse error
function parseJsonRecord(val: string | undefined): Record<string, string> {
  if (!val) return {};
  try { return JSON.parse(val); } catch { return {}; }
}

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  adminToken: process.env.ADMIN_TOKEN || crypto.randomBytes(32).toString("hex"),
  adminEmail: process.env.ADMIN_EMAIL || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  guestUsername: process.env.GUEST_USERNAME || "Guest",
  guestPassword: process.env.GUEST_PASSWORD || "",
  guestToken: process.env.GUEST_TOKEN || crypto.randomBytes(32).toString("hex"),
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), "events.db"),
  authDir: process.env.AUTH_DIR || path.resolve(process.cwd(), ".auth"),
  port: parseInt(process.env.PORT || "3000", 10),
  // Batch messages every 5 minutes or 20 messages
  batchIntervalMs: 5 * 60 * 1000,
  batchMaxMessages: 20,
  // Private chats to monitor for events (comma-separated names, case-insensitive)
  allowedPrivateChats: parseList(process.env.ALLOWED_PRIVATE_CHATS),
  // Airtable sync (optional — leave empty to disable)
  airtableApiKey: process.env.AIRTABLE_API_KEY || "",
  airtableBaseId: process.env.AIRTABLE_BASE_ID || "",
  airtableTableId: process.env.AIRTABLE_TABLE_ID || "",
  // Relationship app (optional — leave empty to disable)
  groqApiKey: process.env.GROQ_API_KEY || "",
  assemblyAiApiKey: process.env.ASSEMBLYAI_API_KEY || "",
  relationshipChatName: process.env.RELATIONSHIP_CHAT_NAME || "",
  relationshipPartnerName: process.env.RELATIONSHIP_PARTNER_NAME || "Partner",
  relationshipSelfName: process.env.RELATIONSHIP_SELF_NAME || "Me",
  // Metacrisis app (optional — leave empty to disable)
  metacrisisChatName: process.env.METACRISIS_CHAT_NAME || "",
  metacrisisAnnouncementChat: process.env.METACRISIS_ANNOUNCEMENT_CHAT || "",
  metacrisisAdjacentEventsChat: process.env.METACRISIS_ADJACENT_EVENTS_CHAT || "",
  // WhatsApp ID → display name overrides (JSON string in env)
  senderNameOverrides: parseJsonRecord(process.env.SENDER_NAME_OVERRIDES),
  // Daily analysis/summary hour (0-23, local time)
  analysisHour: parseInt(process.env.ANALYSIS_HOUR || "0", 10),
};

export function validateConfig() {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required. Set it in your .env file.");
  }
}
