import { execFile } from "child_process";
import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import Database from "better-sqlite3-multiple-ciphers";
import { config } from "./config";
import { Identity } from "./identity";
import { extractLinks } from "./links";
import { log } from "./log";
import { Attachment, Quote, SELF, SignalStore, groupChatId } from "./store";
import { joinNames, replaceMentions } from "./text";

// Signal Desktop's database key is encrypted with Electron safeStorage, whose password lives
// in the macOS Keychain under this service name.
const KEYCHAIN_SERVICE = "Signal Safe Storage";
const LAST_ROWID = "desktop_last_rowid";
const BATCH_SIZE = 500;
// Each sync re-reads this many of the latest messages to pick up edits, deletions and reactions.
const RESCAN_RECENT = 2000;
const VOICE_MESSAGE_FLAG = 1;
const execFileAsync = promisify(execFile);

export interface SyncResult {
  imported: number;
  chats: number;
  full: boolean;
}

interface ConversationInfo {
  chatId: string;
  title: string;
  isGroup: boolean;
  groupId?: string;
  groupName?: string | null;
  included: boolean;
}

/** Decrypt a value Electron's safeStorage encrypted on macOS (Chromium's os_crypt, "v10"). */
export function decryptSafeStorage(encrypted: Buffer, password: string): string {
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix !== "v10") throw new Error(`Unsupported Signal Desktop key format "${prefix}".`);
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  try {
    return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Couldn't decrypt Signal Desktop's database key (wrong Keychain password?).");
  }
}

async function keychainPassword(): Promise<string> {
  if (process.env.SIGNAL_DESKTOP_KEYCHAIN_PASSWORD) return process.env.SIGNAL_DESKTOP_KEYCHAIN_PASSWORD;
  if (process.platform !== "darwin") {
    throw new Error("Reading Signal Desktop's encrypted database key is only supported on macOS.");
  }
  try {
    // Async so the MCP server stays responsive while macOS asks for permission.
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE], {
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    throw new Error(
      `Couldn't read "${KEYCHAIN_SERVICE}" from the macOS Keychain. Click "Allow" when macOS asks, then try again.`
    );
  }
}

/** The SQLCipher key (64 hex chars) for Signal Desktop's database. */
export async function readDesktopKey(dir: string): Promise<string> {
  const configPath = path.join(dir, "config.json");
  let userConfig: any;
  try {
    userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err: any) {
    throw new Error(`Couldn't read ${configPath} (${err.code || err.message}). Is Signal Desktop set up on this computer?`);
  }
  const key =
    typeof userConfig.encryptedKey === "string"
      ? decryptSafeStorage(Buffer.from(userConfig.encryptedKey, "hex"), await keychainPassword())
      : userConfig.key;
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error(`No usable database key found in ${configPath}.`);
  }
  return key;
}

/**
 * Decrypt an attachment Signal Desktop stores encrypted at rest (version 2):
 * IV (16) | AES-256-CBC ciphertext | HMAC-SHA256 (32), keyed by the 64-byte localKey.
 */
export function decryptAttachment(data: Buffer, localKey: string, size?: number | null): Buffer {
  const keys = Buffer.from(localKey, "base64");
  if (keys.length !== 64) throw new Error("Invalid attachment key.");
  if (data.length < 64) throw new Error("Attachment file is truncated.");
  const macStart = data.length - 32;
  const ourMac = createHmac("sha256", keys.subarray(32)).update(data.subarray(0, macStart)).digest();
  if (!timingSafeEqual(ourMac, data.subarray(macStart))) throw new Error("Attachment failed its integrity check.");
  const decipher = createDecipheriv("aes-256-cbc", keys.subarray(0, 32), data.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(data.subarray(16, macStart)), decipher.final()]);
  // Signal pads attachments; `size` is the real length.
  return size != null && size >= 0 && size < plain.length ? plain.subarray(0, size) : plain;
}

/**
 * Reads Signal Desktop's local (SQLCipher-encrypted) database, read-only, and copies its
 * conversations, messages, attachments metadata, reactions and links into the archive.
 * Rows are never removed from the archive, so it keeps history Desktop later drops.
 */
export class SignalDesktopSource {
  private key: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SyncResult> | null = null;
  // Set when the key can't be read, so background syncs don't re-prompt every few minutes.
  private keyUnavailable = false;
  lastSync: { at: number; result?: SyncResult; error?: string } | null = null;

