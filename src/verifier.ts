import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { ExtractedEvent } from "./extractor";
import { EventStore, StoredEvent } from "./store";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/** Strip HTML tags and extract readable text from a page. */
function htmlToText(html: string): string {
  return html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    // Replace common block elements with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

/** Fetch a URL with timeout and return its text content. */
async function fetchPageText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EventBot/1.0)",
        "Accept": "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[verifier] HTTP ${res.status} for ${url}`);
      return null;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
      console.log(`[verifier] Non-HTML content type for ${url}: ${contentType}`);
      return null;
    }

    const html = await res.text();
    const text = htmlToText(html);

    // Truncate to ~6000 chars to keep Claude call small
    return text.slice(0, 6000);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.log(`[verifier] Timeout fetching ${url}`);
    } else {
      console.log(`[verifier] Failed to fetch ${url}: ${err?.message || err}`);
    }
    return null;
  }
}

interface VerifiedFields {
  date: string;
  startTime: string | null;
  endTime: string | null;
  endDate: string | null;
  location: string | null;
  name: string | null; // only set if page has a clearly better name
}

/** Ask Claude to verify/correct event date from page content. */
async function verifyFromPage(
  event: ExtractedEvent,
  pageText: string
): Promise<VerifiedFields | null> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are verifying event details by comparing a WhatsApp-extracted event against its actual event page.

Today's date is ${today}.

EXTRACTED EVENT (from WhatsApp message):
- Name: ${event.name}
- Date: ${event.date}
- Start time: ${event.startTime || "unknown"}
- End time: ${event.endTime || "unknown"}
- End date: ${event.endDate || "same day"}
- Location: ${event.location || "unknown"}

PAGE CONTENT (from ${event.url}):
${pageText}

TASK: Extract the CORRECT event details from the page content. The page is the authoritative source.

RULES:
1. If the page clearly shows a different date than the extracted event, use the page's date.
2. If the page shows times that differ, use the page's times.
3. If the page has a more specific or correct location, use it.
4. If the page has a better/official event name, provide it.
5. For relative dates on the page, resolve to YYYY-MM-DD based on today (${today}).
6. If the page doesn't contain clear event info (maybe it's a generic landing page), return the original values unchanged.
7. All dates must be YYYY-MM-DD format. All times must be HH:MM in 24-hour format.

Respond with ONLY a JSON object (no markdown):
{
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM" or null,
  "endTime": "HH:MM" or null,
  "endDate": "YYYY-MM-DD" or null,
  "location": "venue/address" or null,
  "name": "corrected name" or null,
  "changed": true/false
}

Set "changed" to true ONLY if you found different information on the page. If the original extraction was already correct, set "changed" to false and return the original values.

