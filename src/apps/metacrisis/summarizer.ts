import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config";
import { MetacrisisStore, MetacrisisMessage, MetacrisisEvent } from "./store";
import { fetchPageText } from "../../verifier";

let geminiModel: any = null;
function getModel() {
  if (!geminiModel) {
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  }
  return geminiModel;
}

// ── Helpers ──

function formatMessages(messages: MetacrisisMessage[]): string {
  return messages
    .map((m) => {
      const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
      const sender = m.sender_name || "Unknown";
      return `[${time}] ${sender}: ${m.body}`;
    })
    .join("\n");
}

function getYesterdayDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function getDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

function parseGeminiJson(text: string): any {
  let jsonStr = text.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
  }
  return JSON.parse(jsonStr);
}

function formatEventsForPrompt(events: MetacrisisEvent[]): string {
  if (events.length === 0) return "No upcoming events tracked.";
  return events.map((e) => {
    let line = `- ${e.name || "Untitled Event"}`;
    if (e.date) line += ` | Date: ${e.date}`;
    if (e.start_time) line += ` at ${e.start_time}`;
    if (e.location) line += ` | Location: ${e.location}`;
    if (e.url) line += ` | ${e.url}`;
    return line;
  }).join("\n");
}

// ── Daily Digest (9AM, dashboard-only) ──

function buildDailyDigestPrompt(conversation: string, count: number, date: string): string {
  return `You are a community intelligence analyst for the Metacrisis Community Chat — a WhatsApp group focused on existential risks, systems thinking, coordination failures, and civilizational resilience.

DATE: ${date}
MESSAGES: ${count}

CONVERSATION:
${conversation}

Produce a daily digest for the group admin. Include:

1. **Who Said What**: For each active participant, a 1-2 sentence summary of their contributions.
2. **General Reaction**: The overall mood/sentiment of the room. Were people excited, skeptical, debating, aligned?
3. **Recommendations**: If the admin needs to respond to anything, flag it. E.g. "John asked a direct question that nobody answered" or "There's a heated debate about X that could use moderation." If nothing needs attention, say so.
4. **Key Topics**: List the main topics discussed with approximate mention count and sentiment.

Respond with ONLY a JSON object (no markdown code fences):
{
  "whoSaidWhat": [{ "sender": "Name", "summary": "What they contributed" }],
  "generalReaction": "Overall mood description",
  "recommendations": ["actionable item 1"],
  "keyTopics": [{ "topic": "topic name", "count": 3, "sentiment": "positive" }],
  "summary": "2-3 paragraph narrative summary of the day's discussion"
}

JSON:`;
}

export async function runDailyDigest(store: MetacrisisStore): Promise<void> {
  const yesterday = getYesterdayDate();
  const messages = store.getMessagesByDate(yesterday);

  if (messages.length === 0) {
    console.log(`[metacrisis-daily] No messages for ${yesterday} to digest.`);
    return;
  }

  const conversation = formatMessages(messages);
  const truncated = conversation.slice(0, 15000);

  console.log(`[metacrisis-daily] Digesting ${messages.length} messages for ${yesterday}...`);

  try {
    const model = getModel();
    const result = await model.generateContent(buildDailyDigestPrompt(truncated, messages.length, yesterday));
    const text = result.response.text();
    const parsed = parseGeminiJson(text);

    const topics = parsed.keyTopics || [];
    const topicNames = topics.map((t: any) => t.topic || t);

    store.saveSummary(
      yesterday,
      "daily",
      parsed.summary || "",
      JSON.stringify(topicNames),
      JSON.stringify(parsed.recommendations || []),
      JSON.stringify(parsed.whoSaidWhat || []),
      messages.length
    );

    // Save topics for trend tracking
    if (topics.length > 0) {
      store.saveTopics(yesterday, topics.map((t: any) => ({
        topic: (t.topic || t).toLowerCase(),
        count: t.count || 1,
        sentiment: t.sentiment || "neutral",
      })));
    }

    console.log(`[metacrisis-daily] Digest complete for ${yesterday}. Topics: ${topicNames.join(", ")}`);
  } catch (err: any) {
    console.error(`[metacrisis-daily] Failed:`, err?.message || err);
  }
}

// ── Weekly Summary (pushed to WhatsApp) ──

function buildWeeklySummaryPrompt(conversation: string, count: number, dateRange: string, eventsBlock: string): string {
  return `You are a community summarizer for the Metacrisis Community Chat — a WhatsApp group focused on existential risks, systems thinking, coordination failures, and civilizational resilience.

WEEK: ${dateRange}
MESSAGES: ${count}

CONVERSATION:
${conversation}

KNOWN UPCOMING EVENTS:
${eventsBlock}

Produce a WhatsApp-ready weekly summary with exactly these sections:

1. **Topics Discussed**: A concise paragraph (3-5 sentences) covering the main themes and discussions this week.
2. **One Notable Thing Said**: Pick the single most interesting, provocative, or insightful quote from the conversation. Include the speaker's name and the exact quote.
3. **Upcoming Events Next Week**: List each event with name, date, time, and place. If event info is missing, say "Details TBA".

Respond with ONLY a JSON object (no markdown code fences):
{
  "topicsDiscussed": "paragraph text",
  "notableQuote": { "sender": "Name", "quote": "exact words" },
  "upcomingEvents": [{ "name": "Event Name", "date": "YYYY-MM-DD", "time": "HH:MM", "place": "Location", "url": "https://..." }],
  "keyTopics": ["topic1", "topic2", "topic3"],
  "formattedWhatsApp": "The complete WhatsApp-ready message with *bold* formatting"
}

JSON:`;
}

