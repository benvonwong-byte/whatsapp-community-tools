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
        timeZone: "America/New_York",
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

async function extractEventDetails(url: string, pageText: string, html?: string): Promise<{
  name: string; date: string | null; startTime: string | null;
  endTime: string | null; location: string; description: string;
}> {
  try {
    const model = getModel();
    const today = new Date().toISOString().split("T")[0];

    // Use structured data if we have the full HTML
    let context = `PAGE TEXT:\n${pageText.slice(0, 6000)}`;
    if (html) {
      const jsonLd = extractJsonLd(html);
      const meta = extractAllMeta(html);
      const embedded = extractEmbeddedData(html);
      if (jsonLd) context = `JSON-LD:\n${jsonLd.slice(0, 4000)}\n\n${embedded ? `EMBEDDED DATA:\n${embedded}\n\n` : ""}META:\n${meta}\n\n${context}`;
    }

    const result = await model.generateContent(`Extract event details from this page. Today's date is ${today}.
URL: ${url}

${context}

Look carefully at structured data, meta tags, and page text. Resolve relative dates (e.g. "this Tuesday") using today=${today}.

Respond with ONLY a JSON object:
{"name":"Event Name","date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM","location":"Venue, City","description":"Brief 1-sentence description of what the event is about"}

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
      // Fetch full HTML for structured data extraction, plus plain text as fallback
      const html = await fetchRawHtml(link.url);
      const pageText = html ? htmlToPlainText(html) : await fetchPageText(link.url);
      if (!pageText && !html) {
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

      const details = await extractEventDetails(link.url, pageText || "", html || undefined);
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

/**
 * Scrape unscraped links: fetch page, AI-summarize in 2 sentences,
 * detect category (article/video/event), extract event dates.
 */
export async function scrapeLinksMeta(store: MetacrisisStore): Promise<number> {
  const unscraped = store.getUnscrapedLinks(30);
  if (unscraped.length === 0) return 0;

  console.log(`[metacrisis-scraper] Scraping ${unscraped.length} links...`);
  let scraped = 0;

  for (const link of unscraped) {
    try {
      // Try oEmbed first for supported platforms (YouTube, Vimeo) — fast & reliable
      const oembedData = await fetchOEmbed(link.url);
      let oembedParsed: any = null;
      if (oembedData) {
        try { oembedParsed = JSON.parse(oembedData); } catch {}
      }

      const html = await fetchRawHtml(link.url);
      if (!html && !oembedParsed) {
        store.updateLinkMeta(link.id, "(untitled)", "");
        continue;
      }

      // Title: prefer oEmbed title (most reliable for YouTube), then HTML extraction
      let title = (html ? extractTitle(html) : "(untitled)");
      if ((title === "(untitled)" || !title) && oembedParsed?.title) {
        title = oembedParsed.title;
      }

      // Build context for AI
      let pageContext = html ? buildPageContext(html, link.url) : "";
      if (oembedData) pageContext = `OEMBED DATA:\n${oembedData}\n\n---\n\n${pageContext}`;

      // Check if we have enough content to actually summarize
      const hasContent = pageContext.length > 100;
      if (!hasContent) {
        // No content at all — just save title, no fake summary
        store.updateLinkMeta(link.id, title, "");
        scraped++;
        console.log(`[metacrisis-scraper] Scraped (no content): ${title.slice(0, 50)} — ${link.url}`);
        continue;
      }

      // AI: summarize + classify + extract event date/location in one call
      let summary = "";
      let aiCategory: string | undefined;
      let eventDate: string | null = null;
      let eventLocation: string | null = null;
      try {
        const model = getModel();
        const today = new Date().toISOString().split("T")[0];
        const result = await model.generateContent(
          `You are summarizing a shared link for a community newsletter. Today's date is ${today}.

Read the page content carefully — look at structured data, meta tags, and page text to understand what this is about.

URL: ${link.url}
Title: ${title}
URL-based category hint: ${link.category}

${pageContext}

Respond with ONLY a JSON object (no markdown fences):
{
  "summary": "your summary here",
  "category": "article" or "video" or "event" or "podcast" or "other",
  "event_date": "YYYY-MM-DD" or null,
  "event_location": "venue or location name" or null
}

SUMMARY RULES:
- For EVENTS: Write exactly what the event is, when it happens, and where. Example: "Film screening of 'Buy Now' followed by discussion and item swap. Tue Feb 17, 6:30-10PM in Greenpoint, Brooklyn."
- For ARTICLES: Summarize the key argument or finding in 2 sentences. What will the reader learn?
- For VIDEOS: Describe what the video covers and why it's worth watching.
- For PODCASTS: Describe the episode topic and key guests/perspectives.
- NEVER write generic descriptions like "This page contains an event" or "This is an article about...". Be specific and informative.
- If the page content is mostly error messages, login walls, or technical junk with no real content, set summary to an empty string "". Do NOT describe the error page itself.
- Keep it to 2 concise sentences max.

CATEGORY & EVENT RULES:
- Set category based on actual content, not just URL.
- For events: extract the exact date (resolve relative dates like "this Tuesday" using today=${today}), start/end times, and location from the page content. Check structured data and meta tags first.

JSON:`
        );
        const text = result.response.text().trim();
        const parsed = parseGeminiJson(text);
        summary = (parsed.summary || "").slice(0, 400);
        if (parsed.category && ["article", "video", "event", "podcast", "other"].includes(parsed.category)) {
          aiCategory = parsed.category;
        }
        if (parsed.event_date && /^\d{4}-\d{2}-\d{2}/.test(parsed.event_date)) {
          eventDate = parsed.event_date.slice(0, 10);
        }
        eventLocation = parsed.event_location || null;
      } catch (aiErr: any) {
        summary = (html ? extractDescription(html) : "") || "";
        console.log(`[metacrisis-scraper] AI failed for ${link.url}, using meta description`);
      }

      store.updateLinkMeta(link.id, title, summary, eventDate, aiCategory, eventLocation);
      scraped++;
      const catLabel = aiCategory || link.category;
      console.log(`[metacrisis-scraper] Scraped [${catLabel}]: ${title.slice(0, 50)} — ${link.url}${eventDate ? ` (event: ${eventDate})` : ""}`);
    } catch (err: any) {
      console.error(`[metacrisis-scraper] Error scraping ${link.url}:`, err?.message || err);
      store.updateLinkMeta(link.id, "(error)", "");
    }
  }

  console.log(`[metacrisis-scraper] Scraped ${scraped}/${unscraped.length} links.`);
  return scraped;
}

/** Strip HTML tags to get plain text for AI summarization */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<(\/?(p|div|h[1-6]|li|tr|br)\b)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

/** Extract JSON-LD structured data from HTML */
function extractJsonLd(html: string): string {
  const blocks: string[] = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      blocks.push(JSON.stringify(parsed, null, 2));
    } catch { /* skip malformed JSON-LD */ }
  }
  return blocks.join("\n");
}

/** Extract __NEXT_DATA__ or similar embedded JSON from SPAs */
function extractEmbeddedData(html: string): string {
  // Next.js __NEXT_DATA__
  const nextMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      // Extract just the page props, which contain the actual content
      const props = data?.props?.pageProps;
      if (props) return JSON.stringify(props, null, 2).slice(0, 8000);
    } catch { /* skip */ }
  }
  return "";
}

/** Extract all OpenGraph and meta tags into a structured block */
function extractAllMeta(html: string): string {
  const lines: string[] = [];
  const metaRegex = /<meta[^>]*(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
  const metaRegex2 = /<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']([^"']+)["'][^>]*>/gi;

  let m;
  const seen = new Set<string>();
  while ((m = metaRegex.exec(html)) !== null) {
    const key = m[1].toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      lines.push(`${key}: ${decodeHtmlEntities(m[2])}`);
    }
  }
  while ((m = metaRegex2.exec(html)) !== null) {
    const key = m[2].toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      lines.push(`${key}: ${decodeHtmlEntities(m[1])}`);
    }
  }
  return lines.join("\n");
}

/** Fetch oEmbed metadata for supported platforms (YouTube, Vimeo, etc.) */
async function fetchOEmbed(url: string): Promise<string | null> {
  // Map domains to oEmbed endpoints
  let oembedUrl: string | null = null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace("www.", "");
    if (host === "youtube.com" || host === "youtu.be") {
      oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    } else if (host === "vimeo.com") {
      oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
    }
  } catch { return null; }

  if (!oembedUrl) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(oembedUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return JSON.stringify(data, null, 2);
  } catch { return null; }
}

/** Extract YouTube-specific data embedded in script variables */
function extractYouTubeData(html: string): string {
  const parts: string[] = [];

  // ytInitialPlayerResponse has video title, description, etc.
  const playerMatch = html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});\s*(?:var|<\/script)/);
  if (playerMatch) {
    try {
      const data = JSON.parse(playerMatch[1]);
      const details = data?.videoDetails;
      if (details) {
        parts.push(`Title: ${details.title || ""}`);
        parts.push(`Author: ${details.author || ""}`);
        parts.push(`Description: ${(details.shortDescription || "").slice(0, 2000)}`);
        parts.push(`Length: ${details.lengthSeconds ? Math.round(parseInt(details.lengthSeconds) / 60) + " min" : "unknown"}`);
        if (details.keywords?.length) parts.push(`Keywords: ${details.keywords.slice(0, 10).join(", ")}`);
      }
    } catch { /* skip */ }
  }

  return parts.length > 0 ? parts.join("\n") : "";
}

/** Build rich context from HTML for AI summarization */
function buildPageContext(html: string, url: string): string {
  const parts: string[] = [];

  // 1. Platform-specific extraction
  try {
    const host = new URL(url).hostname.replace("www.", "");
    if (host === "youtube.com" || host === "youtu.be") {
      const ytData = extractYouTubeData(html);
      if (ytData) parts.push(`VIDEO DATA:\n${ytData}`);
    }
  } catch { /* skip */ }

  // 2. Structured data (most reliable)
  const jsonLd = extractJsonLd(html);
  if (jsonLd) parts.push(`STRUCTURED DATA (JSON-LD):\n${jsonLd.slice(0, 4000)}`);

  // 3. Embedded SPA data
  const embedded = extractEmbeddedData(html);
  if (embedded) parts.push(`EMBEDDED PAGE DATA:\n${embedded}`);

  // 4. Meta tags
  const meta = extractAllMeta(html);
  if (meta) parts.push(`META TAGS:\n${meta}`);

  // 5. Plain text content (less for video platforms since it's mostly player junk)
  const isVideoSite = /youtube\.com|youtu\.be|vimeo\.com/i.test(url);
  if (!isVideoSite) {
    const plainText = htmlToPlainText(html).slice(0, 6000);
    parts.push(`PAGE TEXT:\n${plainText}`);
  }

  return parts.join("\n\n---\n\n");
}

/** Check if a hostname resolves to a private/internal IP */
function isPrivateOrReserved(hostname: string): boolean {
  // Block obvious hostnames
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;

  // Check if it's a raw IP address
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b, c, d] = ipv4.map(Number);
    if (a === 127) return true;                                   // 127.0.0.0/8 loopback
    if (a === 10) return true;                                    // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true;             // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;                      // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true;                      // 169.254.0.0/16 link-local + cloud metadata
    if (a === 0) return true;                                     // 0.0.0.0/8
    if (a >= 224) return true;                                    // multicast + reserved
  }

  // Block IPv6 loopback and link-local
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (hostname.startsWith("fe80:") || hostname.startsWith("[fe80:")) return true;

  return false;
}

/** Fetch raw HTML from a URL with timeout */
async function fetchRawHtml(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    // Only allow http and https protocols
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (isPrivateOrReserved(parsed.hostname)) return null;
  } catch { return null; }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) return null;

    const html = await res.text();
    // SPAs embed data in script tags — need enough HTML to capture it
    return html.slice(0, 200_000);
  } catch {
    return null;
  }
}

/** Extract page title from HTML */
function extractTitle(html: string): string {
  // Try og:title first
  const ogMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (ogMatch) return decodeHtmlEntities(ogMatch[1]).trim();

  // Fall back to <title>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) return decodeHtmlEntities(titleMatch[1]).trim();

  return "(untitled)";
}

/** Extract page description from HTML */
function extractDescription(html: string): string {
  // Try og:description first
  const ogMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  if (ogMatch) return decodeHtmlEntities(ogMatch[1]).trim().slice(0, 300);

  // Fall back to meta description
  const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  if (metaMatch) return decodeHtmlEntities(metaMatch[1]).trim().slice(0, 300);

  return "";
}

/** Decode basic HTML entities */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

// ── Quick Share: scrape a single URL for the link sharer ──

export async function scrapeUrlForQuickShare(url: string): Promise<{
  title: string;
  description: string;
  category: string;
  date: string | null;
  time: string | null;
  location: string | null;
  url: string;
}> {
  const oembedData = await fetchOEmbed(url);
  let oembedParsed: any = null;
  if (oembedData) {
    try { oembedParsed = JSON.parse(oembedData); } catch {}
  }

  const html = await fetchRawHtml(url);
  if (!html && !oembedParsed) {
    return { title: "(untitled)", description: "", category: "other", date: null, time: null, location: null, url };
  }

  let title = html ? extractTitle(html) : "(untitled)";
  if ((title === "(untitled)" || !title) && oembedParsed?.title) {
    title = oembedParsed.title;
  }

  let pageContext = html ? buildPageContext(html, url) : "";
  if (oembedData) pageContext = `OEMBED DATA:\n${oembedData}\n\n---\n\n${pageContext}`;

  if (pageContext.length < 100) {
    return { title, description: "", category: "other", date: null, time: null, location: null, url };
  }

  try {
    const model = getModel();
    const today = new Date().toISOString().split("T")[0];
    const result = await model.generateContent(
      `You are summarizing a link for sharing in a community WhatsApp group. Today's date is ${today}.

URL: ${url}
Title: ${title}

${pageContext}

Respond with ONLY a JSON object (no markdown fences):
{
  "title": "clear, concise title",
  "description": "2 sentence summary",
  "category": "article" or "video" or "event" or "podcast" or "other",
  "date": "YYYY-MM-DD" or null,
  "time": "HH:MM" or null,
  "location": "venue name and city" or null
}

RULES:
- Title: use the page title if it's good, otherwise write a clear one.
- Description: 2 concise sentences describing what this is. Be specific and informative.
- For EVENTS: extract the exact date, time, and location. Resolve relative dates using today=${today}.
- For non-events: date, time, and location should be null.
- NEVER write generic descriptions like "This page contains an event". Be specific.

JSON:`
    );
    const text = result.response.text().trim();
    const parsed = parseGeminiJson(text);
    return {
      title: parsed.title || title,
      description: (parsed.description || "").slice(0, 400),
      category: parsed.category || "other",
      date: parsed.date && /^\d{4}-\d{2}-\d{2}/.test(parsed.date) ? parsed.date.slice(0, 10) : null,
      time: parsed.time || null,
      location: parsed.location || null,
      url,
    };
  } catch (err: any) {
    const fallbackDesc = html ? extractDescription(html) : "";
    return { title, description: fallbackDesc, category: "other", date: null, time: null, location: null, url };
  }
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
