import Anthropic from "@anthropic-ai/sdk";
import { FriendsStore } from "./store";
import { config } from "../../config";

const TAG_PROMPT = `Analyze these messages from a WhatsApp contact and extract relevant topic tags that describe what this person talks about, their interests, and conversation themes.

Return ONLY a JSON array of lowercase tag strings (3-15 tags). Examples: ["music", "tech", "travel", "crypto", "fitness", "philosophy", "food", "art", "politics", "startups", "meditation", "parenting"]

Focus on recurring themes, not one-off mentions. Keep tags concise (1-2 words each).

Messages:
`;

/**
 * Run tag extraction for contacts that have enough buffered messages.
 * Uses Claude Haiku for cost efficiency.
 * Returns the number of contacts processed.
 */
export async function runTagExtraction(store: FriendsStore): Promise<number> {
  if (!config.anthropicApiKey) {
    console.log("[tagger] No ANTHROPIC_API_KEY, skipping tag extraction.");
    return 0;
  }

  const readyContacts = store.getTagBufferContacts(20);
  if (readyContacts.length === 0) return 0;

  console.log(`[tagger] ${readyContacts.length} contact(s) ready for tag extraction.`);
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  let processed = 0;
  for (const { contact_id, message_count } of readyContacts) {
    try {
      const messages = store.getTagBufferMessages(contact_id);
      const messageText = messages
        .map(m => m.message_body)
        .join("\n")
        .slice(0, 8000); // Cap to avoid token limits

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [{ role: "user", content: TAG_PROMPT + messageText }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const tags: string[] = JSON.parse(match[0]);
        const latestTs = messages[messages.length - 1]?.timestamp || Math.floor(Date.now() / 1000);
        for (const tag of tags) {
          if (typeof tag === "string" && tag.trim().length > 0) {
            store.addContactTag(contact_id, tag.trim(), latestTs);
          }
        }
        console.log(`[tagger] ${contact_id}: extracted ${tags.length} tags from ${message_count} messages`);
      }

      // Clear buffer (bodies permanently deleted after extraction)
      store.clearTagBufferForContact(contact_id);
      processed++;
    } catch (err: any) {
      console.error(`[tagger] Failed for ${contact_id}:`, err?.message || err);
    }
  }

  return processed;
}
