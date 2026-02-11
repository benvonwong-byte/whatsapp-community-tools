import { Client, LocalAuth, Message } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { config } from "./config";

export interface BufferedMessage {
  id: string;
  chatName: string;
  body: string;
  timestamp: number;
  from: string;
}

type FlushCallback = (messages: BufferedMessage[]) => Promise<void>;
type ReadyCallback = () => Promise<void>;

export class WhatsAppClient {
  private client: Client;
  private buffer: BufferedMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private onFlush: FlushCallback | null = null;
  private onReady: ReadyCallback | null = null;
  private isGroupBlocked: ((chatName: string) => boolean) | null = null;
  private ready = false;

  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: config.authDir }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
        ],
      },
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.client.on("qr", (qr) => {
      console.log("\nScan this QR code with your WhatsApp app:\n");
      qrcode.generate(qr, { small: true });
    });

    this.client.on("ready", async () => {
      console.log("WhatsApp client is ready!");
      this.ready = true;
      this.startFlushTimer();
      if (this.onReady) {
        await this.onReady();
      }
    });

    this.client.on("authenticated", () => {
      console.log("WhatsApp authenticated successfully.");
    });

    this.client.on("auth_failure", (msg) => {
      console.error("WhatsApp authentication failed:", msg);
    });

    this.client.on("disconnected", (reason) => {
      console.log("WhatsApp disconnected:", reason);
      this.ready = false;
    });

    this.client.on("message", async (msg: Message) => {
      await this.handleMessage(msg);
    });
  }

  private async handleMessage(msg: Message) {
    // Skip non-text messages
    if (!msg.body || msg.body.trim() === "") return;

    // Only process group chat messages with >10 participants
    const chat = await msg.getChat();
    if (!chat.isGroup) return;
    const participants = (chat as any).participants;
    if (participants && participants.length <= 10) return;
    if (this.isGroupBlocked && this.isGroupBlocked(chat.name)) return;

    const buffered: BufferedMessage = {
      id: msg.id._serialized,
      chatName: chat.name,
      body: msg.body,
      timestamp: msg.timestamp,
      from: msg.author || msg.from,
    };

    this.buffer.push(buffered);
    console.log(
      `[buffer] +1 from "${chat.name}" (${this.buffer.length} queued)`
    );

    // Flush if we hit the max batch size
    if (this.buffer.length >= config.batchMaxMessages) {
      await this.flush();
    }
  }

  private startFlushTimer() {
    this.flushTimer = setInterval(async () => {
      if (this.buffer.length > 0) {
        await this.flush();
      }
    }, config.batchIntervalMs);
  }

  private async flush() {
    if (this.buffer.length === 0 || !this.onFlush) return;

    const batch = [...this.buffer];
    this.buffer = [];

    console.log(`[flush] Processing batch of ${batch.length} messages...`);

    try {
      await this.onFlush(batch);
    } catch (err) {
      console.error("[flush] Error processing batch:", err);
    }
  }

  setFlushHandler(handler: FlushCallback) {
    this.onFlush = handler;
  }

  setReadyHandler(handler: ReadyCallback) {
    this.onReady = handler;
  }

  setGroupBlockedCheck(check: (chatName: string) => boolean) {
    this.isGroupBlocked = check;
  }

  isConnected(): boolean {
    return this.ready;
  }

  async fetchRecentMessages(days: number = 7): Promise<BufferedMessage[]> {
    if (!this.ready) {
      console.log("[backfill] Client not ready, skipping backfill.");
      return [];
    }

    console.log(`[backfill] Fetching messages from the last ${days} days...`);
    const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const allMessages: BufferedMessage[] = [];

    const chats = await this.client.getChats();
    const groupChats = chats.filter((c) => {
      if (!c.isGroup) return false;
      const participants = (c as any).participants;
      if (participants && participants.length <= 10) return false;
      if (this.isGroupBlocked && this.isGroupBlocked(c.name)) return false;
      return true;
    });
    console.log(`[backfill] Found ${groupChats.length} group chats (>10 members).`);

    for (const chat of groupChats) {
      try {
        // Fetch up to 500 messages per chat
        const messages = await chat.fetchMessages({ limit: 500 });

        // Skip chats with no recent activity
        const hasRecentActivity = messages.some(
          (m) => m.timestamp >= cutoff
        );
        if (!hasRecentActivity) {
          console.log(`[backfill] Skipping "${chat.name}" (no activity in last ${days} days)`);
          continue;
        }

        let count = 0;

        for (const msg of messages) {
          if (!msg.body || msg.body.trim() === "") continue;
          if (msg.timestamp < cutoff) continue;

          allMessages.push({
            id: msg.id._serialized,
            chatName: chat.name,
            body: msg.body,
            timestamp: msg.timestamp,
            from: msg.author || msg.from,
          });
          count++;
        }

        if (count > 0) {
          console.log(`[backfill] "${chat.name}": ${count} messages`);
        }
      } catch (err) {
        console.error(`[backfill] Error fetching from "${chat.name}":`, err);
      }
    }

    console.log(`[backfill] Total: ${allMessages.length} messages from ${days} days.`);
    return allMessages;
  }

  async start() {
    console.log("Starting WhatsApp client...");
    await this.client.initialize();
  }

  async stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    // Flush remaining messages
    await this.flush();
    if (this.ready) {
      await this.client.destroy();
    }
  }
}