JSON:`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);

    if (!parsed.changed) return null; // No corrections needed

    return {
      date: parsed.date || event.date,
      startTime: parsed.startTime ?? event.startTime,
      endTime: parsed.endTime ?? event.endTime,
      endDate: parsed.endDate ?? event.endDate,
      location: parsed.location ?? event.location,
      name: parsed.name || null,
    };
  } catch (err: any) {
    console.log(`[verifier] Claude verification failed for "${event.name}": ${err?.message || err}`);
    return null;
  }
}

/**
 * Verify event dates by fetching their URLs and cross-checking with page content.
 * Only processes events that have a URL. Returns the same array with corrected dates.
 */
export async function verifyEventDates(events: ExtractedEvent[]): Promise<ExtractedEvent[]> {
  const withUrl = events.filter((e) => e.url);
  const withoutUrl = events.filter((e) => !e.url);

  if (withUrl.length === 0) return events;

  console.log(`[verifier] Verifying ${withUrl.length} event(s) with URLs...`);

  // Process in parallel (max 3 concurrent to avoid rate limits)
  const concurrency = 3;
  const verified: ExtractedEvent[] = [];

  for (let i = 0; i < withUrl.length; i += concurrency) {
    const batch = withUrl.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (event) => {
        const pageText = await fetchPageText(event.url!);
        if (!pageText) {
          console.log(`[verifier] No page content for "${event.name}", keeping original date.`);
          return event;
        }

        const corrections = await verifyFromPage(event, pageText);
        if (!corrections) {
          console.log(`[verifier] "${event.name}" on ${event.date} — confirmed correct.`);
          return event;
        }

        const updated = { ...event };
        if (corrections.date !== event.date) {
          console.log(`[verifier] "${event.name}" date corrected: ${event.date} → ${corrections.date}`);
        }
        if (corrections.startTime !== event.startTime) {
          console.log(`[verifier] "${event.name}" start time corrected: ${event.startTime} → ${corrections.startTime}`);
        }
        if (corrections.location && corrections.location !== event.location) {
          console.log(`[verifier] "${event.name}" location corrected: ${event.location} → ${corrections.location}`);
        }
        if (corrections.name) {
          console.log(`[verifier] "${event.name}" name corrected: "${event.name}" → "${corrections.name}"`);
          updated.name = corrections.name;
        }

        updated.date = corrections.date;
        updated.startTime = corrections.startTime;
        updated.endTime = corrections.endTime;
        updated.endDate = corrections.endDate;
        if (corrections.location) updated.location = corrections.location;

        return updated;
      })
    );
    verified.push(...results);
  }

  return [...verified, ...withoutUrl];
}

// ── Bulk verification of stored events ──

export interface VerifyProgress {
  active: boolean;
  phase: "idle" | "running" | "done" | "error";
  total: number;
  checked: number;
  updated: number;
  deleted: number;
  errorMessage?: string;
}

/** Verify a stored event using its source text (when no URL or URL failed). */
async function verifyFromSourceText(
  event: StoredEvent
): Promise<{ action: "keep" | "update"; fields?: Partial<{ name: string; date: string; startTime: string | null; endTime: string | null; endDate: string | null; location: string | null }> } | null> {
  if (!event.sourceText || event.sourceText.trim().length < 20) return null;

  const today = new Date().toISOString().split("T")[0];
  const prompt = `You are verifying event details extracted from a WhatsApp message.

Today's date is ${today}.

EXTRACTED EVENT:
- Name: ${event.name}
- Date: ${event.date}
- Start time: ${event.startTime || "unknown"}
- End time: ${event.endTime || "unknown"}
- End date: ${event.endDate || "same day"}
- Location: ${event.location || "unknown"}

RAW SOURCE MESSAGE:
${event.sourceText.slice(0, 4000)}

TASK: Re-read the raw source message carefully and verify the extracted date and time.

RULES:
1. The source text is the ground truth. If it mentions a specific date/time that differs from the extracted fields, use the source's date/time.
2. For relative dates like "this Saturday" or "next Friday", resolve them relative to today (${today}).
3. If the source text is ambiguous or doesn't clearly specify a date, return the original values unchanged.
4. All dates must be YYYY-MM-DD. All times must be HH:MM in 24-hour format.

Respond with ONLY a JSON object (no markdown):
{
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM" or null,
  "endTime": "HH:MM" or null,
  "endDate": "YYYY-MM-DD" or null,
  "changed": true/false
}

JSON:`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);
    if (!parsed.changed) return null;

    return {
      action: "update",
      fields: {
        date: parsed.date || event.date,
        startTime: parsed.startTime ?? event.startTime,
        endTime: parsed.endTime ?? event.endTime,
        endDate: parsed.endDate ?? event.endDate,
      },
    };
  } catch (err: any) {
    console.log(`[verify-all] Source text verification failed for "${event.name}": ${err?.message || err}`);
    return null;
  }
}

/** Verify a stored event using its URL. Returns action: keep, update, or delete. */
async function verifyStoredEventUrl(
  event: StoredEvent
): Promise<{ action: "keep" | "update" | "delete"; fields?: Partial<{ name: string; date: string; startTime: string | null; endTime: string | null; endDate: string | null; location: string | null }> }> {
  const pageText = await fetchPageText(event.url!);

  // URL is broken/invalid — mark for deletion
  if (!pageText) {
    return { action: "delete" };
  }

  // URL returned content — ask Claude to verify
  const today = new Date().toISOString().split("T")[0];
  const prompt = `You are verifying an event by checking its event page.

Today's date is ${today}.

STORED EVENT:
- Name: ${event.name}
- Date: ${event.date}
- Start time: ${event.startTime || "unknown"}
- End time: ${event.endTime || "unknown"}
- End date: ${event.endDate || "same day"}
- Location: ${event.location || "unknown"}

