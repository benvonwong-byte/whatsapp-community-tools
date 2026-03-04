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

export type LLMProviderName = "gemini" | "anthropic" | "openai" | "ollama";
export type TranscriptionProviderName = "assemblyai" | "groq";

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  ollamaModel: process.env.OLLAMA_MODEL || "llama3",
  ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
  llmProvider: (process.env.LLM_PROVIDER || "") as LLMProviderName | "",
  transcriptionProvider: (process.env.TRANSCRIPTION_PROVIDER || "") as TranscriptionProviderName | "",
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

/**
 * Auto-detect which LLM provider to use based on available API keys.
 *
 * Priority:
 *  1. Explicit `LLM_PROVIDER` env var
 *  2. If ANTHROPIC_API_KEY is set → "anthropic"
 *  3. If GEMINI_API_KEY is set   → "gemini"
 *  4. Fall back to "ollama" (local, no key needed)
 */
export function resolveProvider(): LLMProviderName {
  if (config.llmProvider) {
    return config.llmProvider as LLMProviderName;
  }
  if (config.anthropicApiKey) return "anthropic";
  if (config.geminiApiKey) return "gemini";
  if (config.openaiApiKey) return "openai";
  return "ollama";
}

export function validateConfig() {
  const provider = resolveProvider();

  switch (provider) {
    case "gemini":
      if (!config.geminiApiKey) {
        throw new Error(
          "GEMINI_API_KEY is required when using the Gemini provider. Set it in your .env file.",
        );
      }
      break;
    case "anthropic":
      if (!config.anthropicApiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY is required when using the Anthropic provider. Set it in your .env file.",
        );
      }
      break;
    case "openai":
      if (!config.openaiApiKey) {
        throw new Error(
          "OPENAI_API_KEY is required when using the OpenAI provider. Set it in your .env file or configure via /setup.",
        );
      }
      break;
    case "ollama":
      // No API key needed for Ollama — just needs a running server
      break;
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${provider}". Use "gemini", "anthropic", "openai", or "ollama".`,
      );
  }
}

/**
 * Apply LLM settings from the database to the runtime config object.
 * DB settings override env vars — call this before resolveProvider().
 */
export function applyDbSettings(dbConfig: {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}): void {
  const p = dbConfig.provider;

  switch (p) {
    case "anthropic":
      config.anthropicApiKey = dbConfig.apiKey;
      config.llmProvider = "anthropic";
      break;
    case "gemini":
      config.geminiApiKey = dbConfig.apiKey;
      config.llmProvider = "gemini";
      break;
    case "openai":
    case "xai":
    case "deepseek":
    case "groq-llm":
    case "together":
    case "mistral":
    case "openrouter":
    case "qwen":
      // All OpenAI-compatible providers route through the openai adapter
      config.openaiApiKey = dbConfig.apiKey;
      config.openaiBaseUrl = dbConfig.baseUrl || "";
      config.openaiModel = dbConfig.model || "gpt-4o-mini";
      config.llmProvider = "openai";
      break;
    case "ollama":
      config.ollamaModel = dbConfig.model || "llama3";
      if (dbConfig.baseUrl) config.ollamaUrl = dbConfig.baseUrl;
      config.llmProvider = "ollama";
      break;
  }
}
