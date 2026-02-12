import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { ExtractedEvent } from "./extractor";
import { EventStore, StoredEvent } from "./store";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// ── Rate-limited Claude wrapper ──
// Enforces max ~4 req/min with retry on 429 errors.
let lastClaudeCall = 0;
const MIN_CLAUDE_INTERVAL = 15_000; // 15s between calls → 4/min (safe under 5/min limit)

async function rateLimitedClaude(
  opts: { model: string; max_tokens: number; messages: { role: "user"; content: string }[] },
  retries = 3
): Promise<Anthropic.Messages.Message> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Enforce minimum interval between calls
    const now = Date.now();
    const wait = MIN_CLAUDE_INTERVAL - (now - lastClaudeCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastClaudeCall = Date.now();

    try {
      return await client.messages.create(opts as any);
    } catch (err: any) {
      const status = err?.status || err?.error?.status;
      if (status === 429 && attempt < retries) {
        const backoff = Math.min(30_000, 15_000 * (attempt + 1));
        console.log(`[verifier] Rate limited (429), retrying in ${(backoff / 1000).toFixed(0)}s... (attempt ${attempt + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Rate limit retries exhausted");
}

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

/** Block requests to private/internal IPs to prevent SSRF. */
function isSafeUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hostname)) return false;
    if (hostname.endsWith(".internal") || hostname.endsWith(".local")) return false;
    return true;
  } catch { return false; }
}

/** Fetch a URL with timeout and return its text content. */
export async function fetchPageText(url: string): Promise<string | null> {
  if (!isSafeUrl(url)) {
    console.log(`[verifier] Blocked unsafe URL: ${url}`);
    return null;
  }

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

    if (!res.ok) {
      clearTimeout(timeout);
      console.log(`[verifier] HTTP ${res.status} for ${url}`);
      return null;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
      clearTimeout(timeout);
      console.log(`[verifier] Non-HTML content type for ${url}: ${contentType}`);
      return null;
    }

    const html = await res.text();
    clearTimeout(timeout);
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
    const response = await rateLimitedClaude({
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

  const concurrency = 5;
  const verified: ExtractedEvent[] = new Array(withUrl.length);
  let cursor = 0;

  async function worker() {
    while (cursor < withUrl.length) {
      const idx = cursor++;
      const event = withUrl[idx];
      const pageText = await fetchPageText(event.url!);
      if (!pageText) {
        console.log(`[verifier] No page content for "${event.name}", keeping original date.`);
        verified[idx] = event;
        continue;
      }

      const corrections = await verifyFromPage(event, pageText);
      if (!corrections) {
        console.log(`[verifier] "${event.name}" on ${event.date} — confirmed correct.`);
        verified[idx] = event;
        continue;
      }

      const updated = { ...event };
      if (corrections.date !== event.date) console.log(`[verifier] "${event.name}" date corrected: ${event.date} → ${corrections.date}`);
      if (corrections.startTime !== event.startTime) console.log(`[verifier] "${event.name}" start time corrected: ${event.startTime} → ${corrections.startTime}`);
      if (corrections.location && corrections.location !== event.location) console.log(`[verifier] "${event.name}" location corrected: ${event.location} → ${corrections.location}`);
      if (corrections.name) { console.log(`[verifier] "${event.name}" name corrected to "${corrections.name}"`); updated.name = corrections.name; }

      updated.date = corrections.date;
      updated.startTime = corrections.startTime;
      updated.endTime = corrections.endTime;
      updated.endDate = corrections.endDate;
      if (corrections.location) updated.location = corrections.location;
      verified[idx] = updated;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, withUrl.length) }, () => worker()));

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
  currentEvent?: string;
  errorMessage?: string;
}

/** Verify a stored event using its source text (when no URL or URL failed). */
async function verifyFromSourceText(
  event: StoredEvent
): Promise<{ action: "keep" | "update" | "delete"; fields?: Partial<{ name: string; date: string; startTime: string | null; endTime: string | null; endDate: string | null; location: string | null }> } | null> {
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
- Category: ${event.category}

RAW SOURCE MESSAGE:
${event.sourceText.slice(0, 4000)}

TASK: Re-read the raw source message carefully and verify the extracted date, time, AND location.

RULES:
1. The source text is the ground truth. If it mentions a specific date/time that differs from the extracted fields, use the source's date/time.
2. For relative dates like "this Saturday" or "next Friday", resolve them relative to today (${today}).
3. If the source text is ambiguous or doesn't clearly specify a date, return the original values unchanged.
4. All dates must be YYYY-MM-DD. All times must be HH:MM in 24-hour format.
5. IMPORTANT: Determine if this event is in the New York City metro area (NYC, all five boroughs, Northern NJ, Westchester, Long Island). Set "isNYCArea" accordingly. Online/virtual/Zoom events count as NYC area (set true).

Respond with ONLY a JSON object (no markdown):
{
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM" or null,
  "endTime": "HH:MM" or null,
  "endDate": "YYYY-MM-DD" or null,
  "changed": true/false,
  "isNYCArea": true/false
}

JSON:`;

  try {
    const response = await rateLimitedClaude({
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

    // Not in NYC area — delete
    if (parsed.isNYCArea === false) {
      return { action: "delete" };
    }

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
- Category: ${event.category}

PAGE CONTENT (from ${event.url}):
${pageText}

TASK: Determine if this page contains actual event information, and if so, verify the date/time/location.

Respond with ONLY a JSON object (no markdown):
{
  "hasEventInfo": true/false,
  "isNYCArea": true/false,
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
6. IMPORTANT: Set "isNYCArea" to true if the event is in the New York City metro area (NYC, all five boroughs, Northern NJ, Westchester, Long Island) OR if it's an online/virtual/Zoom event. Set false if the event is clearly in another city (LA, SF, Chicago, London, etc.).

JSON:`;

  try {
    const response = await rateLimitedClaude({
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

    // Event is not in NYC area — delete
    if (parsed.isNYCArea === false) {
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

/** Normalize an event name for comparison: lowercase, strip punctuation, collapse whitespace. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compute word-level Jaccard similarity between two names (0–1). Only considers words with 3+ chars. */
function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);

  // Exact match after normalization
  if (na === nb) return 1;

  // One contains the other
  if (na.includes(nb) || nb.includes(na)) return 0.9;

  const wordsA = new Set(na.split(" ").filter((w) => w.length >= 3));
  const wordsB = new Set(nb.split(" ").filter((w) => w.length >= 3));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

/** Score an event for "keeper" priority — higher score = more info = better to keep. */
function eventQuality(event: StoredEvent): number {
  let score = 0;
  if (event.url) score += 3;
  if (event.location) score += 2;
  if (event.description && event.description.length > 50) score += 2;
  if (event.startTime) score += 1;
  if (event.endTime) score += 1;
  return score;
}

export interface DedupProgress {
  active: boolean;
  phase: "idle" | "running" | "done";
  total: number;
  checked: number;
  deleted: number;
  currentEvent?: string;
}

/** Find and remove duplicate events (similar name + same or adjacent date). */
export function deduplicateEvents(store: EventStore, progress: DedupProgress): number {
  const events = store.getAllEvents();
  progress.total = events.length;
  progress.checked = 0;
  progress.deleted = 0;
  progress.phase = "running";
  progress.active = true;

  console.log(`[dedup] Scanning ${events.length} events for duplicates...`);

  const deleted = new Set<string>();

  // Group events by date
  const byDate = new Map<string, StoredEvent[]>();
  for (const event of events) {
    if (!byDate.has(event.date)) byDate.set(event.date, []);
    byDate.get(event.date)!.push(event);
  }

  // Compare within same-date groups
  for (const [, group] of byDate) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (deleted.has(group[i].hash)) continue;
      progress.currentEvent = group[i].name;
      progress.checked++;
      for (let j = i + 1; j < group.length; j++) {
        if (deleted.has(group[j].hash)) continue;
        const sim = nameSimilarity(group[i].name, group[j].name);
        if (sim >= 0.5) {
          const qi = eventQuality(group[i]);
          const qj = eventQuality(group[j]);
          const [keeper, dup] = qi >= qj ? [group[i], group[j]] : [group[j], group[i]];
          store.deleteEvent(dup.hash);
          deleted.add(dup.hash);
          progress.deleted++;
          console.log(
            `[dedup] Deleted "${dup.name}" (${dup.date}) — duplicate of "${keeper.name}" (similarity: ${(sim * 100).toFixed(0)}%)`
          );
        }
      }
    }
  }

  // Also check adjacent dates (off-by-one day)
  const sortedDates = [...byDate.keys()].sort();
  for (let d = 0; d < sortedDates.length - 1; d++) {
    const date1 = sortedDates[d];
    const date2 = sortedDates[d + 1];
    const diffMs = new Date(date2).getTime() - new Date(date1).getTime();
    if (diffMs > 86400000) continue; // more than 1 day apart

    const group1 = byDate.get(date1)!;
    const group2 = byDate.get(date2)!;
    for (const e1 of group1) {
      if (deleted.has(e1.hash)) continue;
      for (const e2 of group2) {
        if (deleted.has(e2.hash)) continue;
        const sim = nameSimilarity(e1.name, e2.name);
        if (sim >= 0.5) {
          const q1 = eventQuality(e1);
          const q2 = eventQuality(e2);
          const [keeper, dup] = q1 >= q2 ? [e1, e2] : [e2, e1];
          store.deleteEvent(dup.hash);
          deleted.add(dup.hash);
          progress.deleted++;
          console.log(
            `[dedup] Deleted "${dup.name}" (${dup.date}) — duplicate of "${keeper.name}" (${keeper.date}, similarity: ${(sim * 100).toFixed(0)}%)`
          );
        }
      }
    }
  }

  console.log(`[dedup] Done! Scanned ${events.length} events, removed ${deleted.size} duplicates.`);
  progress.phase = "done";
  progress.active = false;
  progress.currentEvent = undefined;

  return deleted.size;
}

/** Check if an event is likely in the NYC area based on its location string. */
function isLikelyOnline(event: StoredEvent): boolean {
  const cat = event.category?.toLowerCase() || "";
  if (cat === "online") return true;
  const loc = (event.location || "").toLowerCase();
  return /\b(zoom|online|virtual|remote|webinar|livestream|live stream)\b/.test(loc);
}

/** For events with no URL and insufficient source text, ask Claude about location. */
async function checkLocationNYC(event: StoredEvent): Promise<boolean> {
  if (isLikelyOnline(event)) return true;

  const prompt = `Is this event in the New York City metro area (NYC five boroughs, Northern NJ, Westchester, Long Island)?

Event: ${event.name}
Location: ${event.location || "unknown"}
Source group: ${event.sourceChat || "unknown"}
Description: ${(event.description || "").slice(0, 500)}

Answer with ONLY "yes" or "no".`;

  try {
    const response = await rateLimitedClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (response.content[0].type === "text" ? response.content[0].text : "").trim().toLowerCase();
    return text.startsWith("yes");
  } catch {
    return true; // On error, keep the event
  }
}

/**
 * Verify ALL stored events. Events with URLs get URL-checked (broken → deleted).
 * Events without URLs get source-text-checked. Non-NYC events are deleted.
 * Updates the database directly.
 */
export async function verifyAllStoredEvents(
  store: EventStore,
  progress: VerifyProgress
): Promise<void> {
  const events = store.getAllEvents();
  progress.total = events.length;
  progress.checked = 0;
  progress.updated = 0;
  progress.deleted = 0;
  progress.phase = "running";
  progress.active = true;

  console.log(`[verify-all] Starting verification of ${events.length} events...`);

  // Worker pool — concurrency kept low since Claude API is rate-limited (5 req/min)
  const concurrency = 2;
  let cursor = 0;

  async function processEvent(event: StoredEvent) {
    progress.currentEvent = event.name;
    try {
      if (event.url) {
        const result = await verifyStoredEventUrl(event);

        if (result.action === "delete") {
          store.deleteEvent(event.hash);
          progress.deleted++;
          console.log(`[verify-all] DELETED "${event.name}" — URL invalid, no event info, or not in NYC`);
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
        const result = await verifyFromSourceText(event);
        if (result && result.action === "delete") {
          store.deleteEvent(event.hash);
          progress.deleted++;
          console.log(`[verify-all] DELETED "${event.name}" — not in NYC area`);
        } else if (result && result.action === "update" && result.fields) {
          store.updateEvent(event.hash, result.fields);
          progress.updated++;
          const changes = Object.entries(result.fields)
            .filter(([k, v]) => v !== (event as any)[k])
            .map(([k, v]) => `${k}: ${(event as any)[k]} → ${v}`)
            .join(", ");
          console.log(`[verify-all] UPDATED "${event.name}" (from source text) — ${changes}`);
        } else if (!result) {
          const inNYC = await checkLocationNYC(event);
          if (!inNYC) {
            store.deleteEvent(event.hash);
            progress.deleted++;
            console.log(`[verify-all] DELETED "${event.name}" — location "${event.location}" not in NYC area`);
          } else {
            console.log(`[verify-all] OK "${event.name}" on ${event.date} (no URL, location confirmed NYC)`);
          }
        } else {
          console.log(`[verify-all] OK "${event.name}" on ${event.date} (source text confirmed)`);
        }
      }
    } catch (err: any) {
      console.error(`[verify-all] Error verifying "${event.name}": ${err?.message || err}`);
    }

    progress.checked++;
  }

  async function worker() {
    while (cursor < events.length) {
      const idx = cursor++;
      await processEvent(events[idx]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, events.length) }, () => worker()));

  console.log(`[verify-all] Done! Checked ${progress.checked}, updated ${progress.updated}, deleted ${progress.deleted}.`);
  progress.phase = "done";
  progress.active = false;
  progress.currentEvent = undefined;
}
