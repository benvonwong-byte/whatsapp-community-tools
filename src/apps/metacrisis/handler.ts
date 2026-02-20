import { Message } from "../../whatsapp";
import { MetacrisisStore } from "./store";
import { config } from "../../config";
import { scrapeLinksMeta } from "./summarizer";

/** URL regex to extract links from message body */
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

/** Override map for sender IDs that fail contact lookup (raw @lid IDs → display name) */
const SENDER_NAME_OVERRIDES: Record<string, string> = {
  "116084476788850:76@lid": "Benjamin Von Wong",
};

/** Categorize a URL based on its domain */
export function categorizeUrl(url: string): string {
  const lower = url.toLowerCase();

  // Event platforms
  if (
    lower.includes("eventbrite.com") ||
    lower.includes("lu.ma") ||
    lower.includes("partiful.com")
  ) {
    return "event";
  }

  // Video platforms
  if (
    lower.includes("youtube.com") ||
    lower.includes("youtu.be") ||
    lower.includes("vimeo.com")
  ) {
    return "video";
  }

  // Podcast platforms
  if (
    lower.includes("spotify.com") ||
    lower.includes("podcasts.apple.com") ||
    lower.includes("open.spotify.com")
  ) {
    return "podcast";
  }

  // Article platforms
  if (lower.includes("medium.com") || lower.includes("substack.com")) {
    return "article";
  }

  // Common article URL patterns (paths ending in slug-like segments)
  if (/\/\d{4}\/\d{2}\//.test(lower) || /\/blog\//.test(lower) || /\/article/.test(lower) || /\/post\//.test(lower)) {
    return "article";
  }

  return "other";
}

export interface MetacrisisHandlerDiagnostics {
  lastCaptureTs: number;
  captureCount: number;
  chatNameTarget: string;
  lastSeenGroup: string | null;
}

/**
 * Create a raw message listener for the Metacrisis app.
 * Captures text messages from the Metacrisis Community Chat group,
 * extracts and categorizes URLs found in messages.
 */
export function createMetacrisisHandler(store: MetacrisisStore) {
  const chatNameLower = config.metacrisisChatName.toLowerCase();

  // Diagnostics
  let lastCaptureTs = 0;
  let captureCount = 0;
  let lastSeenGroup: string | null = null;

  const handler = async (msg: Message, chat: any) => {
    // Log all group messages for diagnostics
    if (chat.isGroup) {
      lastSeenGroup = chat.name;
      if (chat.name.toLowerCase().includes(chatNameLower)) {
        console.log(`[metacrisis] SAW: type=${msg.type} hasBody=${!!msg.body} from=${msg.author || msg.from}`);
      }
    }

    // Only process group chats
    if (!chat.isGroup) return;

    // Only process the specific Metacrisis group
    if (!chat.name.toLowerCase().includes(chatNameLower)) return;

    // Skip duplicates
    if (store.isDuplicate(msg.id._serialized)) return;

    // Only process text messages with content
    if (!msg.body || msg.body.trim() === "") return;

    // Get sender info (check override map first for known @lid IDs)
    const rawSender = msg.author || msg.from;
    const contact = await msg.getContact();
    const senderName = SENDER_NAME_OVERRIDES[rawSender] || contact?.pushname || contact?.name || msg.author || "";

    // Save the message
    store.saveMessage({
      id: msg.id._serialized,
      sender: msg.author || msg.from,
      sender_name: senderName,
      body: msg.body,
      timestamp: msg.timestamp,
    });

    lastCaptureTs = Date.now();
    captureCount++;

    console.log(
      `[metacrisis] Captured #${captureCount}: ${senderName}: ${msg.body.slice(0, 80)}...`
    );

    // Extract and save URLs, then scrape in background
    const urls = msg.body.match(URL_REGEX);
    if (urls) {
      for (const url of urls) {
        const category = categorizeUrl(url);
        store.saveLink({
          url,
          category,
          sender_name: senderName,
          message_id: msg.id._serialized,
          timestamp: msg.timestamp,
        });
        console.log(`[metacrisis] Link saved [${category}]: ${url}`);
      }
      // Scrape newly saved links in background (don't block message processing)
      scrapeLinksMeta(store).catch((err) =>
        console.error(`[metacrisis] Background scrape failed:`, err?.message || err)
      );
    }
  };

  (handler as any).getDiagnostics = (): MetacrisisHandlerDiagnostics => ({
    lastCaptureTs,
    captureCount,
    chatNameTarget: config.metacrisisChatName,
    lastSeenGroup,
  });

  return handler;
}
