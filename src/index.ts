import { config } from "./config";
import { WhatsAppClient, BufferedMessage } from "./whatsapp";
import { extractEvents } from "./extractor";
import { startServer } from "./server";
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

  startServer(
    store,
    () => ({ whatsappConnected: whatsapp.isConnected() }),
    () => whatsapp.getQrCode()
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

  // On ready, backfill last 7 days of messages
  whatsapp.setReadyHandler(async () => {
    console.log("\n[backfill] Starting 7-day backfill...");
    const messages = await whatsapp.fetchRecentMessages(7);

    if (messages.length === 0) {
      console.log("[backfill] No messages to process.");
      return;
    }

    // Process in batches of 20 to avoid overwhelming the LLM
    const batchSize = 20;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      console.log(`[backfill] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(messages.length / batchSize)}...`);
      await processBatch(batch, store);
    }

    console.log("[backfill] Done! Check http://localhost:" + config.port + "\n");
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
