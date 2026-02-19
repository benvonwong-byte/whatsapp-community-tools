import { GoogleGenerativeAI } from "@google/generative-ai";
import { FriendsStore } from "./store";
import { config } from "../../config";

const TAG_PROMPT = `Analyze these messages from a contact and extract rich context tags across multiple categories.

Return ONLY a JSON object with these category keys, each containing an array of lowercase tag strings:

{
  "topics": ["..."],      // What you talk about: interests, projects, subjects (3-8 tags)
  "location": ["..."],    // Places mentioned: cities, countries, neighborhoods (0-3 tags)
  "context": ["..."],     // How you know them: "work", "college friend", "met at conference", "mutual friend" (1-3 tags)
  "tone": ["..."],        // Conversation style: "deep talks", "casual banter", "advice seeker", "supportive", "intellectual", "humorous" (1-3 tags)
  "emotion": ["..."]      // Emotional quality: "warm", "energetic", "thoughtful", "inspiring", "vulnerable" (1-2 tags)
}

Focus on recurring patterns, not one-off mentions. Keep each tag 1-3 words. Be specific and insightful.

Messages:
`;

const CATEGORY_PREFIXES: Record<string, string> = {
  topics: "",
  location: "loc:",
  context: "ctx:",
  tone: "tone:",
  emotion: "emo:",
};

/** Parse Gemini response and save tags for a contact. Returns tag count. */
function saveTags(store: FriendsStore, contactId: string, text: string, timestamp: number): number {
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (!objMatch) return 0;

  try {
    const parsed = JSON.parse(objMatch[0]);
    let tagCount = 0;
    for (const [category, prefix] of Object.entries(CATEGORY_PREFIXES)) {
      const tags = parsed[category];
      if (Array.isArray(tags)) {
        for (const tag of tags) {
          if (typeof tag === "string" && tag.trim().length > 0) {
            store.addContactTag(contactId, prefix + tag.trim().toLowerCase(), timestamp);
            tagCount++;
          }
        }
      }
    }
    return tagCount;
  } catch {
    // Fall back to flat array
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        const tags: string[] = JSON.parse(arrMatch[0]);
        for (const tag of tags) {
          if (typeof tag === "string" && tag.trim().length > 0) {
            store.addContactTag(contactId, tag.trim(), timestamp);
          }
        }
        return tags.length;
      } catch { return 0; }
    }
    return 0;
  }
}

/**
 * Run tag extraction for contacts that have enough buffered messages.
 * Uses Gemini 2.5 Flash for cost efficiency.
 * Returns the number of contacts processed.
 */
export async function runTagExtraction(store: FriendsStore): Promise<number> {
  if (!config.geminiApiKey) {
    console.log("[tagger] No GEMINI_API_KEY, skipping tag extraction.");
    return 0;
  }

  const readyContacts = store.getTagBufferContacts(20);
  if (readyContacts.length === 0) return 0;

  console.log(`[tagger] ${readyContacts.length} contact(s) ready for tag extraction.`);
  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  let processed = 0;
  for (const { contact_id, message_count } of readyContacts) {
    try {
      const messages = store.getTagBufferMessages(contact_id);
      const messageText = messages
        .map(m => m.message_body)
        .join("\n")
        .slice(0, 8000);

      const result = await model.generateContent(TAG_PROMPT + messageText);
      const text = result.response.text();
      const latestTs = messages[messages.length - 1]?.timestamp || Math.floor(Date.now() / 1000);

      const tagCount = saveTags(store, contact_id, text, latestTs);
      console.log(`[tagger] ${contact_id}: extracted ${tagCount} tags from ${message_count} buffered messages`);

      store.clearTagBufferForContact(contact_id);
      processed++;
    } catch (err: any) {
      console.error(`[tagger] Failed for ${contact_id}:`, err?.message || err);
    }
  }

  return processed;
}

/**
 * Tag contacts by fetching messages directly from WhatsApp.
 * Skips contacts that already have tags. Targets contacts with the most messages first.
 * @param store - FriendsStore instance
 * @param getChats - function that returns WhatsApp chats (from whatsapp client)
 * @param limit - max contacts to tag per run (default 50)
 */
export async function runDirectTagExtraction(
  store: FriendsStore,
  getChats: () => Promise<any[]>,
  limit = 15
): Promise<number> {
  if (!config.geminiApiKey) {
    console.log("[direct-tagger] No GEMINI_API_KEY, skipping.");
    return 0;
  }

  // Find contacts without tags, sorted by most messages (most likely to have good data)
  const allContacts = store.getContactsWithStats();
  const untagged = allContacts
    .filter(c => !c.tag_names)
    .sort((a, b) => b.total_messages - a.total_messages)
    .slice(0, limit);

  if (untagged.length === 0) {
    console.log("[direct-tagger] All contacts already have tags.");
    return 0;
  }

  console.log(`[direct-tagger] ${untagged.length} untagged contact(s) to process (of ${allContacts.length} total).`);

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  let whatsappChats: any[] | null = null;
  try {
    whatsappChats = await getChats();
  } catch (err: any) {
    console.error("[direct-tagger] Failed to get WhatsApp chats, will use DB fallback:", err?.message || err);
    whatsappChats = [];
  }

  let processed = 0;
  for (const contact of untagged) {
    try {
      let textBodies: string[] = [];

      // Find the WhatsApp chat for this contact
      const chat = whatsappChats!.find((c: any) => c.id._serialized === contact.id);
      if (chat) {
        // Fetch recent messages from WhatsApp
        const messages = await chat.fetchMessages({ limit: 200 });
        textBodies = messages
          .filter((m: any) => !m.fromMe && m.body && m.body.trim().length > 3 && ((m as any).type === "chat" || !(m as any).type))
          .map((m: any) => m.body);
      }

      // Fallback: read messages from database (covers iMessage + WhatsApp contacts without live chat)
      if (textBodies.length < 5) {
        const dbMessages = store.getContactMessages(contact.id, 200, 0);
        const dbBodies = dbMessages
          .filter((m: any) => !m.is_from_me && m.body && m.body.trim().length > 3 && m.message_type === "chat")
          .map((m: any) => m.body);
        if (dbBodies.length > textBodies.length) textBodies = dbBodies;
      }

      if (textBodies.length < 5) {
        continue; // Not enough messages for meaningful tags
      }

      const messageText = textBodies.join("\n").slice(0, 8000);

      const result = await model.generateContent(TAG_PROMPT + messageText);
      const text = result.response.text();
      const timestamp = Math.floor(Date.now() / 1000);

      const tagCount = saveTags(store, contact.id, text, timestamp);
      if (tagCount > 0) {
        console.log(`[direct-tagger] ${contact.name}: ${tagCount} tags from ${textBodies.length} messages`);
        processed++;
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      console.error(`[direct-tagger] Failed for ${contact.name}:`, err?.message || err);
      // If we hit rate limits, back off
      if (err?.message?.includes("429") || err?.message?.includes("quota")) {
        console.log("[direct-tagger] Rate limited, waiting 10s...");
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }

  console.log(`[direct-tagger] Done! Tagged ${processed} of ${untagged.length} contacts.`);
  return processed;
}
