import { Message } from "../../whatsapp";
import { MetacrisisStore } from "./store";
import { config } from "../../config";

/** URL regex to extract links from message body */
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

/** Categorize a URL based on its domain */
function categorizeUrl(url: string): string {
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

/**
 * Create a raw message listener for the Metacrisis app.
 * Captures text messages from the Metacrisis Community Chat group,
 * extracts and categorizes URLs found in messages.
 */
export function createMetacrisisHandler(store: MetacrisisStore) {
  const chatNameLower = config.metacrisisChatName.toLowerCase();

  return async (msg: Message, chat: any) => {
    // Only process group chats
    if (!chat.isGroup) return;

    // Only process the specific Metacrisis group
    if (!chat.name.toLowerCase().includes(chatNameLower)) return;

    // Skip duplicates
    if (store.isDuplicate(msg.id._serialized)) return;

    // Only process text messages with content
    if (!msg.body || msg.body.trim() === "") return;

    // Get sender info
    const contact = await msg.getContact();
    const senderName = contact?.pushname || contact?.name || msg.author || "";

    // Save the message
    store.saveMessage({
      id: msg.id._serialized,
      sender: msg.author || msg.from,
      sender_name: senderName,
      body: msg.body,
      timestamp: msg.timestamp,
    });

    console.log(
      `[metacrisis] Message from ${senderName}: ${msg.body.slice(0, 80)}...`
    );

    // Extract and save URLs
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
    }
  };
}
