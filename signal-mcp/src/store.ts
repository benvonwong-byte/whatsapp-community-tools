import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/** Sender/contact id used for the account owner, so outgoing messages dedupe across sources. */
export const SELF = "self";

export interface Attachment {
  id?: string | null;
  contentType?: string | null;
  filename?: string | null;
  size?: number | null;
  caption?: string | null;
  isVoiceNote?: boolean;
}

export interface Quote {
  timestamp: number;
  authorId: string | null;
  text: string | null;
}

export interface ContactRow {
  id: string;
  uuid: string | null;
  number: string | null;
  username: string | null;
  name: string | null;
  profile_name: string | null;
  is_blocked: number;
}

export interface ChatRow {
  id: string;
  type: "direct" | "group";
  group_id: string | null;
  name: string;
  number: string | null;
  last_message_at: number | null;
}

export interface MessageRow {
  id: number;
  chat_id: string;
  chat_name: string;
  chat_type: "direct" | "group";
  sender_id: string;
  sender_name: string;
  timestamp: number;
  is_from_me: number;
  body: string | null;
  attachments: string | null;
  quote: string | null;
  edited_at: number | null;
  deleted: number;
}

export interface NewMessage {
  chatId: string;
  senderId: string;
  timestamp: number;
  isFromMe: boolean;
  body: string | null;
  attachments?: Attachment[];
  quote?: Quote | null;
}

export interface ContactInput {
  uuid?: string | null;
  number?: string | null;
  username?: string | null;
  name?: string | null;
  profileName?: string | null;
  isBlocked?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,              -- ACI (uuid) when known, otherwise E.164 number
  uuid TEXT,
  number TEXT,
  username TEXT,
  name TEXT,                        -- nickname / address-book name
  profile_name TEXT,                -- name the person set on their Signal profile
  is_blocked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS contacts_number ON contacts(number);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,              -- contact id for direct chats, "group:<base64 id>" for groups
  type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  group_id TEXT,
  name TEXT,                        -- group name (direct chats use the contact's name)
  last_message_at INTEGER
);

CREATE TABLE IF NOT EXISTS group_members (
  chat_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, member_id)
);
CREATE INDEX IF NOT EXISTS group_members_member ON group_members(member_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,       -- Signal sent timestamp (ms); with sender_id it identifies the message
  is_from_me INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  attachments TEXT,                 -- JSON array
  quote TEXT,                       -- JSON object
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (chat_id, sender_id, timestamp)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, timestamp);
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(timestamp);

