import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { categories, getCategorySummary } from "./categories";
import { BufferedMessage } from "./whatsapp";
import { fetchPageText } from "./verifier";

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

// ── Event link enrichment ──

const EVENT_LINK_PATTERN =
  /https?:\/\/(?:www\.)?(?:eventbrite\.com\/e\/|lu\.ma\/|partiful\.com\/e\/)\S+/gi;

/**
 * Scan messages for Eventbrite, Luma, and Partiful links, fetch their page
 * content, and append it to the message body so Claude can extract full event details.
 * Returns new message copies — originals are not mutated.
 */
export async function enrichWithEventLinks(
  messages: BufferedMessage[]
): Promise<BufferedMessage[]> {
  // Collect all unique event URLs across all messages
  const urlToMessages = new Map<string, number[]>(); // url → message indices
  for (let i = 0; i < messages.length; i++) {
    const matches = messages[i].body.match(EVENT_LINK_PATTERN);
    if (!matches) continue;
    for (const url of new Set(matches)) {
      if (!urlToMessages.has(url)) urlToMessages.set(url, []);
      urlToMessages.get(url)!.push(i);
    }
  }

  if (urlToMessages.size === 0) return messages;

  console.log(`[enrich] Found ${urlToMessages.size} event link(s) to fetch...`);

  // Fetch all URLs in parallel (max 5 concurrent)
  const urlContent = new Map<string, string>();
  const urls = [...urlToMessages.keys()];
  const concurrency = 5;
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const idx = cursor++;
      const url = urls[idx];
      const text = await fetchPageText(url);
      if (text) {
        urlContent.set(url, text);
        console.log(`[enrich] Fetched page content for ${url} (${text.length} chars)`);
      } else {
        console.log(`[enrich] No content from ${url}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, () => worker())
  );

  if (urlContent.size === 0) return messages;

  // Build enriched copies of messages
  const enriched = messages.map((m) => ({ ...m }));
  for (const [url, content] of urlContent) {
    for (const idx of urlToMessages.get(url)!) {
      enriched[idx].body += `\n\n[Event page content from ${url}]:\n${content}`;
    }
  }

  return enriched;
}