export async function runWeeklySummary(store: MetacrisisStore): Promise<void> {
  const endDate = getTodayDate();
  const startDate = getDateNDaysAgo(7);
  const messages = store.getMessagesByDateRange(startDate, endDate);

  if (messages.length === 0) {
    console.log("[metacrisis-weekly] No messages this week to summarize.");
    return;
  }

  // Process unprocessed event links first
  await processEventLinks(store);

  // Auto-clean past events
  const cleaned = store.markPastEvents();
  if (cleaned > 0) {
    console.log(`[metacrisis-weekly] Marked ${cleaned} past events.`);
  }

  // Get upcoming events for the prompt
  const upcomingEvents = store.getUpcomingEvents();
  const eventsBlock = formatEventsForPrompt(upcomingEvents);

  const conversation = formatMessages(messages);
  const truncated = conversation.slice(0, 15000);
  const dateRange = `${startDate} to ${endDate}`;

  console.log(`[metacrisis-weekly] Summarizing ${messages.length} messages for week ${dateRange}...`);

  try {
    const model = getModel();
    const result = await model.generateContent(buildWeeklySummaryPrompt(truncated, messages.length, dateRange, eventsBlock));
    const text = result.response.text();
    const parsed = parseGeminiJson(text);

    // Build formatted WhatsApp message if Gemini didn't provide one
    const whatsAppMsg = parsed.formattedWhatsApp || buildDefaultWhatsAppMessage(parsed, dateRange);

    store.saveSummary(
      endDate,
      "weekly",
      whatsAppMsg,
      JSON.stringify(parsed.keyTopics || []),
      "[]",
      "[]",
      messages.length
    );

    // Mark messages as processed
    store.markProcessed(messages.map((m) => m.id));

    console.log(`[metacrisis-weekly] Weekly summary complete. Topics: ${(parsed.keyTopics || []).join(", ")}`);
  } catch (err: any) {
    console.error(`[metacrisis-weekly] Failed:`, err?.message || err);
  }
}

function buildDefaultWhatsAppMessage(parsed: any, dateRange: string): string {
  let msg = `*Metacrisis Community — Weekly Update*\n*${dateRange}*\n\n`;
  msg += `*Topics Discussed This Week*\n${parsed.topicsDiscussed || "No topics available."}\n\n`;

  if (parsed.notableQuote) {
    msg += `*Notable Quote*\n"${parsed.notableQuote.quote}" — ${parsed.notableQuote.sender}\n\n`;
  }

  msg += `*Upcoming Events*\n`;
  const events = parsed.upcomingEvents || [];
  if (events.length === 0) {
    msg += "No upcoming events this week.\n";
  } else {
    for (const evt of events) {
      msg += `- ${evt.name}`;
      if (evt.date) msg += ` — ${evt.date}`;
      if (evt.time) msg += ` at ${evt.time}`;
      if (evt.place) msg += ` | ${evt.place}`;
      msg += "\n";
      if (evt.url) msg += `  ${evt.url}\n`;
    }
  }

  return msg;
}

// ── Event Link Processor ──

async function extractEventDetails(url: string, pageText: string): Promise<{
  name: string; date: string | null; startTime: string | null;
  endTime: string | null; location: string; description: string;
}> {
  try {
    const model = getModel();
    const result = await model.generateContent(`Extract event details from this page content.
URL: ${url}
PAGE CONTENT:
${pageText.slice(0, 4000)}

Respond with ONLY a JSON object:
{"name":"Event Name","date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM","location":"Venue, City","description":"Brief 1-sentence description"}

Use null for any field you cannot determine. JSON:`);

    const text = result.response.text();
    return parseGeminiJson(text);
  } catch (err: any) {
    console.error(`[metacrisis-events] Failed to extract details from ${url}:`, err?.message || err);
    return { name: "", date: null, startTime: null, endTime: null, location: "", description: "" };
  }
}

export async function processEventLinks(store: MetacrisisStore): Promise<number> {
  const eventLinks = store.getLinksByCategory("event", 100);
  const unprocessed = eventLinks.filter((link) => !store.getEventByUrl(link.url));

  if (unprocessed.length === 0) return 0;

  console.log(`[metacrisis-events] Processing ${unprocessed.length} event URLs...`);
  let processed = 0;

  for (const link of unprocessed) {
    try {
      const pageText = await fetchPageText(link.url);
      if (!pageText) {
        // Save stub so we don't re-fetch
        store.saveEvent({
          url: link.url,
          name: "",
          date: null,
          start_time: null,
          end_time: null,
          location: "",
          description: "Could not fetch page",
          source_message_id: link.message_id,
          status: "pending",
        });
        continue;
      }

      const details = await extractEventDetails(link.url, pageText);
      store.saveEvent({
        url: link.url,
        name: details.name || "",
        date: details.date || null,
        start_time: details.startTime || null,
        end_time: details.endTime || null,
        location: details.location || "",
        description: details.description || "",
        source_message_id: link.message_id,
      });
      processed++;
      console.log(`[metacrisis-events] Processed: ${details.name || link.url} (${details.date || "no date"})`);
    } catch (err: any) {
      console.error(`[metacrisis-events] Error processing ${link.url}:`, err?.message || err);
    }
  }

  console.log(`[metacrisis-events] Processed ${processed}/${unprocessed.length} event URLs.`);
  return processed;
}

// ── Legacy export for backward compatibility ──

export function formatSummaryForWhatsApp(
  summary: string,
  topics: string[],
  date: string,
  template: string
): string {
  return template
    .replace("{{date}}", date)
    .replace("{{summary}}", summary)
    .replace("{{topics}}", topics.join(", "));
}