CREATE TABLE IF NOT EXISTS reactions (
  chat_id TEXT NOT NULL,
  target_sender_id TEXT NOT NULL,
  target_timestamp INTEGER NOT NULL,
  reactor_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (chat_id, target_sender_id, target_timestamp, reactor_id)
);
`;

const CONTACT_NAME = (alias: string, fallback: string) =>
  `COALESCE(${alias}.name, ${alias}.profile_name, ${alias}.number, ${alias}.username, ${fallback})`;

const CHAT_NAME = `CASE
  WHEN c.type = 'group' THEN COALESCE(c.name, 'Unnamed group')
  WHEN c.id = '${SELF}' THEN 'Note to Self'
  ELSE ${CONTACT_NAME("dc", "c.id")} END`;

const CHAT_SELECT = `
  SELECT c.id, c.type, c.group_id, ${CHAT_NAME} AS name, dc.number AS number, c.last_message_at
  FROM chats c
  LEFT JOIN contacts dc ON c.type = 'direct' AND dc.id = c.id`;

const MESSAGE_SELECT = `
  SELECT m.id, m.chat_id, ${CHAT_NAME} AS chat_name, c.type AS chat_type,
         m.sender_id,
         CASE WHEN m.is_from_me = 1 THEN 'Me' ELSE ${CONTACT_NAME("s", "m.sender_id")} END AS sender_name,
         m.timestamp, m.is_from_me, m.body, m.attachments, m.quote, m.edited_at, m.deleted
  FROM messages m
  JOIN chats c ON c.id = m.chat_id
  LEFT JOIN contacts dc ON c.type = 'direct' AND dc.id = c.id
  LEFT JOIN contacts s ON s.id = m.sender_id`;

export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\+?[\d\s\-().]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 7 ? `+${digits}` : null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function groupChatId(groupId: string): string {
  return `group:${groupId}`;
}

export class SignalStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string) {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ── Writes ──

  /**
   * Insert or update a contact. `authoritative` data (from signal-cli's contact list) overwrites
   * names; names seen on incoming envelopes only fill gaps.
   */
  upsertContact(input: ContactInput, authoritative = false): string | null {
    const id = input.uuid || input.number;
    if (!id) return null;
    const nameUpdate = authoritative
      ? `name = COALESCE(excluded.name, contacts.name),
         profile_name = COALESCE(excluded.profile_name, contacts.profile_name),
         is_blocked = excluded.is_blocked,`
      : `name = COALESCE(contacts.name, excluded.name),
         profile_name = COALESCE(contacts.profile_name, excluded.profile_name),`;
    this.db
      .prepare(
        `INSERT INTO contacts (id, uuid, number, username, name, profile_name, is_blocked, updated_at)
         VALUES (@id, @uuid, @number, @username, @name, @profileName, @isBlocked, @now)
         ON CONFLICT(id) DO UPDATE SET
           uuid = COALESCE(excluded.uuid, contacts.uuid),
           number = COALESCE(excluded.number, contacts.number),
           username = COALESCE(excluded.username, contacts.username),
           ${nameUpdate}
           updated_at = excluded.updated_at`
      )
      .run({
        id,
        uuid: input.uuid || null,
        number: input.number || null,
        username: input.username || null,
        name: input.name || null,
        profileName: input.profileName || null,
        isBlocked: input.isBlocked ? 1 : 0,
        now: Date.now(),
      });
    return id;
  }

  ensureDirectChat(contactId: string) {
    this.db.prepare("INSERT OR IGNORE INTO chats (id, type) VALUES (?, 'direct')").run(contactId);
  }

  /** Returns true if the group was not known before. */
  ensureGroupChat(groupId: string, name?: string | null): boolean {
    const id = groupChatId(groupId);
    const res = this.db
      .prepare("INSERT OR IGNORE INTO chats (id, type, group_id, name) VALUES (?, 'group', ?, ?)")
      .run(id, groupId, name || null);
    if (res.changes === 0 && name) {
      this.db.prepare("UPDATE chats SET name = ? WHERE id = ?").run(name, id);
    }
    return res.changes > 0;
  }

  setGroupMembers(groupId: string, memberIds: string[]) {
    const id = groupChatId(groupId);
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM group_members WHERE chat_id = ?").run(id);
      const insert = this.db.prepare("INSERT OR IGNORE INTO group_members (chat_id, member_id) VALUES (?, ?)");
      for (const member of memberIds) insert.run(id, member);
    });
    tx();
  }

  /** Returns the new message id, or null if it was already stored. */
  insertMessage(msg: NewMessage): number | null {
    const res = this.db
      .prepare(
        `INSERT INTO messages (chat_id, sender_id, timestamp, is_from_me, body, attachments, quote)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, sender_id, timestamp) DO NOTHING`
      )
      .run(
        msg.chatId,
        msg.senderId,
        msg.timestamp,
        msg.isFromMe ? 1 : 0,
        msg.body,
        msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
        msg.quote ? JSON.stringify(msg.quote) : null
      );
    this.db
      .prepare("UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, 0), ?) WHERE id = ?")
      .run(msg.timestamp, msg.chatId);
    return res.changes > 0 ? Number(res.lastInsertRowid) : null;
  }

  applyEdit(chatId: string, senderId: string, targetTimestamp: number, body: string | null, editedAt: number) {
    this.db
      .prepare(
        `UPDATE messages SET body = ?, edited_at = ?
         WHERE chat_id = ? AND sender_id = ? AND timestamp = ? AND COALESCE(edited_at, 0) <= ?`
      )
      .run(body, editedAt, chatId, senderId, targetTimestamp, editedAt);
  }

  markDeleted(chatId: string, senderId: string, targetTimestamp: number) {
    this.db
      .prepare("UPDATE messages SET deleted = 1 WHERE chat_id = ? AND sender_id = ? AND timestamp = ?")
      .run(chatId, senderId, targetTimestamp);
  }

  setReaction(
    chatId: string,
    targetSenderId: string,
    targetTimestamp: number,
    reactorId: string,
    emoji: string,
    timestamp: number
  ) {
    this.db
      .prepare(
        `INSERT INTO reactions (chat_id, target_sender_id, target_timestamp, reactor_id, emoji, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, target_sender_id, target_timestamp, reactor_id)
         DO UPDATE SET emoji = excluded.emoji, timestamp = excluded.timestamp
         WHERE excluded.timestamp >= reactions.timestamp`
      )
      .run(chatId, targetSenderId, targetTimestamp, reactorId, emoji, timestamp);
  }

  removeReaction(chatId: string, targetSenderId: string, targetTimestamp: number, reactorId: string) {
    this.db
      .prepare(
        "DELETE FROM reactions WHERE chat_id = ? AND target_sender_id = ? AND target_timestamp = ? AND reactor_id = ?"
      )
      .run(chatId, targetSenderId, targetTimestamp, reactorId);
  }

  // ── Reads ──

  getContact(id: string): ContactRow | undefined {
    return this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow | undefined;
  }

  /** Resolve a phone number, ACI, username, or contact id to a known contact. */
  findContact(input: string): ContactRow | undefined {
    const value = input.trim();
    const phone = normalizePhone(value);
    if (phone) {
      return this.db.prepare("SELECT * FROM contacts WHERE number = ? LIMIT 1").get(phone) as ContactRow | undefined;
    }
    return this.db
      .prepare(
        `SELECT * FROM contacts
         WHERE id = ? OR uuid = ? COLLATE NOCASE OR username = ? COLLATE NOCASE
         LIMIT 1`
      )
      .get(value, value, value.replace(/^u:/, "")) as ContactRow | undefined;
  }

  searchContacts(query: string, limit = 50): ContactRow[] {
    const like = `%${query.trim()}%`;
    const digits = query.replace(/\D/g, "");
    return this.db
      .prepare(
        `SELECT * FROM contacts
         WHERE id != '${SELF}' AND (
           name LIKE @like OR profile_name LIKE @like OR username LIKE @like OR uuid LIKE @like
           OR (@digits != '' AND number LIKE @digitsLike)
         )
         ORDER BY (name IS NULL), COALESCE(name, profile_name, number) COLLATE NOCASE
         LIMIT @limit`
      )
      .all({ like, digits, digitsLike: `%${digits}%`, limit }) as ContactRow[];
  }

  getChat(id: string): ChatRow | undefined {
    return this.db.prepare(`${CHAT_SELECT} WHERE c.id = ?`).get(id) as ChatRow | undefined;
  }

  listChats(opts: { query?: string; limit: number; page: number; sortBy: "last_active" | "name" }): ChatRow[] {
    const where = opts.query ? `WHERE (${CHAT_NAME}) LIKE @like OR c.id LIKE @like OR dc.number LIKE @like` : "";
    const order =
      opts.sortBy === "name"
        ? "ORDER BY name COLLATE NOCASE"
        : "ORDER BY c.last_message_at IS NULL, c.last_message_at DESC, name COLLATE NOCASE";
    return this.db
      .prepare(`${CHAT_SELECT} ${where} ${order} LIMIT @limit OFFSET @offset`)
      .all({ like: `%${opts.query ?? ""}%`, limit: opts.limit, offset: opts.page * opts.limit }) as ChatRow[];
  }

  getMessage(id: number): MessageRow | undefined {
    return this.db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as MessageRow | undefined;
  }

  getLastMessage(chatId: string): MessageRow | undefined {
    return this.db
      .prepare(`${MESSAGE_SELECT} WHERE m.chat_id = ? ORDER BY m.timestamp DESC, m.id DESC LIMIT 1`)
      .get(chatId) as MessageRow | undefined;
  }

  listMessages(opts: {
    after?: number;
    before?: number;
    senderId?: string;
    chatId?: string;
    query?: string;
    limit: number;
    page: number;
  }): MessageRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: opts.limit, offset: opts.page * opts.limit };
    if (opts.after !== undefined) {
      where.push("m.timestamp > @after");
      params.after = opts.after;
    }
    if (opts.before !== undefined) {
      where.push("m.timestamp < @before");
      params.before = opts.before;
    }
    if (opts.senderId) {
      where.push("m.sender_id = @senderId");
      params.senderId = opts.senderId;
    }
    if (opts.chatId) {
      where.push("m.chat_id = @chatId");
      params.chatId = opts.chatId;
    }
    if (opts.query) {
      where.push("m.deleted = 0 AND (m.body LIKE @like OR m.attachments LIKE @like)");
      params.like = `%${opts.query}%`;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare(`${MESSAGE_SELECT} ${clause} ORDER BY m.timestamp DESC, m.id DESC LIMIT @limit OFFSET @offset`)
      .all(params) as MessageRow[];
  }

  getContext(target: MessageRow, before: number, after: number): { before: MessageRow[]; after: MessageRow[] } {
    const older = this.db
      .prepare(
        `${MESSAGE_SELECT}
         WHERE m.chat_id = @chatId AND (m.timestamp < @ts OR (m.timestamp = @ts AND m.id < @id))
         ORDER BY m.timestamp DESC, m.id DESC LIMIT @n`
      )
      .all({ chatId: target.chat_id, ts: target.timestamp, id: target.id, n: before }) as MessageRow[];
    const newer = this.db
      .prepare(
        `${MESSAGE_SELECT}
         WHERE m.chat_id = @chatId AND (m.timestamp > @ts OR (m.timestamp = @ts AND m.id > @id))
         ORDER BY m.timestamp ASC, m.id ASC LIMIT @n`
      )
      .all({ chatId: target.chat_id, ts: target.timestamp, id: target.id, n: after }) as MessageRow[];
    return { before: older.reverse(), after: newer };
  }

  /** Chats the contact is part of: their direct chat, plus groups they're in or have posted to. */
  getContactChats(contactId: string, limit: number, page: number): ChatRow[] {
    return this.db
      .prepare(
        `${CHAT_SELECT}
         WHERE c.id = @id
            OR c.id IN (SELECT chat_id FROM group_members WHERE member_id = @id)
            OR c.id IN (SELECT DISTINCT chat_id FROM messages WHERE sender_id = @id)
         ORDER BY c.last_message_at IS NULL, c.last_message_at DESC
         LIMIT @limit OFFSET @offset`
      )
      .all({ id: contactId, limit, offset: page * limit }) as ChatRow[];
  }

  getLastInteraction(contactId: string): MessageRow | undefined {
    return this.db
      .prepare(
        `${MESSAGE_SELECT} WHERE m.chat_id = @id OR m.sender_id = @id
         ORDER BY m.timestamp DESC, m.id DESC LIMIT 1`
      )
      .get({ id: contactId }) as MessageRow | undefined;
  }

  /** Reactions for the given messages, keyed by message id. */
  getReactions(messages: MessageRow[]): Map<number, Array<{ emoji: string; reactor: string }>> {
    const result = new Map<number, Array<{ emoji: string; reactor: string }>>();
    if (messages.length === 0) return result;
    const stmt = this.db.prepare(
      `SELECT r.emoji, CASE WHEN r.reactor_id = '${SELF}' THEN 'Me' ELSE ${CONTACT_NAME("ct", "r.reactor_id")} END AS reactor
       FROM reactions r LEFT JOIN contacts ct ON ct.id = r.reactor_id
       WHERE r.chat_id = ? AND r.target_sender_id = ? AND r.target_timestamp = ?
       ORDER BY r.timestamp`
    );
    for (const m of messages) {
      const rows = stmt.all(m.chat_id, m.sender_id, m.timestamp) as Array<{ emoji: string; reactor: string }>;
      if (rows.length) result.set(m.id, rows);
    }
    return result;
  }

  stats(): { messages: number; chats: number; contacts: number; lastMessageAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM messages) AS messages,
                (SELECT COUNT(*) FROM chats) AS chats,
                (SELECT COUNT(*) FROM contacts WHERE id != '${SELF}') AS contacts,
                (SELECT MAX(timestamp) FROM messages) AS lastMessageAt`
      )
      .get() as { messages: number; chats: number; contacts: number; lastMessageAt: number | null };
    return row;
  }
}
