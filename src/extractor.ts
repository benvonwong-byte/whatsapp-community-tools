import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { categories, getCategorySummary } from "./categories";
import { BufferedMessage } from "./whatsapp";

export interface ExtractedEvent {
  name: string;
  date: string; // ISO date: YYYY-MM-DD
  startTime: string | null; // HH:MM in 24h format
  endTime: string | null;
  endDate: string | null; // For multi-day events: YYYY-MM-DD
  location: string | null;
  description: string;
  url: string | null;
  category: string; // category id from categories.ts
  sourceMessageId: string;
  sourceChatName: string;
  sourceText: string; // raw message text that triggered this event
}

const client = new Anthropic({ apiKey: config.anthropicApiKey });

function buildPrompt(messages: BufferedMessage[]): string {
  const today = new Date().toISOString().split("T")[0];

  const messageBlock = messages
    .map(
      (m) =>
        `[${new Date(m.timestamp * 1000).toISOString()}] (Group: ${m.chatName}) ${m.body}`
    )
    .join("\n---\n");

  return `You are an event extraction assistant. Analyze the following WhatsApp group chat messages and extract any NYC-based events mentioned.

Today's date is ${today}.

CATEGORIES (use the id field):
${getCategorySummary()}

RULES:
1. Only extract events that have a specific date/time or are clearly upcoming.
2. LOCATION FILTER: Only include events that are EITHER:
   a. Physically located in or around the NYC metro area (Manhattan, Brooklyn, Queens, Bronx, Staten Island, nearby NJ/CT), OR
   b. Online/virtual events (Zoom, Google Meet, livestream, webinar, etc.)
   SKIP any physical events located outside the NYC area (e.g. events in LA, San Francisco, Chicago, Austin, etc.)
3. For online/virtual events (Zoom links, webinars, livestreams), use the "online" category regardless of topic. Set location to "Online" or include the platform (e.g. "Zoom", "Google Meet").
4. FILTER OUT events that are purely: nightlife, parties, club nights, concerts, entertainment, hedonistic gatherings, or anything without a learning/growth/community purpose.
5. For relative dates like "this Saturday" or "next Friday", resolve them to actual dates based on today (${today}).
6. If a message contains a link to an event page, include it in the url field.
7. Some messages include "[Event page content from <url>]:" followed by fetched page text from Eventbrite, Luma, or Partiful. Use this page content as the PRIMARY source for event name, date, time, location, and description. The NYC location filter still applies — skip if the event is not in the NYC metro area.
8. If you cannot determine a specific time, set startTime and endTime to null.
9. For multi-day events, set endDate to the last day.
10. Write a brief description summarizing what the event is about.

MESSAGES:
${messageBlock}

Respond with ONLY a JSON array of extracted events. If no events are found, respond with an empty array [].
Each event object must have exactly these fields:
{
  "name": "Event Name",
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM" or null,
  "endTime": "HH:MM" or null,
  "endDate": "YYYY-MM-DD" or null,
  "location": "Venue name, address" or null,
  "description": "Brief description",
  "url": "https://..." or null,
  "category": "category_id"
}

Valid category IDs: ${categories.map((c) => c.id).join(", ")}

JSON array:`;
}

export async function extractEvents(
  messages: BufferedMessage[]
): Promise<ExtractedEvent[]> {
  if (messages.length === 0) return [];

  const prompt = buildPrompt(messages);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Extract JSON from the response (handle markdown code blocks)
    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) {
      console.warn("[extractor] LLM returned non-array response, skipping");
      return [];
    }

    // Attach source info from the first message in the batch
    // (events may span multiple messages, but we need a reference)
    const sourceText = messages.map((m) => m.body).join("\n---\n");
    const events: ExtractedEvent[] = parsed.map((event: any) => ({
      name: event.name || "Untitled Event",
      date: event.date,
      startTime: event.startTime || null,
      endTime: event.endTime || null,
      endDate: event.endDate || null,
      location: event.location || null,
      description: event.description || "",
      url: event.url || null,
      category: event.category || "learning",
      sourceMessageId: messages[0].id,
      sourceChatName: messages[0].chatName,
      sourceText,
    }));

    // Validate categories
    const validIds = new Set(categories.map((c) => c.id));
    for (const event of events) {
      if (!validIds.has(event.category)) {
        event.category = "learning"; // fallback
      }
    }

    return events;
  } catch (err) {
    console.error("[extractor] Error calling Claude API:", err);
    throw err; // Re-throw so callers know extraction failed (vs. legitimately 0 events)
  }
}
