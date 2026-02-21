import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";

dotenv.config();

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  adminToken: process.env.ADMIN_TOKEN || crypto.randomBytes(32).toString("hex"),
  adminEmail: process.env.ADMIN_EMAIL || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  guestUsername: process.env.GUEST_USERNAME || "Hope",
  guestPassword: process.env.GUEST_PASSWORD || "",
  guestToken: process.env.GUEST_TOKEN || crypto.randomBytes(32).toString("hex"),
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), "events.db"),
  authDir: process.env.AUTH_DIR || path.resolve(process.cwd(), ".auth"),
  port: parseInt(process.env.PORT || "3000", 10),
  // Batch messages every 5 minutes or 20 messages
  batchIntervalMs: 5 * 60 * 1000,
  batchMaxMessages: 20,
  // Airtable sync (optional — leave empty to disable)
  airtableApiKey: process.env.AIRTABLE_API_KEY || "",
  airtableBaseId: process.env.AIRTABLE_BASE_ID || "",
  airtableTableId: process.env.AIRTABLE_TABLE_ID || "",
  // Relationship app (optional — leave empty to disable)
  groqApiKey: process.env.GROQ_API_KEY || "",
  assemblyAiApiKey: process.env.ASSEMBLYAI_API_KEY || "",
  relationshipChatName: process.env.RELATIONSHIP_CHAT_NAME || "Hope Endrenyi",
  // Metacrisis app (optional — leave empty to disable)
  metacrisisChatName: process.env.METACRISIS_CHAT_NAME || "Metacrisis - Community Chat",
  metacrisisAnnouncementChat: process.env.METACRISIS_ANNOUNCEMENT_CHAT || "Metacrisis NYC",
  // Daily analysis/summary hour (0-23, local time)
  analysisHour: parseInt(process.env.ANALYSIS_HOUR || "0", 10),
};

export function validateConfig() {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required. Set it in your .env file.");
  }
}
