import { Client, LocalAuth, Message } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
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
  private healthTimer: NodeJS.Timeout | null = null;
  private onFlush: FlushCallback | null = null;
  private onReady: ReadyCallback | null = null;
  private isGroupBlocked: ((chatName: string) => boolean) | null = null;
  private ready = false;
  private currentQr: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  private static readonly PUPPETEER_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
  ];

  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: config.authDir }),
      puppeteer: {
        headless: true,
        args: WhatsAppClient.PUPPETEER_ARGS,
      },
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.client.on("qr", (qr) => {
      console.log("\nScan this QR code with your WhatsApp app:\n");
      qrcode.generate(qr, { small: true });
      this.currentQr = qr;
    });

    this.client.on("ready", async () => {
      console.log("WhatsApp client is ready!");
      this.ready = true;
      this.currentQr = null;
      this.reconnectAttempts = 0;
      this.startFlushTimer();
      this.startHealthCheck();
      if (this.onReady) {
        try {
          await this.onReady();
        } catch (err) {
          console.error("[ready] Error in ready handler:", err);
        }
      }
    });

    this.client.on("authenticated", () => {
      console.log("WhatsApp authenticated successfully.");
      this.currentQr = null;
    });

    this.client.on("auth_failure", (msg) => {
      console.error("WhatsApp authentication failed:", msg);
      this.ready = false;
      // Clear auth cache to force re-authentication via QR
      try {
        const entries = fs.readdirSync(config.authDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith("session-")) {
            fs.rmSync(path.join(config.authDir, entry.name), { recursive: true, force: true });
            console.log(`[auth_failure] Cleared stale session: ${entry.name}`);
          }
        }
      } catch {}
      console.log("[auth_failure] Please scan the QR code again.");
    });

    this.client.on("disconnected", async (reason) => {
      console.log(`WhatsApp disconnected: ${reason}`);
      this.ready = false;
      this.stopTimers();

      // For permanent disconnects (user logged out elsewhere), don't retry
      if (reason === "UNPAIRED" || reason === "UNPAIRED_IDLE") {
        console.error("[disconnect] Session unpaired. Requires re-authentication via QR code.");
        return;
      }

      // For transient disconnects, attempt reconnection with backoff
      await this.reconnect();
    });

    // Monitor connection state changes
    this.client.on("change_state", (state) => {
      console.log(`[state] WhatsApp state: ${state}`);
    });

    this.client.on("message", async (msg: Message) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        console.error("[message] Error handling message:", err);
      }
    });
  }

  private async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[reconnect] Max attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 120000); // 5s, 10s, 20s... up to 2min
    console.log(`[reconnect] Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${Math.round(delay / 1000)}s...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      this.cleanChromiumLocks();
      // Destroy old client gracefully
      try { await this.client.destroy(); } catch {}
      // Re-create client
      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: config.authDir }),
        puppeteer: {
          headless: true,
          args: WhatsAppClient.PUPPETEER_ARGS,
        },
      });
      this.setupEventHandlers();
      await this.client.initialize();
    } catch (err) {
      console.error(`[reconnect] Failed:`, err);
      await this.reconnect(); // Retry with next backoff
    }
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
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(async () => {
      if (this.buffer.length > 0) {
        await this.flush();
      }
    }, config.batchIntervalMs);
  }

  private startHealthCheck() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      if (!this.ready) return;
      try {
        const state = await this.client.getState();
        if (!state || state !== "CONNECTED") {
          console.warn(`[health] Unexpected state: ${state}`);
        }
      } catch (err) {
        console.error("[health] Health check failed, client may have crashed:", err);
        this.ready = false;
        this.stopTimers();
        await this.reconnect();
      }
    }, 60000); // Check every 60s
  }

  private stopTimers() {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
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

  async fetchRecentMessages(hours: number = 168, onGroupProgress?: (scanned: number, total: number) => void): Promise<BufferedMessage[]> {
    if (!this.ready) {
      console.log("[backfill] Client not ready, skipping backfill.");
      return [];
    }

    const label = hours >= 24 ? `${(hours / 24).toFixed(1)} days` : `${hours} hours`;
    console.log(`[backfill] Fetching messages from the last ${label}...`);
    const cutoff = Math.floor(Date.now() / 1000) - hours * 60 * 60;
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
    if (onGroupProgress) onGroupProgress(0, groupChats.length);

    let groupIndex = 0;
    for (const chat of groupChats) {
      groupIndex++;
      if (onGroupProgress) onGroupProgress(groupIndex, groupChats.length);
      try {
        // Fetch up to 500 messages per chat
        const messages = await chat.fetchMessages({ limit: 500 });

        // Skip chats with no recent activity
        const hasRecentActivity = messages.some(
          (m) => m.timestamp >= cutoff
        );
        if (!hasRecentActivity) {
          console.log(`[backfill] Skipping "${chat.name}" (no activity in window)`);
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
      } catch (err: any) {
        console.error(`[backfill] Error fetching from "${chat.name}": ${err?.message || err}`);
      }
    }

    console.log(`[backfill] Total: ${allMessages.length} messages from last ${label}.`);
    return allMessages;
  }

  getQrCode(): string | null {
    return this.currentQr;
  }

  private cleanChromiumLocks() {
    // Remove stale Chromium lock files that persist on volumes across container restarts
    const authDir = config.authDir;
    const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
    const searchDirs = [authDir];

    // Also search subdirectories (LocalAuth creates session-* folders)
    try {
      const entries = fs.readdirSync(authDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          searchDirs.push(path.join(authDir, entry.name));
          // Check one level deeper (session-*/Default/)
          try {
            const subEntries = fs.readdirSync(path.join(authDir, entry.name), { withFileTypes: true });
            for (const sub of subEntries) {
              if (sub.isDirectory()) {
                searchDirs.push(path.join(authDir, entry.name, sub.name));
              }
            }
          } catch {}
        }
      }
    } catch {}

    for (const dir of searchDirs) {
      for (const lock of lockFiles) {
        const lockPath = path.join(dir, lock);
        try {
          fs.unlinkSync(lockPath);
          console.log(`[cleanup] Removed stale lock: ${lockPath}`);
        } catch {}
      }
    }
  }

  async start() {
    console.log("Starting WhatsApp client...");
    this.cleanChromiumLocks();
    await this.client.initialize();
  }

  async stop() {
    this.stopTimers();
    // Flush remaining messages
    await this.flush();
    if (this.ready) {
      try {
        await this.client.destroy();
      } catch (err) {
        console.error("[shutdown] Error destroying client:", err);
      }
    }
  }
}
