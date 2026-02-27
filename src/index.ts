// Lock all server-side time operations to Eastern Time
process.env.TZ = "America/New_York";

import fs from "fs";
import path from "path";
import { config } from "./config";
import { WhatsAppClient, BufferedMessage } from "./whatsapp";
import { extractEvents } from "./extractor";
import { verifyEventDates, fetchPageText } from "./verifier";
import { startServer, BackfillProgress } from "./server";
import { EventStore } from "./store";
import { RelationshipStore } from "./apps/relationship/store";
import { createRelationshipHandler, transcribeVoiceNote } from "./apps/relationship/handler";
import { markProgressDone, markProgressError } from "./utils/progress";
import { runDailyAnalysis, AnalyzeProgress } from "./apps/relationship/analyzer";
import { createRelationshipRouter } from "./apps/relationship/routes";
import { buildUpdateMessage, shouldSendUpdate } from "./apps/relationship/updater";
import { MetacrisisStore } from "./apps/metacrisis/store";
import { createMetacrisisHandler, categorizeUrl } from "./apps/metacrisis/handler";
import { runDailyDigest, runWeeklySummary, processEventLinks, formatSummaryForWhatsApp, scrapeLinksMeta } from "./apps/metacrisis/summarizer";
import { createMetacrisisRouter } from "./apps/metacrisis/routes";
import { FriendsStore } from "./apps/friends/store";
import { createFriendsHandler } from "./apps/friends/handler";
import { createFriendsRouter, SendProgress } from "./apps/friends/routes";
import { runTagExtraction, runDirectTagExtraction, runTagConsolidation } from "./apps/friends/tagger";
import { createRecordingRouter } from "./apps/recording/routes";
import { createCallsRouter } from "./apps/calls/routes";

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
      console.error(`[backfill] Fetch failed: ${err?.message || String(err)}`);
      markProgressError(backfillProgress, err);
      return 0;
    }

    if (messages.length === 0) {
      console.log("[backfill] No messages to process.");
      markProgressDone(backfillProgress);
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
    markProgressDone(backfillProgress);
    return totalEvents;
  };

  // ── Initialize sub-apps ──

  const relationshipStore = new RelationshipStore();
  console.log("Relationship store initialized.");

  const appRouters: { path: string; router: any; authLevel?: "admin" | "auth" }[] = [];

  // Relationship app: monitor private chat, transcribe voice notes, analyze communication
  const relationshipAnalyzeProgress: AnalyzeProgress = {
    active: false,
    phase: "idle",
    messageCount: 0,
    currentDay: 0,
    totalDays: 0,
    log: [],
  };
  const relationshipAnalyze = () => runDailyAnalysis(relationshipStore, relationshipAnalyzeProgress);
  whatsapp.addRawMessageListener(createRelationshipHandler(relationshipStore));

  const relationshipBackfill = async (): Promise<number> => {
    const chat = await whatsapp.getChatByName(config.relationshipChatName);
    if (!chat) {
      // List available private chats to help debug name mismatch
      const allChats = await whatsapp.getClient().getChats();
      const privateChatNames = allChats
        .filter((c: any) => !c.isGroup)
        .slice(0, 30)
        .map((c: any) => c.name || c.id?.user || "unnamed");
      console.log(`[relationship-backfill] Available private chats: ${privateChatNames.join(", ")}`);
      throw new Error(`Chat "${config.relationshipChatName}" not found. Available: ${privateChatNames.join(", ")}`);
    }

    console.log(`[relationship-backfill] Fetching messages from "${chat.name}"...`);
    const messages = await chat.fetchMessages({ limit: 10000 });

    let saved = 0;
    let transcribed = 0;
    for (const msg of messages) {
      const isPtt = (msg as any).type === "ptt";
      if (!msg.body && !isPtt) continue;
      if (relationshipStore.isDuplicate(msg.id._serialized)) continue;

      const speaker = msg.fromMe ? "self" : "hope";

      // For voice notes, try to download and transcribe
      if (isPtt) {
        let transcript = "";
        try {
          const media = await msg.downloadMedia();
          if (media) {
            transcript = await transcribeVoiceNote(media.data, media.mimetype);
            if (transcript) transcribed++;
          }
        } catch (err: any) {
          console.log(`[relationship-backfill] Voice transcription failed: ${err?.message || err}`);
        }
        relationshipStore.saveMessage({
          id: msg.id._serialized,
          speaker,
          body: transcript ? "" : "[voice note - transcription failed]",
          transcript,
          timestamp: msg.timestamp,
          type: "voice",
        });
      } else {
        relationshipStore.saveMessage({
          id: msg.id._serialized,
          speaker,
          body: msg.body || "",
          transcript: "",
          timestamp: msg.timestamp,
          type: "text",
        });
      }
      saved++;
    }

    console.log(`[relationship-backfill] Imported ${saved} messages (${transcribed} voice transcribed, ${messages.length - saved} skipped/duplicates).`);
    return saved;
  };

  // Retro-transcribe: find voice messages with empty transcripts, re-fetch from WhatsApp, transcribe
  const relationshipTranscribe = async (): Promise<number> => {
    const untranscribed = relationshipStore.getUntranscribedVoiceMessages();
    if (untranscribed.length === 0) {
      console.log("[relationship-transcribe] No untranscribed voice messages found.");
      return 0;
    }

    console.log(`[relationship-transcribe] Found ${untranscribed.length} untranscribed voice messages. Fetching from WhatsApp...`);

    const chat = await whatsapp.getChatByName(config.relationshipChatName);
    if (!chat) throw new Error(`Chat "${config.relationshipChatName}" not found`);

    // Fetch messages from WhatsApp to get access to downloadMedia
    const waMessages = await chat.fetchMessages({ limit: 10000 });
    const waMap = new Map<string, any>();
    for (const m of waMessages) {
      waMap.set(m.id._serialized, m);
    }

    let success = 0;
    let failed = 0;
    for (const dbMsg of untranscribed) {
      const waMsg = waMap.get(dbMsg.id);
      if (!waMsg) {
        console.log(`[relationship-transcribe] Message ${dbMsg.id} not found in WhatsApp (may be too old)`);
        failed++;
        continue;
      }

      try {
        const media = await waMsg.downloadMedia();
        if (!media) {
          console.log(`[relationship-transcribe] No media for ${dbMsg.id}`);
          failed++;
          continue;
        }
        const transcript = await transcribeVoiceNote(media.data, media.mimetype);
        if (transcript) {
          relationshipStore.updateTranscript(dbMsg.id, transcript);
          console.log(`[relationship-transcribe] Transcribed: "${transcript.slice(0, 60)}..."`);
          success++;
        } else {
          failed++;
        }
      } catch (err: any) {
        console.log(`[relationship-transcribe] Failed ${dbMsg.id}: ${err?.message || err}`);
        failed++;
      }
    }

    console.log(`[relationship-transcribe] Done: ${success} transcribed, ${failed} failed out of ${untranscribed.length}.`);
    return success;
  };

  // Send a WhatsApp message to Hope's chat
  const relationshipSendUpdate = async (message: string): Promise<void> => {
    const chat = await whatsapp.getChatByName(config.relationshipChatName);
    if (!chat) throw new Error(`Chat "${config.relationshipChatName}" not found`);
    await chat.sendMessage(message);
    console.log(`[relationship-update] Sent update to "${config.relationshipChatName}"`);
  };

  appRouters.push({
    path: "/api/relationship",
    router: createRelationshipRouter(relationshipStore, relationshipAnalyze, relationshipBackfill, relationshipTranscribe, relationshipSendUpdate, relationshipAnalyzeProgress),
    authLevel: "auth",
  });

  // Recording app: transcribe in-person conversations and import to relationship store
  appRouters.push({
    path: "/api/recording",
    router: createRecordingRouter(relationshipStore),
  });

  // Metacrisis app: capture group messages, summarize, push to announcement channel
  const metacrisisStore = new MetacrisisStore();
  console.log("Metacrisis store initialized.");

  const metacrisisHandler = createMetacrisisHandler(metacrisisStore);
  whatsapp.addRawMessageListener(metacrisisHandler);

  const pushToWhatsApp = async (date: string) => {
    const summary = metacrisisStore.getSummary(date, "weekly");
    if (!summary) throw new Error("No weekly summary for " + date);
    const topics = JSON.parse(summary.key_topics_json || "[]");
    const template = metacrisisStore.getSetting("format_template") || "{{summary}}";
    const formatted = formatSummaryForWhatsApp(summary.summary, topics, date, template);

    const chat = await whatsapp.getChatByName(config.metacrisisAnnouncementChat);
    if (!chat) throw new Error(`Chat "${config.metacrisisAnnouncementChat}" not found`);
    await chat.sendMessage(formatted);
    console.log(`[metacrisis] Pushed summary for ${date} to ${config.metacrisisAnnouncementChat}`);
  };

  const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;
  const metacrisisBackfill = async (): Promise<number> => {
    const chat = await whatsapp.getChatByName(config.metacrisisChatName);
    if (!chat) throw new Error(`Chat "${config.metacrisisChatName}" not found. Is WhatsApp connected?`);

    const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
    console.log(`[metacrisis-backfill] Fetching messages from "${chat.name}" (last 2 weeks)...`);
    const messages = await chat.fetchMessages({ limit: 5000 });

    let saved = 0;
    for (const msg of messages) {
      if (msg.timestamp < twoWeeksAgo) continue;
      if (!msg.body || msg.body.trim() === "") continue;
      if (metacrisisStore.isDuplicate(msg.id._serialized)) continue;

      let senderName = "";
      try {
        const contact = await msg.getContact();
        senderName = contact?.pushname || contact?.name || (msg as any).author || "";
      } catch {
        senderName = (msg as any).author || "";
      }

      metacrisisStore.saveMessage({
        id: msg.id._serialized,
        sender: (msg as any).author || msg.from,
        sender_name: senderName,
        body: msg.body,
        timestamp: msg.timestamp,
      });
      saved++;

      // Extract links
      const urls = msg.body.match(URL_REGEX);
      if (urls) {
        for (const url of urls) {
          metacrisisStore.saveLink({
            url,
            category: categorizeUrl(url),
            sender_name: senderName,
            message_id: msg.id._serialized,
            timestamp: msg.timestamp,
          });
        }
      }
    }

    console.log(`[metacrisis-backfill] Imported ${saved} messages from last 2 weeks.`);
    return saved;
  };

  const sendRawToAnnouncement = async (message: string) => {
    const chat = await whatsapp.getChatByName(config.metacrisisAnnouncementChat);
    if (!chat) throw new Error(`Chat "${config.metacrisisAnnouncementChat}" not found`);
    await chat.sendMessage(message);
    console.log(`[metacrisis] Pushed composed message to ${config.metacrisisAnnouncementChat}`);
  };

  const sendRawToCommunity = async (message: string) => {
    const chat = await whatsapp.getChatByName(config.metacrisisChatName);
    if (!chat) throw new Error(`Chat "${config.metacrisisChatName}" not found`);
    await chat.sendMessage(message);
    console.log(`[metacrisis] Pushed message to ${config.metacrisisChatName}`);
  };

  const sendRawToAdjacentEvents = async (message: string) => {
    const chat = await whatsapp.getChatByName(config.metacrisisAdjacentEventsChat);
    if (!chat) throw new Error(`Chat "${config.metacrisisAdjacentEventsChat}" not found`);
    await chat.sendMessage(message);
    console.log(`[metacrisis] Pushed message to ${config.metacrisisAdjacentEventsChat}`);
  };

  appRouters.push({
    path: "/api/metacrisis",
    router: createMetacrisisRouter(
      metacrisisStore,
      () => runWeeklySummary(metacrisisStore),
      () => runDailyDigest(metacrisisStore),
      pushToWhatsApp,
      metacrisisBackfill,
      () => processEventLinks(metacrisisStore),
      (metacrisisHandler as any).getDiagnostics,
      sendRawToAnnouncement,
      sendRawToCommunity,
      sendRawToAdjacentEvents
    ),
  });

  // Auto-scrape any unscraped links on startup (picks up new links + retries failures)
  scrapeLinksMeta(metacrisisStore).then((n) => {
    if (n > 0) console.log(`[metacrisis] Startup scrape: ${n} links scraped.`);
  }).catch((err) => console.error(`[metacrisis] Startup scrape failed:`, err?.message || err));

  // Friends/Network app: monitor private chats + small groups, track interaction frequency
  const friendsStore = new FriendsStore();
  console.log("Friends store initialized.");

  whatsapp.addRawMessageListener(createFriendsHandler(friendsStore));

  const friendsSendProgress: SendProgress = {
    active: false,
    phase: "idle",
    total: 0,
    sent: 0,
    failed: 0,
  };

  const friendsScan = async (): Promise<number> => {
    const allChats = await whatsapp.getClient().getChats();
    let count = 0;
    for (const chat of allChats) {
      const isPrivate = !chat.isGroup;
      const participants = (chat as any).participants;
      const participantCount = participants ? participants.length : 1;
      const isSmallGroup = chat.isGroup && participantCount >= 2 && participantCount <= 6;

      if (!isPrivate && !isSmallGroup) continue;
      // Skip the relationship chat
      if (isPrivate && chat.name.toLowerCase().includes(config.relationshipChatName.toLowerCase())) continue;

      const chatId = chat.id._serialized;
      friendsStore.upsertChat(chatId, chat.name, chat.isGroup, participantCount);
      count++;
    }
    console.log(`[friends-scan] Found ${count} private chats and small groups.`);
    return count;
  };

  const friendsBackfill = async (): Promise<number> => {
    const monitoredChats = friendsStore.getChats().filter(c => c.monitored);
    console.log(`[friends-backfill] Backfilling ${monitoredChats.length} monitored chats...`);

    let totalSaved = 0;
    const allChats = await whatsapp.getClient().getChats();

    for (const chatInfo of monitoredChats) {
      try {
        const chat = allChats.find((c: any) => c.id._serialized === chatInfo.chat_id);
        if (!chat) {
          console.log(`[friends-backfill] Chat "${chatInfo.chat_name}" not found, skipping`);
          continue;
        }

        const messages = await chat.fetchMessages({ limit: 500 });
        let saved = 0;
        // Track which contacts in this chat already have tags (skip buffer for them)
        const contactsWithTags = new Set<string>();
        for (const msg of messages) {
          const isDupe = friendsStore.isDuplicate(msg.id._serialized);
          if (!msg.body && !msg.hasMedia) continue;

          const senderId = msg.fromMe ? "self" : ((msg as any).author || chat.id._serialized);
          const msgType = (msg as any).type || "text";

          // Always buffer for tag extraction if contact has no tags yet
          if (!isDupe || !contactsWithTags.has(senderId)) {
            if (senderId !== "self" && msg.body && msg.body.trim().length > 3 && msgType === "chat") {
              // Check once per contact if they already have tags
              if (!contactsWithTags.has(senderId)) {
                const existingTags = friendsStore.getContactTags(senderId);
                if (existingTags.length > 0) {
                  contactsWithTags.add(senderId);
                }
              }
              if (!contactsWithTags.has(senderId)) {
                friendsStore.addToTagBuffer(senderId, msg.body, msg.timestamp);
              }
            }
          }

          if (isDupe) continue;

          let senderName = "";
          if (!msg.fromMe) {
            try {
              const contact = await msg.getContact();
              senderName = contact?.pushname || contact?.name || "";
            } catch { senderName = ""; }
            friendsStore.upsertContact(senderId, senderName, msg.timestamp);
          }

          friendsStore.saveMessage({
            id: msg.id._serialized,
            chat_id: chatInfo.chat_id,
            sender_id: senderId,
            sender_name: senderName,
            timestamp: msg.timestamp,
            is_from_me: msg.fromMe,
            message_type: msgType,
            char_count: msg.body?.length || 0,
            body: msg.body || "",
          });

          saved++;
        }
        if (saved > 0) {
          console.log(`[friends-backfill] "${chatInfo.chat_name}": ${saved} messages`);
        }
        totalSaved += saved;
      } catch (err: any) {
        console.error(`[friends-backfill] Error on "${chatInfo.chat_name}":`, err?.message || err);
      }
    }

    console.log(`[friends-backfill] Done! ${totalSaved} messages imported.`);
    return totalSaved;
  };

  const friendsSendMessage = async (
    contactIds: string[],
    message: string,
    media: { base64: string; mimetype: string; filename: string } | null
  ): Promise<void> => {
    friendsSendProgress.active = true;
    friendsSendProgress.phase = "sending";
    friendsSendProgress.total = contactIds.length;
    friendsSendProgress.sent = 0;
    friendsSendProgress.failed = 0;
    friendsSendProgress.errorMessage = undefined;

    if (!whatsapp.isConnected()) {
      console.error("[friends-send] WhatsApp client not connected");
      friendsSendProgress.failed = contactIds.length;
      friendsSendProgress.errorMessage = "WhatsApp client not connected. Check server logs.";
      markProgressError(friendsSendProgress, new Error("WhatsApp not connected"));
      return;
    }

    const allChats = await whatsapp.getClient().getChats();
    const { MessageMedia } = await import("whatsapp-web.js");

    for (const contactId of contactIds) {
      try {
        const chat = allChats.find((c: any) => c.id._serialized === contactId);
        if (!chat) {
          console.log(`[friends-send] Chat not found for ${contactId}, skipping`);
          friendsSendProgress.failed++;
          friendsSendProgress.errorMessage = `Chat not found for ${contactId}`;
          continue;
        }

        if (media) {
          const mediaObj = new MessageMedia(media.mimetype, media.base64, media.filename);
          await chat.sendMessage(mediaObj, { caption: message });
        } else {
          await chat.sendMessage(message);
        }

        friendsSendProgress.sent++;
        console.log(`[friends-send] Sent to "${chat.name}" (${friendsSendProgress.sent}/${friendsSendProgress.total})`);

        // Small delay between sends to avoid rate-limiting
        await new Promise(r => setTimeout(r, 2000));
      } catch (err: any) {
        console.error(`[friends-send] Failed for ${contactId}:`, err?.message || err);
        friendsSendProgress.failed++;
        friendsSendProgress.errorMessage = err?.message || "Send failed";
      }
    }

    if (friendsSendProgress.failed > 0 && friendsSendProgress.sent === 0) {
      markProgressError(friendsSendProgress, new Error(friendsSendProgress.errorMessage || "All sends failed"));
    } else {
      markProgressDone(friendsSendProgress);
    }
  };

  const friendsTagExtract = async () => {
    // First try buffer-based extraction (for new real-time messages)
    let count = await runTagExtraction(friendsStore);
    // Then directly tag any remaining untagged contacts via WhatsApp
    const getChats = () => whatsapp.getClient().getChats();
    count += await runDirectTagExtraction(friendsStore, getChats);
    return count;
  };

  const friendsTagConsolidate = () => runTagConsolidation(friendsStore);

  // Auto-run tag extraction every 30 minutes
  setInterval(async () => {
    try {
      const count = await runTagExtraction(friendsStore);
      if (count > 0) console.log(`[auto-tagger] Extracted tags for ${count} contact(s).`);
    } catch (err: any) {
      console.error("[auto-tagger] Failed:", err?.message || err);
    }
  }, 30 * 60 * 1000);

  const friendsFetchHistory = async (contactId: string): Promise<number> => {
    const allChats = await whatsapp.getClient().getChats();
    const chat = allChats.find((c: any) => c.id._serialized === contactId);
    if (!chat) return 0;

    const messages = await chat.fetchMessages({ limit: 500 });
    let updated = 0;
    for (const msg of messages) {
      if (!msg.body) continue;
      const exists = friendsStore.isDuplicate(msg.id._serialized);
      if (exists) {
        // Update body for existing messages that have empty bodies
        friendsStore.updateMessageBody(msg.id._serialized, msg.body);
        updated++;
      } else {
        // Save new messages we didn't have
        const senderId = msg.fromMe ? "self" : ((msg as any).author || chat.id._serialized);
        let senderName = "";
        if (!msg.fromMe) {
          try {
            const contact = await msg.getContact();
            senderName = contact?.pushname || contact?.name || "";
          } catch { senderName = ""; }
          friendsStore.upsertContact(senderId, senderName, msg.timestamp);
        }
        friendsStore.saveMessage({
          id: msg.id._serialized,
          chat_id: contactId,
          sender_id: senderId,
          sender_name: senderName,
          timestamp: msg.timestamp,
          is_from_me: msg.fromMe,
          message_type: (msg as any).type || "text",
          char_count: msg.body?.length || 0,
          body: msg.body || "",
        });
        updated++;
      }
    }
    return updated;
  };

  appRouters.push({
    path: "/api/friends",
    router: createFriendsRouter(friendsStore, friendsScan, friendsBackfill, friendsSendMessage, friendsSendProgress, friendsTagExtract, friendsFetchHistory, friendsTagConsolidate),
  });

  appRouters.push({
    path: "/api/calls",
    router: createCallsRouter(friendsStore),
  });

  startServer({
    store,
    statusChecker: () => ({ whatsappConnected: whatsapp.isConnected() }),
    qrCodeGetter: () => whatsapp.getQrCode(),
    backfillTrigger: runBackfill,
    backfillProgressGetter: () => backfillProgress,
    idbInspect: () => whatsapp.inspectIndexedDB(),
    idbClean: (opts) => whatsapp.cleanIndexedDB(opts),
    appRouters,
  });

  // WhatsApp + Gemini are optional — skip if no API key
  if (!config.geminiApiKey) {
    console.log(
      "\nNo GEMINI_API_KEY set. Running in web-only mode." +
      "\nAdd your key to .env and restart to enable WhatsApp scanning." +
      "\nYou can seed sample events at: POST http://localhost:" + config.port + "/api/seed\n"
    );
    return;
  }

  whatsapp.setFlushHandler(async (messages: BufferedMessage[]) => {
    await processBatch(messages, store);
  });

  whatsapp.setGroupBlockedCheck((chatName: string) => store.isGroupBlocked(chatName));

  // Schedule daily relationship analysis (midnight)
  scheduleDailyTask(config.analysisHour, async () => {
    console.log("[scheduler] Running daily relationship analysis...");
    await relationshipAnalyze();
  });

  // Schedule daily update send to Hope (configurable hour, default 5 PM EST)
  const scheduleUpdateSend = () => {
    const sendHour = parseInt(relationshipStore.getSetting("update_send_hour") || "17", 10);
    const now = new Date();
    const next = new Date(now);
    next.setHours(sendHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    console.log(`[scheduler] Next relationship update send in ${(delay / 3600000).toFixed(1)}h at ${next.toISOString()}`);

    setTimeout(async () => {
      try {
        if (shouldSendUpdate(relationshipStore)) {
          const freq = (relationshipStore.getSetting("update_frequency") || "daily") as "daily" | "weekly";
          const message = await buildUpdateMessage(relationshipStore, freq);
          if (message) {
            await relationshipSendUpdate(message);
            relationshipStore.setSetting("update_last_sent", new Date().toISOString());
            console.log(`[scheduler] Sent ${freq} relationship update to Hope.`);
          }
        }
      } catch (err: any) {
        console.error(`[scheduler] Failed to send relationship update:`, err?.message || err);
      }
      scheduleUpdateSend(); // reschedule, re-reading the hour from settings
    }, delay);
  };
  scheduleUpdateSend();

  // Schedule metacrisis daily digest at 9AM
  scheduleDailyTask(9, async () => {
    console.log("[scheduler] Running metacrisis daily digest...");
    await runDailyDigest(metacrisisStore);
  });

  // Schedule metacrisis weekly summary (Sunday at midnight)
  scheduleWeeklyTask(0, 0, async () => {
    console.log("[scheduler] Running metacrisis weekly summary...");
    await runWeeklySummary(metacrisisStore);
  });

  // Schedule weekly cache cleanup (Sunday at 3 AM)
  scheduleWeeklyTask(0, 3, async () => {
    console.log("[cleanup] Running weekly cache cleanup...");
    const cacheDirNames = ["Cache", "Code Cache", "GPUCache", "Service Worker", "blob_storage", "Session Storage", "WebStorage"];
    let cleared = 0;
    try {
      const sessionDirs = fs.readdirSync(config.authDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith("session"));
      for (const sessionDir of sessionDirs) {
        const defPath = path.join(config.authDir, sessionDir.name, "Default");
        if (!fs.existsSync(defPath)) continue;
        for (const sub of cacheDirNames) {
          const cacheDir = path.join(defPath, sub);
          if (fs.existsSync(cacheDir)) {
            try {
              const stat = fs.statSync(cacheDir);
              fs.rmSync(cacheDir, { recursive: true, force: true });
              cleared++;
            } catch { /* skip locked dirs */ }
          }
        }
      }
    } catch (err: any) {
      console.error("[cleanup] Cache scan failed:", err?.message || err);
    }

    // Vacuum database
    try {
      store.vacuum();
      console.log("[cleanup] Database vacuumed.");
    } catch (err: any) {
      console.error("[cleanup] Vacuum failed:", err?.message || err);
    }

    console.log(`[cleanup] Cleared ${cleared} cache directories.`);
  });

  // ── Hourly tag extraction for friends ──
  setInterval(async () => {
    try {
      const count = await friendsTagExtract();
      if (count > 0) console.log(`[tagger] Extracted tags for ${count} contacts.`);
    } catch (err: any) {
      console.error("[tagger] Hourly extraction failed:", err?.message || err);
    }
  }, 60 * 60 * 1000); // every hour

  // ── Real-time relationship auto-analysis ──
  // Every 30 minutes, reset today's analyzed flags and re-analyze
  // so the dashboard reflects the latest messages throughout the day.
  const AUTO_ANALYZE_INTERVAL = 30 * 60 * 1000; // 30 minutes
  setInterval(async () => {
    if (relationshipAnalyzeProgress.active) {
      console.log("[auto-analyze] Analysis already in progress, skipping.");
      return;
    }

    // Reset today's messages so re-analysis includes new ones
    const resetCount = relationshipStore.resetTodayAnalyzedFlags();
    const unanalyzedCount = relationshipStore.getUnanalyzedCount();

    if (unanalyzedCount === 0) return; // Nothing to analyze

    console.log(`[auto-analyze] ${unanalyzedCount} unanalyzed messages (${resetCount} from today reset). Starting auto-analysis...`);
    try {
      await relationshipAnalyze();
      console.log("[auto-analyze] Auto-analysis complete.");
    } catch (err: any) {
      console.error("[auto-analyze] Failed:", err?.message || err);
    }
  }, AUTO_ANALYZE_INTERVAL);

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

// ── Daily task scheduler ──

function scheduleDailyTask(hour: number, task: () => Promise<void>) {
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    console.log(`[scheduler] Next daily task in ${(delay / 3600000).toFixed(1)}h at ${next.toISOString()}`);

    setTimeout(async () => {
      try {
        await task();
      } catch (err) {
        console.error("[scheduler] Daily task failed:", err);
      }
      schedule(); // reschedule for next day
    }, delay);
  };

  schedule();
}

function scheduleWeeklyTask(dayOfWeek: number, hour: number, task: () => Promise<void>) {
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);

    // Advance to the next occurrence of the target day
    const daysUntil = (dayOfWeek - now.getDay() + 7) % 7;
    if (daysUntil === 0 && next <= now) {
      next.setDate(next.getDate() + 7);
    } else {
      next.setDate(next.getDate() + daysUntil);
    }

    const delay = next.getTime() - now.getTime();
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    console.log(`[scheduler] Next weekly task (${days[dayOfWeek]}) in ${(delay / 86400000).toFixed(1)}d at ${next.toISOString()}`);

    setTimeout(async () => {
      try {
        await task();
      } catch (err) {
        console.error("[scheduler] Weekly task failed:", err);
      }
      schedule(); // reschedule for next week
    }, delay);
  };

  schedule();
}
