import { config } from "./config";
import { WhatsAppClient, BufferedMessage } from "./whatsapp";
import { extractEvents } from "./extractor";
import { startServer, BackfillProgress } from "./server";
import { EventStore } from "./store";

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

  for (const msg of newMessages) {
    store.markMessageProcessed(msg.id, msg.chatName, msg.timestamp, msg.body);
  }

  const events = await extractEvents(newMessages);

  if (events.length === 0) {
    console.log("[process] No events found in this batch.");
    return;
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

  // On ready (initial connect or reconnect), backfill since last processed message
  whatsapp.setReadyHandler(async () => {
    const lastTs = store.getLastProcessedTimestamp();
    if (lastTs) {
      const gapMs = Date.now() - lastTs * 1000;
      const gapHours = Math.ceil(gapMs / (60 * 60 * 1000));
      const hours = Math.max(1, Math.min(gapHours, 720)); // cap at 30 days
      console.log(`[ready] Last processed message: ${new Date(lastTs * 1000).toISOString()} (${gapHours}h ago). Backfilling ${hours}h.`);
      await runBackfill(hours);
    } else {
      console.log("[ready] No previous messages found. Backfilling 168h (7 days).");
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
