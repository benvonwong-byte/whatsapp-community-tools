import { GoogleGenerativeAI } from "@google/generative-ai";
import { FriendsStore } from "./store";
import { config } from "../../config";

const TAG_PROMPT = `Analyze these WhatsApp messages from a contact and extract rich context tags across multiple categories.

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
        .slice(0, 8000); // Cap to avoid token limits

      const result = await model.generateContent(TAG_PROMPT + messageText);
      const text = result.response.text();
      const latestTs = messages[messages.length - 1]?.timestamp || Math.floor(Date.now() / 1000);

      // Try parsing as categorized JSON object first
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          const parsed = JSON.parse(objMatch[0]);
          let tagCount = 0;
          const categoryPrefixes: Record<string, string> = {
            topics: "",
            location: "loc:",
            context: "ctx:",
            tone: "tone:",
            emotion: "emo:",
          };
          for (const [category, prefix] of Object.entries(categoryPrefixes)) {
            const tags = parsed[category];
            if (Array.isArray(tags)) {
              for (const tag of tags) {
                if (typeof tag === "string" && tag.trim().length > 0) {
                  store.addContactTag(contact_id, prefix + tag.trim().toLowerCase(), latestTs);
                  tagCount++;
                }
              }
            }
          }
          console.log(`[tagger] ${contact_id}: extracted ${tagCount} categorized tags from ${message_count} messages`);
        } catch {
          // Fall back to array format
          const arrMatch = text.match(/\[[\s\S]*\]/);
          if (arrMatch) {
            const tags: string[] = JSON.parse(arrMatch[0]);
            for (const tag of tags) {
              if (typeof tag === "string" && tag.trim().length > 0) {
                store.addContactTag(contact_id, tag.trim(), latestTs);
              }
            }
            console.log(`[tagger] ${contact_id}: extracted ${tags.length} tags from ${message_count} messages`);
          }
        }
      } else {
        // Fall back to flat array
        const arrMatch = text.match(/\[[\s\S]*\]/);
        if (arrMatch) {
          const tags: string[] = JSON.parse(arrMatch[0]);
          for (const tag of tags) {
            if (typeof tag === "string" && tag.trim().length > 0) {
              store.addContactTag(contact_id, tag.trim(), latestTs);
            }
          }
          console.log(`[tagger] ${contact_id}: extracted ${tags.length} tags from ${message_count} messages`);
        }
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