  constructor(private store: SignalStore, private identity: Identity, readonly dir = config.desktop.dir) {}

  static isInstalled(dir = config.desktop.dir): boolean {
    return fs.existsSync(path.join(dir, "sql", "db.sqlite"));
  }

  get attachmentsDir(): string {
    return path.join(this.dir, "attachments.noindex");
  }

  start() {
    // Background syncs record failures in lastSync (shown by get_status) rather than throwing.
    const background = () => (this.keyUnavailable ? Promise.resolve() : this.sync().catch(() => {}));
    setImmediate(background);
    this.timer = setInterval(background, config.desktop.syncIntervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Import new (or, with full, all) messages. Concurrent calls share one run. */
  sync(opts: { full?: boolean } = {}): Promise<SyncResult> {
    if (!this.running) {
      this.running = this.run(Boolean(opts.full))
        .then((result) => {
          this.lastSync = { at: Date.now(), result };
          if (result.imported) log(`Imported ${result.imported} message(s) from Signal Desktop`);
          return result;
        })
        .catch((err) => {
          this.lastSync = { at: Date.now(), error: err?.message || String(err) };
          log("Signal Desktop sync failed:", err?.message || err);
          throw err;
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  /** Read an attachment file from Desktop's folder, decrypting it if needed. */
  readAttachment(a: Attachment): Buffer {
    if (!a.desktopPath) throw new Error("This attachment has no Signal Desktop file.");
    const file = path.resolve(this.attachmentsDir, a.desktopPath);
    if (!file.startsWith(path.resolve(this.attachmentsDir) + path.sep)) throw new Error("Invalid attachment path.");
    if (!fs.existsSync(file)) {
      throw new Error("This file isn't in Signal Desktop any more (it may not have been downloaded, or was deleted).");
    }
    const data = fs.readFileSync(file);
    return a.version === 2 && a.localKey ? decryptAttachment(data, a.localKey, a.size) : data;
  }

  private async open(): Promise<Database.Database> {
    if (!this.key) {
      try {
        this.key = await readDesktopKey(this.dir);
        this.keyUnavailable = false;
      } catch (err: any) {
        this.keyUnavailable = true;
        throw new Error(`${err.message} Automatic imports are paused; run sync_signal_desktop to try again.`);
      }
    }
    const db = new Database(path.join(this.dir, "sql", "db.sqlite"), { readonly: true, fileMustExist: true });
    try {
      db.pragma("cipher = 'sqlcipher'");
      db.pragma("legacy = 4");
      db.pragma(`key = "x'${this.key}'"`);
      db.prepare("SELECT count(*) FROM sqlite_master").get();
    } catch (err: any) {
      db.close();
      this.key = null;
      throw new Error(`Couldn't open Signal Desktop's database (${err.code || err.message}).`);
    }
    return db;
  }

  private async run(full: boolean): Promise<SyncResult> {
    const db = await this.open();
    try {
      this.readSelf(db);
      const conversations = this.syncConversations(db);

      // Changing which chats are imported means re-reading history for newly included ones.
      const filterKey = config.desktop.chats.join("\n");
      if ((this.store.getMeta("desktop_chats_filter") ?? "") !== filterKey) {
        full = true;
        this.store.setMeta("desktop_chats_filter", filterKey);
      }

      const maxRowid = (db.prepare("SELECT MAX(rowid) AS m FROM messages").get() as { m: number | null }).m ?? 0;
      const previousLastRowid = Number(this.store.getMeta(LAST_ROWID) ?? 0);
      let lastRowid = full ? 0 : previousLastRowid;
      if (lastRowid > maxRowid) lastRowid = 0; // Desktop was re-linked and started a fresh database
      const hasAttachmentTable = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments'").get()
      );

      let imported = 0;
      const importRange = async (from: number, to: number, isNew: boolean) => {
        for (let after = from; after < to; ) {
          const rows = db
            .prepare("SELECT * FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?")
            .all(after, to, BATCH_SIZE) as any[];
          if (rows.length === 0) break;
          const attachments = hasAttachmentTable ? this.attachmentRows(db, rows.map((r) => r.id)) : new Map();
          this.store.db.transaction(() => {
            for (const row of rows) {
              const firstTimeSeen = row.rowid > previousLastRowid;
              if (this.importMessage(row, conversations, attachments.get(row.id) ?? [], firstTimeSeen)) imported++;
            }
            if (isNew) this.store.setMeta(LAST_ROWID, String(rows[rows.length - 1].rowid));
          })();
          after = rows[rows.length - 1].rowid;
          await new Promise((resolve) => setImmediate(resolve)); // keep the MCP server responsive
        }
      };

      if (lastRowid > 0) await importRange(Math.max(0, lastRowid - RESCAN_RECENT), lastRowid, false);
      await importRange(lastRowid, maxRowid, true);
      return { imported, chats: [...conversations.values()].filter((c) => c.included).length, full };
    } finally {
      db.close();
    }
  }

  private readSelf(db: Database.Database) {
    const item = (id: string): string | undefined => {
      const row = db.prepare("SELECT json FROM items WHERE id = ?").get(id) as { json: string } | undefined;
      try {
        return row ? String(JSON.parse(row.json).value).split(".")[0] : undefined;
      } catch {
        return undefined;
      }
    };
    this.identity.learn(item("uuid_id"), item("number_id"));
  }

  private syncConversations(db: Database.Database): Map<string, ConversationInfo> {
    const result = new Map<string, ConversationInfo>();
    const rows = db.prepare("SELECT json FROM conversations").all() as Array<{ json: string }>;
    const filter = config.desktop.chats.map((c) => c.toLowerCase());

    this.store.db.transaction(() => {
      for (const { json } of rows) {
        let c: any;
        try {
          c = JSON.parse(json);
        } catch {
          continue;
        }
        let info: ConversationInfo;
        if (c.type === "group" && c.groupId) {
          info = {
            chatId: groupChatId(c.groupId),
            title: c.name || "Unnamed group",
            isGroup: true,
            groupId: c.groupId,
            groupName: c.name || null,
            included: true,
          };
        } else if (c.type === "private") {
          const id = this.identity.idFor(c.serviceId, c.e164);
          if (!id) continue;
          const name =
            joinNames(c.nicknameGivenName, c.nicknameFamilyName) ||
            c.name ||
            joinNames(c.systemGivenName, c.systemFamilyName) ||
            null;
          const profileName = joinNames(c.profileName, c.profileFamilyName);
          if (id !== SELF) {
            this.store.upsertContact(
              { uuid: c.serviceId, number: c.e164, username: c.username, name, profileName, isBlocked: false },
              true
            );
          }
          info = { chatId: id, title: name || profileName || c.e164 || id, isGroup: false, included: true };
        } else {
          continue;
        }
        info.included =
          filter.length === 0 ||
          filter.some((f) => info.title.toLowerCase().includes(f) || info.chatId.toLowerCase() === f);
        result.set(c.id, info);

        if (info.isGroup && info.included && !c.left) {
          this.store.ensureGroupChat(info.groupId!, c.name);
          const members = (c.membersV2 ?? []).map((m: any) => this.identity.idFor(m.aci, null)).filter(Boolean);
          if (members.length) this.store.setGroupMembers(info.groupId!, members);
        }
      }
    })();
    return result;
  }

  private attachmentRows(db: Database.Database, messageIds: string[]): Map<string, any[]> {
    const byMessage = new Map<string, any[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = db
      .prepare(
        `SELECT * FROM message_attachments
         WHERE messageId IN (${messageIds.map(() => "?").join(",")}) AND editHistoryIndex = -1
         ORDER BY orderInMessage`
      )
      .all(...messageIds) as any[];
    for (const row of rows) {
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  }

  /** Returns true if the message was stored. */
  private importMessage(
    row: any,
    conversations: Map<string, ConversationInfo>,
    attachmentRows: any[],
    firstTimeSeen: boolean
  ): boolean {
    const conv = conversations.get(row.conversationId);
    if (!conv?.included) return false;
    if (row.type !== "incoming" && row.type !== "outgoing") return false; // system notices, calls, stories
    if (row.storyId || row.isStory) return false;

    let json: any;
    try {
      json = JSON.parse(row.json);
    } catch {
      return false;
    }

    if (Number(row.expireTimer ?? json.expireTimer) > 0 && !config.archiveDisappearing) {
      if (firstTimeSeen) {
        const skipped = Number(this.store.getMeta("skipped_disappearing") ?? 0) + 1;
        this.store.setMeta("skipped_disappearing", String(skipped));
      }
      return false;
    }

    const senderId =
      row.type === "outgoing"
        ? SELF
        : this.identity.idFor(row.sourceServiceId ?? json.sourceServiceId, row.source ?? json.source);
    const timestamp = Number(row.sent_at ?? json.sent_at ?? row.timestamp);
    if (!senderId || !timestamp) return false;
    if (senderId !== SELF) this.store.upsertContact({ uuid: row.sourceServiceId, number: row.source });

    const deleted = Boolean(json.deletedForEveryone || row.isErased);
    const standard = attachmentRows.filter((a) => a.attachmentType === "attachment");
    const longMessage = attachmentRows.find((a) => a.attachmentType === "long-message");
    const attachments: Attachment[] = (standard.length ? standard : json.attachments ?? []).map((a: any) => ({
      contentType: a.contentType ?? null,
      filename: a.fileName ?? null,
      size: a.size ?? null,
      caption: a.caption ?? null,
      isVoiceNote: Boolean(Number(a.flags) & VOICE_MESSAGE_FLAG),
      desktopPath: a.path ?? null,
      localKey: a.localKey ?? null,
      version: a.version ?? null,
    }));

    const body = deleted ? null : this.describe(row, json, longMessage ?? json.bodyAttachment);
    if (!deleted && !body && attachments.length === 0) return false;

    let quote: Quote | null = null;
    if (json.quote?.id) {
      quote = {
        timestamp: Number(json.quote.id),
        authorId: this.identity.idFor(json.quote.authorAci, json.quote.author),
        text: json.quote.text ?? null,
      };
    }

    if (conv.isGroup) this.store.ensureGroupChat(conv.groupId!, conv.groupName);
    else this.store.ensureDirectChat(conv.chatId);
    const id = this.store.upsertMessage({
      chatId: conv.chatId,
      senderId,
      timestamp,
      isFromMe: senderId === SELF,
      body,
      attachments,
      quote,
      editedAt: json.editHistory?.length > 1 ? Number(json.editMessageTimestamp) || null : null,
      deleted,
    });
    this.store.setLinks(id, deleted ? [] : extractLinks(body, json.preview ?? []));

    // A reaction's fromId is the reactor's own (private) conversation.
    const reactions = [];
    for (const r of json.reactions ?? []) {
      const reactor = conversations.get(r.fromId);
      if (!r.emoji || !reactor || reactor.isGroup) continue;
      reactions.push({ reactorId: reactor.chatId, emoji: r.emoji, timestamp: Number(r.timestamp) || timestamp });
    }
    this.store.replaceReactions(conv.chatId, senderId, timestamp, reactions);
    return true;
  }

  /** Message text with mentions resolved, the full text of long messages, and non-text content summarised. */
  private describe(row: any, json: any, longMessage?: any): string | null {
    let text: string | null = row.body ?? json.body ?? null;
    if (longMessage?.path) {
      try {
        text = this.readAttachment({
          desktopPath: longMessage.path,
          localKey: longMessage.localKey,
          version: longMessage.version,
          size: longMessage.size,
        }).toString("utf8");
      } catch {
        // Fall back to the truncated body Desktop keeps in the row.
      }
    }
    const mentions = (json.bodyRanges ?? []).filter((r: any) => r.mentionAci || r.mentionUuid);
    if (text && mentions.length) {
      text = replaceMentions(
        text,
        mentions.map((r: any) => {
          const id = this.identity.idFor(r.mentionAci ?? r.mentionUuid, null);
          const c = id && id !== SELF ? this.store.getContact(id) : undefined;
          return { start: r.start, length: r.length, name: id === SELF ? "Me" : c?.name || c?.profile_name || "unknown" };
        })
      );
    }

    const parts: string[] = text ? [text] : [];
    if (json.sticker) parts.push("[Sticker]");
    if (json.poll?.question) {
      const options = (json.poll.options ?? []).join(" / ");
      parts.push(`[Poll] ${json.poll.question}${options ? ` — ${options}` : ""}`);
    }
    for (const c of json.contact ?? []) {
      const name = c.name?.displayName || joinNames(c.name?.givenName, c.name?.familyName) || "contact";
      const phone = c.number?.[0]?.value;
      parts.push(`[Shared contact: ${name}${phone ? ` ${phone}` : ""}]`);
    }
    if (json.payment) parts.push("[Payment]");
    return parts.length ? parts.join("\n") : null;
  }
}
