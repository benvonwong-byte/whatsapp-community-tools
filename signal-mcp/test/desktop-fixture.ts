import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// Signal Desktop's own SQLCipher build, so the fixture is encrypted exactly like the real thing.
import SQL from "@signalapp/sqlcipher";

export const KEYCHAIN_PASSWORD = "dGVzdC1rZXljaGFpbi1wYXNzd29yZA==";

/** Electron safeStorage on macOS (Chromium os_crypt "v10"), the inverse of decryptSafeStorage. */
export function encryptSafeStorage(plaintext: string, password: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext, "utf8"), cipher.final()]);
}

/** Signal's attachment format: IV | AES-256-CBC(padded plaintext) | HMAC-SHA256, keys = aes(32) + mac(32). */
export function encryptAttachment(plain: Buffer, keys: Buffer): Buffer {
  const iv = randomBytes(16);
  // Signal pads plaintext with zeros before encrypting; the real size is stored separately.
  const padded = Buffer.concat([plain, Buffer.alloc(64 - (plain.length % 64))]);
  const cipher = createCipheriv("aes-256-cbc", keys.subarray(0, 32), iv);
  const body = Buffer.concat([iv, cipher.update(padded), cipher.final()]);
  const mac = createHmac("sha256", keys.subarray(32)).update(body).digest();
  return Buffer.concat([body, mac]);
}

// The columns signal-mcp reads, named as in Signal Desktop's current schema.
const SCHEMA = `
CREATE TABLE items(id STRING PRIMARY KEY ASC, json TEXT);
CREATE TABLE conversations(
  id STRING PRIMARY KEY ASC, json TEXT, active_at INTEGER, type STRING, members TEXT, name TEXT,
  profileName TEXT, profileFamilyName TEXT, profileFullName TEXT, e164 TEXT, serviceId TEXT, groupId TEXT,
  profileLastFetchedAt INTEGER, expireTimerVersion INTEGER NOT NULL DEFAULT 1);
CREATE TABLE messages(
  rowid INTEGER PRIMARY KEY ASC, id STRING UNIQUE, json TEXT, readStatus INTEGER, expires_at INTEGER,
  sent_at INTEGER, schemaVersion INTEGER, conversationId STRING, received_at INTEGER, source STRING,
  hasAttachments INTEGER, hasFileAttachments INTEGER, hasVisualMediaAttachments INTEGER, expireTimer INTEGER,
  expirationStartTimestamp INTEGER, type STRING, body TEXT, isErased INTEGER, isViewOnce INTEGER,
  sourceServiceId TEXT, serverGuid TEXT, sourceDevice INTEGER, storyId STRING, isStory INTEGER,
  timestamp INTEGER, received_at_ms INTEGER);
CREATE TABLE message_attachments (
  messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, editHistoryIndex INTEGER NOT NULL,
  attachmentType TEXT NOT NULL, orderInMessage INTEGER NOT NULL, conversationId TEXT NOT NULL, sentAt INTEGER NOT NULL,
  clientUuid TEXT, size INTEGER NOT NULL, contentType TEXT NOT NULL, path TEXT, plaintextHash TEXT, localKey TEXT,
  caption TEXT, fileName TEXT, version INTEGER, flags INTEGER,
  PRIMARY KEY (messageId, editHistoryIndex, attachmentType, orderInMessage)) STRICT;
`;

export interface FixtureMessage {
  id: string;
  conversationId: string;
  type: string;
  sent_at: number;
  body?: string | null;
  sourceServiceId?: string | null;
  source?: string | null;
  expireTimer?: number | null;
  storyId?: string | null;
  isErased?: number;
  json?: Record<string, unknown>;
}

/** A fake Signal Desktop profile folder: config.json, sql/db.sqlite and attachments.noindex/. */
export class DesktopFixture {
  readonly db: SQL;
  private dbKey = randomBytes(32).toString("hex");

  constructor(readonly dir: string, self: { aci: string; number: string }, opts: { legacyPlaintextKey?: boolean } = {}) {
    fs.mkdirSync(path.join(dir, "sql"), { recursive: true });
    fs.mkdirSync(path.join(dir, "attachments.noindex"), { recursive: true });
    const userConfig = opts.legacyPlaintextKey
      ? { key: this.dbKey }
      : { encryptedKey: encryptSafeStorage(this.dbKey, KEYCHAIN_PASSWORD).toString("hex") };
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(userConfig));