PAGE CONTENT (from ${event.url}):
${pageText}

TASK: Determine if this page contains actual event information, and if so, verify the date/time/location.

Respond with ONLY a JSON object (no markdown):
{
  "hasEventInfo": true/false,
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM" or null,
  "endTime": "HH:MM" or null,
  "endDate": "YYYY-MM-DD" or null,
  "location": "venue/address" or null,
  "name": "corrected name" or null,
  "changed": true/false
}

RULES:
1. Set "hasEventInfo" to false if the page is a generic landing page, login page, 404, or doesn't contain specific event details (date, time, description). In that case, other fields don't matter.
2. Set "hasEventInfo" to true if the page clearly describes an event with a specific date.
3. Set "changed" to true only if you found DIFFERENT information than what's stored.
4. For relative dates, resolve to YYYY-MM-DD based on today (${today}).
5. All dates YYYY-MM-DD, all times HH:MM 24-hour format.

JSON:`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);

    // Page doesn't have event info — delete the event
    if (!parsed.hasEventInfo) {
      return { action: "delete" };
    }

    // Page has event info but nothing changed
    if (!parsed.changed) {
      return { action: "keep" };
    }

    // Page has corrections
    return {
      action: "update",
      fields: {
        date: parsed.date || event.date,
        startTime: parsed.startTime ?? event.startTime,
        endTime: parsed.endTime ?? event.endTime,
        endDate: parsed.endDate ?? event.endDate,
        location: parsed.location ?? event.location,
        name: parsed.name || undefined,
      },
    };
  } catch (err: any) {
    console.log(`[verify-all] URL verification failed for "${event.name}": ${err?.message || err}`);
    return { action: "keep" }; // On error, don't delete
  }
}

/**
 * Verify ALL stored future events. Events with URLs get URL-checked (broken → deleted).
 * Events without URLs get source-text-checked. Updates the database directly.
 */
export async function verifyAllStoredEvents(
  store: EventStore,
  progress: VerifyProgress
): Promise<void> {
  const events = store.getFutureEvents();
  progress.total = events.length;
  progress.checked = 0;
  progress.updated = 0;
  progress.deleted = 0;
  progress.phase = "running";
  progress.active = true;

  console.log(`[verify-all] Starting verification of ${events.length} future events...`);

  const concurrency = 3;

  for (let i = 0; i < events.length; i += concurrency) {
    const batch = events.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (event) => {
        try {
          if (event.url) {
            // Verify via URL
            const result = await verifyStoredEventUrl(event);

            if (result.action === "delete") {
              store.deleteEvent(event.hash);
              progress.deleted++;
              console.log(`[verify-all] DELETED "${event.name}" — URL invalid or no event info`);
            } else if (result.action === "update" && result.fields) {
              store.updateEvent(event.hash, result.fields);
              progress.updated++;
              const changes = Object.entries(result.fields)
                .filter(([k, v]) => v !== (event as any)[k])
                .map(([k, v]) => `${k}: ${(event as any)[k]} → ${v}`)
                .join(", ");
              console.log(`[verify-all] UPDATED "${event.name}" — ${changes}`);
            } else {
              console.log(`[verify-all] OK "${event.name}" on ${event.date}`);
            }
          } else {
            // No URL — verify from source text
            const result = await verifyFromSourceText(event);
            if (result && result.action === "update" && result.fields) {
              store.updateEvent(event.hash, result.fields);
              progress.updated++;
              const changes = Object.entries(result.fields)
                .filter(([k, v]) => v !== (event as any)[k])
                .map(([k, v]) => `${k}: ${(event as any)[k]} → ${v}`)
                .join(", ");
              console.log(`[verify-all] UPDATED "${event.name}" (from source text) — ${changes}`);
            } else {
              console.log(`[verify-all] OK "${event.name}" on ${event.date} (no URL, source text confirmed)`);
            }
          }
        } catch (err: any) {
          console.error(`[verify-all] Error verifying "${event.name}": ${err?.message || err}`);
        }

        progress.checked++;
      })
    );
  }

  console.log(`[verify-all] Done! Checked ${progress.checked}, updated ${progress.updated}, deleted ${progress.deleted}.`);
  progress.phase = "done";
  progress.active = false;
}
