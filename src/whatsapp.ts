import { Client, LocalAuth, Message } from "whatsapp-web.js";
export { Message } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { config } from "./config";

export type RawMessageListener = (msg: Message, chat: any) => Promise<void>;

export interface BufferedMessage {
  id: string;
  chatName: string;
  body: string;
  timestamp: number;
  from: string;
}

type FlushCallback = (messages: BufferedMessage[]) => Promise<void>;
type ReadyCallback = () => Promise<void>;

function isAllowedPrivateChat(chatName: string): boolean {
  const lower = chatName.toLowerCase();
  return config.allowedPrivateChats.some((name) => lower.includes(name));
}

export class WhatsAppClient {
  private client: Client;
  private buffer: BufferedMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private onFlush: FlushCallback | null = null;
  private onReady: ReadyCallback | null = null;
  private isGroupBlocked: ((chatName: string) => boolean) | null = null;
  private rawListeners: RawMessageListener[] = [];
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
    "--js-flags=--max-old-space-size=256",
    "--disable-features=TranslateUI",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
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

    // message_create fires for BOTH incoming AND outgoing messages
    // Raw listeners (relationship, friends, metacrisis) need outgoing messages too
    this.client.on("message_create", async (msg: Message) => {
      try {
        const chat = await msg.getChat();

        // Notify raw listeners (new apps) — each decides its own filtering
        for (const listener of this.rawListeners) {
          try {
            await listener(msg, chat);
          } catch (err) {
            console.error("[message_create] Error in raw listener:", err);
          }
        }

        // Existing event scraper only cares about incoming messages
        if (!msg.fromMe) {
          await this.handleMessage(msg, chat);
        }
      } catch (err) {
        console.error("[message_create] Error handling message:", err);
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

  private async handleMessage(msg: Message, preloadedChat?: any) {
    // Skip non-text messages
    if (!msg.body || msg.body.trim() === "") return;

    // Process group chats with >10 participants, plus allowed private chats
    const chat = preloadedChat || await msg.getChat();
    if (!chat.isGroup && (!chat.name || !isAllowedPrivateChat(chat.name))) return;
    if (chat.isGroup) {
      const participants = (chat as any).participants;
      if (participants && participants.length <= 10) return;
      if (this.isGroupBlocked && this.isGroupBlocked(chat.name)) return;
    }

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

  addRawMessageListener(listener: RawMessageListener) {
    this.rawListeners.push(listener);
  }

  isConnected(): boolean {
    return this.ready;
  }

  getClient(): Client {
    return this.client;
  }

  async getChatByName(name: string): Promise<any | null> {
    if (!this.ready) return null;
    const chats = await this.client.getChats();
    const lower = name.toLowerCase();
    return chats.find(c => c.name?.toLowerCase().includes(lower)) || null;
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
    let blockedCount = 0;
    const monitoredChats = chats.filter((c) => {
      if (!c.name) return false;
      if (isAllowedPrivateChat(c.name)) return true;
      if (!c.isGroup) return false;
      const participants = (c as any).participants;
      if (participants && participants.length <= 10) return false;
      if (this.isGroupBlocked && this.isGroupBlocked(c.name)) {
        blockedCount++;
        return false;
      }
      return true;
    });
    console.log(`[backfill] Found ${monitoredChats.length} monitored chats${blockedCount > 0 ? `, skipped ${blockedCount} blocked` : ""}.`);
    if (onGroupProgress) onGroupProgress(0, monitoredChats.length);

    let groupIndex = 0;
    for (const chat of monitoredChats) {
      groupIndex++;
      if (onGroupProgress) onGroupProgress(groupIndex, monitoredChats.length);
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

  /**
   * Inspect WhatsApp Web's IndexedDB to understand storage usage.
   * Runs JavaScript inside the Puppeteer page context.
   */
  async inspectIndexedDB(): Promise<any> {
    if (!this.ready) throw new Error("WhatsApp client not connected");
    const page = (this.client as any).pupPage;
    if (!page) throw new Error("No Puppeteer page available");

    return page.evaluate(() => {
      return new Promise((resolve, reject) => {
        const results: any = { databases: [] };
        const idb = (globalThis as any).indexedDB;

        // List all IndexedDB databases
        idb.databases().then(async (dbs: any[]) => {
          results.totalDatabases = dbs.length;

          for (const dbInfo of dbs) {
            const dbName = dbInfo.name || "unknown";
            try {
              const db: any = await new Promise((res, rej) => {
                const req = idb.open(dbName);
                req.onsuccess = () => res(req.result);
                req.onerror = () => rej(req.error);
              });

              const storeNames = Array.from(db.objectStoreNames);
              const stores: any[] = [];

              for (const storeName of storeNames) {
                try {
                  const tx = db.transaction(storeName, "readonly");
                  const store = tx.objectStore(storeName);
                  const count: number = await new Promise((res) => {
                    const req = store.count();
                    req.onsuccess = () => res(req.result);
                    req.onerror = () => res(-1);
                  });

                  // Sample a few records to understand the data shape
                  const sample: any = await new Promise((res) => {
                    const req = store.openCursor();
                    const samples: any[] = [];
                    req.onsuccess = () => {
                      const cursor = req.result;
                      if (cursor && samples.length < 2) {
                        const val = cursor.value;
                        // Estimate record size and collect field names
                        let sampleInfo: any = { type: typeof val };
                        if (val && typeof val === "object") {
                          const keys = Object.keys(val);
                          sampleInfo.fields = keys;
                          // Check for media/thumbnail fields
                          const mediaFields = keys.filter(k =>
                            /thumb|media|image|blob|data|body|preview/i.test(k)
                          );
                          sampleInfo.mediaFields = mediaFields;
                          // Estimate size of this record
                          try {
                            const json = JSON.stringify(val);
                            sampleInfo.sizeBytes = json.length;
                          } catch { sampleInfo.sizeBytes = -1; }
                        }
                        samples.push(sampleInfo);
                        cursor.continue();
                      } else {
                        res(samples);
                      }
                    };
                    req.onerror = () => res([]);
                  });

                  stores.push({ name: storeName, count, samples: sample });
                } catch { stores.push({ name: storeName, count: -1, error: "access denied" }); }
              }

              db.close();
              results.databases.push({ name: dbName, version: dbInfo.version, stores });
            } catch (err: any) {
              results.databases.push({ name: dbName, error: err?.message || "failed to open" });
            }
          }

          resolve(results);
        }).catch(reject);
      });
    });
  }

  /**
   * Clean thumbnail/media blob data from WhatsApp Web's IndexedDB.
   * Returns stats about what was cleaned.
   */
  async cleanIndexedDB(options: { dryRun?: boolean } = {}): Promise<any> {
    if (!this.ready) throw new Error("WhatsApp client not connected");
    const page = (this.client as any).pupPage;
    if (!page) throw new Error("No Puppeteer page available");

    const dryRun = options.dryRun ?? true;
    return page.evaluate((dry: boolean) => {
      return new Promise((resolve, reject) => {
        const results: any = { dryRun: dry, cleaned: [], errors: [], totalRecordsProcessed: 0, totalBytesFreed: 0 };
        const idb = (globalThis as any).indexedDB;

        idb.databases().then(async (dbs: any[]) => {
          for (const dbInfo of dbs) {
            const dbName = dbInfo.name || "unknown";
            // Skip non-WhatsApp databases
            if (!dbName.toLowerCase().includes("wawc") && !dbName.toLowerCase().includes("model-storage")) continue;

            try {
              const db: any = await new Promise((res, rej) => {
                const req = idb.open(dbName);
                req.onsuccess = () => res(req.result);
                req.onerror = () => rej(req.error);
              });

              const storeNames: string[] = Array.from(db.objectStoreNames);

              for (const storeName of storeNames) {
                // Target stores that might hold media/thumbnails
                const isMediaStore = /thumb|media|image|blob|sticker|preview/i.test(storeName);
                if (!isMediaStore) continue;

                try {
                  const mode: any = dry ? "readonly" : "readwrite";
                  const tx = db.transaction(storeName, mode);
                  const store = tx.objectStore(storeName);

                  const count: number = await new Promise((res) => {
                    const req = store.count();
                    req.onsuccess = () => res(req.result);
                    req.onerror = () => res(0);
                  });

                  if (count === 0) continue;

                  if (dry) {
                    // Estimate size by sampling
                    let sampleSize = 0;
                    let sampled = 0;
                    await new Promise<void>((res) => {
                      const req = store.openCursor();
                      req.onsuccess = () => {
                        const cursor = req.result;
                        if (cursor && sampled < 10) {
                          try {
                            sampleSize += JSON.stringify(cursor.value).length;
                          } catch {}
                          sampled++;
                          cursor.continue();
                        } else {
                          res();
                        }
                      };
                      req.onerror = () => res();
                    });

                    const avgSize = sampled > 0 ? sampleSize / sampled : 0;
                    const estimatedTotal = Math.round(avgSize * count);
                    results.cleaned.push({
                      db: dbName,
                      store: storeName,
                      records: count,
                      estimatedBytes: estimatedTotal,
                      action: "would clear",
                    });
                    results.totalRecordsProcessed += count;
                    results.totalBytesFreed += estimatedTotal;
                  } else {
                    // Actually clear the store
                    await new Promise<void>((res, rej) => {
                      const req = store.clear();
                      req.onsuccess = () => res();
                      req.onerror = () => rej(req.error);
                    });
                    results.cleaned.push({
                      db: dbName,
                      store: storeName,
                      records: count,
                      action: "cleared",
                    });
                    results.totalRecordsProcessed += count;
                  }
                } catch (err: any) {
                  results.errors.push({ db: dbName, store: storeName, error: err?.message || "failed" });
                }
              }

              db.close();
            } catch (err: any) {
              results.errors.push({ db: dbName, error: err?.message || "failed to open" });
            }
          }

          resolve(results);
        }).catch(reject);
      });
    }, dryRun);
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