    this.db = new SQL(path.join(dir, "sql", "db.sqlite"));
    this.db.pragma(`key = "x'${this.dbKey}'"`);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT INTO items (id, json) VALUES (?, ?)").run(["uuid_id", JSON.stringify({ id: "uuid_id", value: `${self.aci}.1` })]);
    this.db
      .prepare("INSERT INTO items (id, json) VALUES (?, ?)")
      .run(["number_id", JSON.stringify({ id: "number_id", value: `${self.number}.1` })]);
  }

  addConversation(c: Record<string, any>) {
    this.db
      .prepare("INSERT INTO conversations (id, json, type, name, e164, serviceId, groupId) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run([c.id, JSON.stringify(c), c.type, c.name ?? null, c.e164 ?? null, c.serviceId ?? null, c.groupId ?? null]);
  }

  addMessage(m: FixtureMessage): number {
    const json = { id: m.id, conversationId: m.conversationId, type: m.type, sent_at: m.sent_at, body: m.body ?? undefined, ...m.json };
    return this.db
      .prepare(
        `INSERT INTO messages (id, json, sent_at, conversationId, received_at, source, type, body, sourceServiceId,
                               expireTimer, storyId, isErased, timestamp, received_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run([
        m.id, JSON.stringify(json), m.sent_at, m.conversationId, m.sent_at, m.source ?? null, m.type, m.body ?? null,
        m.sourceServiceId ?? null, m.expireTimer ?? null, m.storyId ?? null, m.isErased ?? 0, m.sent_at, m.sent_at,
      ]).lastInsertRowid as number;
  }

  /** Simulate Desktop rewriting a message (edit, delete, new reaction). */
  updateMessage(id: string, body: string | null, jsonPatch: Record<string, unknown>) {
    const row = this.db.prepare("SELECT json FROM messages WHERE id = ?").get([id]) as { json: string };
    const json = { ...JSON.parse(row.json), ...jsonPatch, body: body ?? undefined };
    this.db.prepare("UPDATE messages SET json = ?, body = ? WHERE id = ?").run([JSON.stringify(json), body, id]);
  }

  /** Write an attachment file the way Desktop does and record it in message_attachments. */
  addAttachment(a: {
    messageId: string;
    conversationId: string;
    sentAt: number;
    attachmentType?: string;
    orderInMessage?: number;
    contentType: string;
    fileName?: string;
    data: Buffer;
    encrypted?: boolean;
    flags?: number;
  }): string {
    const name = randomBytes(32).toString("hex");
    const relPath = `${name.slice(0, 2)}/${name}`;
    fs.mkdirSync(path.join(this.dir, "attachments.noindex", name.slice(0, 2)), { recursive: true });
    const keys = randomBytes(64);
    const encrypted = a.encrypted ?? true;
    fs.writeFileSync(path.join(this.dir, "attachments.noindex", relPath), encrypted ? encryptAttachment(a.data, keys) : a.data);
    this.db
      .prepare(
        `INSERT INTO message_attachments (messageId, editHistoryIndex, attachmentType, orderInMessage, conversationId,
                                          sentAt, size, contentType, path, localKey, fileName, version, flags)
         VALUES (?, -1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run([
        a.messageId, a.attachmentType ?? "attachment", a.orderInMessage ?? 0, a.conversationId, a.sentAt, a.data.length,
        a.contentType, relPath, encrypted ? keys.toString("base64") : null, a.fileName ?? null, encrypted ? 2 : null,
        a.flags ?? null,
      ]);
    return relPath;
  }

  /** Write an unencrypted file, as older Desktop versions did; returns its relative path. */
  writePlainFile(data: Buffer): string {
    const name = randomBytes(32).toString("hex");
    fs.mkdirSync(path.join(this.dir, "attachments.noindex", name.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(this.dir, "attachments.noindex", name.slice(0, 2), name), data);
    return `${name.slice(0, 2)}/${name}`;
  }

  close() {
    this.db.close();
  }
}
