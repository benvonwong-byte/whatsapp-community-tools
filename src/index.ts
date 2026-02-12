import { config } from "./config";
import { WhatsAppClient, BufferedMessage } from "./whatsapp";
import { extractEvents } from "./extractor";
import { verifyEventDates, fetchPageText } from "./verifier";
import { startServer, BackfillProgress } from "./server";
import { EventStore } from "./store";

// ── Event link enrichment ──

const EVENT_LINK_PATTERN =
  /https?:\/\/(?:www\.)?(?:eventbrite\.com\/e\/|lu\.ma\/|partiful\.com\/e\/)\S+/gi;

/**
 * Scan messages for Eventbrite, Luma, and Partiful links, fetch their page
 * content, and append it to the message body so Claude can extract full event details.
 * Returns new message copies — originals are not mutated.
 */
async function enrichWithEventLinks(
  messages: BufferedMessage[]
): Promise<BufferedMessage[]> {
  const urlToMessages = new Map<string, number[]>();
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

  const enriched = messages.map((m) => ({ ...m }));
  for (const [url, content] of urlContent) {
    for (const idx of urlToMessages.get(url)!) {
      enriched[idx].body += `\n\n[Event page content from ${url}]:\n${content}`;
    }
  }

  return enriched;
}

async function processBatch(
  messages: BufferedMessage[],
  store: EventStore
): Promise<void> {
  const newMessages = messages.filter((m) => !store.isMessageProcessed(m.id));

  if (newMessages.length === 0) {
    console.log("[process] All messages already processed, skipping.");
    return;
  }

  console.log(
    `[process] ${newMessages.length} new messages (${messages.length - newMessages.length} already processed)`
  );

  // Enrich messages that contain Eventbrite/Luma/Partiful links with fetched page content
  const enrichedMessages = await enrichWithEventLinks(newMessages);

  // Extract events FIRST — only mark messages as processed after extraction succeeds.
  // If extraction fails (API error, JSON parse error), messages stay unmarked
  // so they'll be retried in the next backfill.
  let events;
  try {
    events = await extractEvents(enrichedMessages);
  } catch (err) {
    console.error(`[process] Extraction failed, ${newMessages.length} messages will be retried in next backfill.`);
    return;
  }

  // Extraction succeeded — mark all messages as processed
  for (const msg of newMessages) {
    store.markMessageProcessed(msg.id, msg.chatName, msg.timestamp, msg.body);
  }

  if (events.length === 0) {
    console.log("[process] No events found in this batch.");
    return;
  }

  // Verify dates by fetching event URLs (only for events that have a URL)
  try {
    events = await verifyEventDates(events);
  } catch (err) {
    console.error("[process] Date verification failed, using original dates:", err);
  }

  console.log(`[process] Found ${events.length} event(s), checking for duplicates...`);

  for (const event of events) {
    if (store.isEventDuplicate(event.name, event.date, event.location || "")) {
      console.log(`[process] Skipping duplicate: "${event.name}" on ${event.date}`);
      continue;
    }

    store.saveEvent(
      event.name,
      event.date,
      event.startTime,
      event.endTime,
      event.endDate,
      event.location,
      event.description,
      event.url,
      event.category,
      event.sourceChatName,
      event.sourceMessageId,
      event.sourceText
    );

    console.log(`[process] Saved: "${event.name}" on ${event.date} [${event.category}]`);
  }
}

