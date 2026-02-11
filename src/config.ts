import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";

dotenv.config();

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  adminToken: process.env.ADMIN_TOKEN || crypto.randomBytes(32).toString("hex"),
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), "events.db"),
  authDir: process.env.AUTH_DIR || path.resolve(process.cwd(), ".auth"),
  port: parseInt(process.env.PORT || "3000", 10),
  // Batch messages every 5 minutes or 20 messages
  batchIntervalMs: 5 * 60 * 1000,
  batchMaxMessages: 20,
};

export function validateConfig() {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required. Set it in your .env file.");
  }
}