async function main() {
  console.log("=== WhatsApp NYC Events Scanner ===\n");

  // Always start the store and web server first
  const store = new EventStore();
  console.log("SQLite store initialized.");

  const whatsapp = new WhatsAppClient();

  // Backfill progress state (shared with server for the API)
  const backfillProgress: BackfillProgress = {
    active: false,
    phase: "idle",
    totalMessages: 0,
    processedMessages: 0,
    eventsFound: 0,
    groupsScanned: 0,
    totalGroups: 0,
  };

  const runBackfill = async (hours: number): Promise<number> => {
    const label = hours >= 24 ? `${(hours / 24).toFixed(1)} days` : `${hours}h`;
    console.log(`\n[backfill] Starting backfill (${label})...`);
    backfillProgress.active = true;
    backfillProgress.phase = "fetching";
    backfillProgress.totalMessages = 0;
    backfillProgress.processedMessages = 0;
    backfillProgress.eventsFound = 0;
    backfillProgress.groupsScanned = 0;
    backfillProgress.totalGroups = 0;
    backfillProgress.errorMessage = undefined;

    let messages: BufferedMessage[];
    try {
      messages = await whatsapp.fetchRecentMessages(hours, (scanned, total) => {
        backfillProgress.groupsScanned = scanned;
        backfillProgress.totalGroups = total;
      });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error(`[backfill] Fetch failed: ${errMsg}`);
      backfillProgress.phase = "error";
      backfillProgress.active = false;
      backfillProgress.errorMessage = errMsg;
      setTimeout(() => { if (backfillProgress.phase === "error") backfillProgress.phase = "idle"; }, 60000);
      return 0;
    }

    if (messages.length === 0) {
      console.log("[backfill] No messages to process.");
      backfillProgress.phase = "done";
      backfillProgress.active = false;
      // Reset to idle after 15s so frontend stops showing "done"
      setTimeout(() => { if (backfillProgress.phase === "done") backfillProgress.phase = "idle"; }, 15000);
      return 0;
    }

    backfillProgress.phase = "processing";
    backfillProgress.totalMessages = messages.length;
    let totalEvents = 0;
    const batchSize = 20;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      console.log(`[backfill] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(messages.length / batchSize)}...`);
      const before = store.getTotalStats().totalEvents;
      await processBatch(batch, store);
      const newEvents = store.getTotalStats().totalEvents - before;
      totalEvents += newEvents;
      backfillProgress.processedMessages = Math.min(i + batchSize, messages.length);
      backfillProgress.eventsFound = totalEvents;
    }

    console.log(`[backfill] Done! Found ${totalEvents} new events.\n`);
    backfillProgress.phase = "done";
    backfillProgress.active = false;
    // Reset to idle after 15s so frontend stops showing "done"
    setTimeout(() => { if (backfillProgress.phase === "done") backfillProgress.phase = "idle"; }, 15000);
    return totalEvents;
  };

  startServer(
    store,
    () => ({ whatsappConnected: whatsapp.isConnected() }),
    () => whatsapp.getQrCode(),
    runBackfill,
    () => backfillProgress
  );

  // WhatsApp + Claude are optional — skip if no API key
  if (!config.anthropicApiKey) {
    console.log(
      "\nNo ANTHROPIC_API_KEY set. Running in web-only mode." +
      "\nAdd your key to .env and restart to enable WhatsApp scanning." +
      "\nYou can seed sample events at: POST http://localhost:" + config.port + "/api/seed\n"
    );
    return;
  }

  whatsapp.setFlushHandler(async (messages: BufferedMessage[]) => {
    await processBatch(messages, store);
  });

  whatsapp.setGroupBlockedCheck((chatName: string) => store.isGroupBlocked(chatName));

  // On ready (initial connect or reconnect), backfill since last event found.
  // Uses the last event's created_at rather than the last processed message,
  // because real-time messages keep updating the processed timestamp even
  // when backfill scanning is broken or not finding events.
  whatsapp.setReadyHandler(async () => {
    const lastEventTs = store.getLastEventCreatedTimestamp();
    if (lastEventTs) {
      const gapMs = Date.now() - lastEventTs * 1000;
      const gapHours = Math.ceil(gapMs / (60 * 60 * 1000));
      const hours = Math.max(1, Math.min(gapHours, 720)); // cap at 30 days
      console.log(`[ready] Last event created: ${new Date(lastEventTs * 1000).toISOString()} (${gapHours}h ago). Backfilling ${hours}h.`);
      await runBackfill(hours);
    } else {
      console.log("[ready] No previous events found. Backfilling 168h (7 days).");
      await runBackfill(168);
    }
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    await whatsapp.stop();
    store.close();
    console.log("Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await whatsapp.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
