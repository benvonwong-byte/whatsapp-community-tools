import Database from "better-sqlite3";
import crypto from "crypto";
import { config } from "./config";

export interface StoredEvent {
  hash: string;
  name: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  endDate: string | null;
  location: string | null;
  description: string;
  url: string | null;
  category: string;
  sourceChat: string;
  sourceText: string;
  favorited: boolean;
  createdAt: string;
}

export interface GroupStats {
  chatName: string;
  messageCount: number;
  eventCount: number;
  ratio: number;
  lastActive: string | null;
  topCategories: string[];
}

export class EventStore {
  private db: Database.Database;

  constructor() {
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        chat_name TEXT NOT NULL,
        body TEXT DEFAULT '',
        timestamp INTEGER NOT NULL,
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS events (
        hash TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        end_date TEXT,
        location TEXT,
        description TEXT DEFAULT '',
        url TEXT,
        category TEXT NOT NULL,
        source_chat TEXT,
        source_message_id TEXT,
        source_text TEXT DEFAULT '',
        favorited INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocked_groups (
        chat_name TEXT PRIMARY KEY,
        blocked_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Migrate: add body column if missing (existing DBs)
    try { this.db.exec("ALTER TABLE processed_messages ADD COLUMN body TEXT DEFAULT ''"); } catch {}
    // Migrate: add source_text column if missing
    try { this.db.exec("ALTER TABLE events ADD COLUMN source_text TEXT DEFAULT ''"); } catch {}
  }

  isMessageProcessed(messageId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM processed_messages WHERE message_id = ?")
      .get(messageId);
    return !!row;
  }

  markMessageProcessed(messageId: string, chatName: string, timestamp: number, body: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO processed_messages (message_id, chat_name, body, timestamp) VALUES (?, ?, ?, ?)"
      )
      .run(messageId, chatName, body, timestamp);
  }

  static hashEvent(name: string, date: string, location: string): string {
    const normalized = `${name.toLowerCase().trim()}|${date.trim()}|${(location || "").toLowerCase().trim()}`;
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  isEventDuplicate(name: string, date: string, location: string): boolean {
    const hash = EventStore.hashEvent(name, date, location);
    const row = this.db.prepare("SELECT 1 FROM events WHERE hash = ?").get(hash);
    return !!row;
  }

  saveEvent(
    name: string,
    date: string,
    startTime: string | null,
    endTime: string | null,
    endDate: string | null,
    location: string | null,
    description: string,
    url: string | null,
    category: string,
    sourceChat: string,
    sourceMessageId: string,
    sourceText: string
  ) {
    const hash = EventStore.hashEvent(name, date, location || "");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events
         (hash, name, date, start_time, end_time, end_date, location, description, url, category, source_chat, source_message_id, source_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(hash, name, date, startTime, endTime, endDate, location, description, url, category, sourceChat, sourceMessageId, sourceText);
  }

  getAllEvents(): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY date ASC, start_time ASC")
      .all() as any[];
    return rows.map(this.mapRow);
  }

  getEventsByCategory(category: string): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE category = ? ORDER BY date ASC, start_time ASC")
      .all(category) as any[];
    return rows.map(this.mapRow);
  }

  getFavorites(): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE favorited = 1 ORDER BY date ASC, start_time ASC")
      .all() as any[];
    return rows.map(this.mapRow);
  }

  toggleFavorite(hash: string): boolean {
    this.db
      .prepare("UPDATE events SET favorited = CASE WHEN favorited = 1 THEN 0 ELSE 1 END WHERE hash = ?")
      .run(hash);
    const row = this.db
      .prepare("SELECT favorited FROM events WHERE hash = ?")
      .get(hash) as any;
    return row ? !!row.favorited : false;
  }

  getRecentEvents(limit: number = 15): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(this.mapRow);
  }

  getEventsByGroup(chatName: string): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE source_chat = ? ORDER BY date ASC, start_time ASC")
      .all(chatName) as any[];
    return rows.map(this.mapRow);
  }

  blockGroup(chatName: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO blocked_groups (chat_name) VALUES (?)")
      .run(chatName);
  }

  unblockGroup(chatName: string): void {
    this.db
      .prepare("DELETE FROM blocked_groups WHERE chat_name = ?")
      .run(chatName);
  }

  isGroupBlocked(chatName: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM blocked_groups WHERE chat_name = ?")
      .get(chatName);
    return !!row;
  }

  getBlockedGroups(): string[] {
    const rows = this.db
      .prepare("SELECT chat_name FROM blocked_groups ORDER BY blocked_at DESC")
      .all() as any[];
    return rows.map((r) => r.chat_name);
  }

  getGroupStats(): GroupStats[] {
    const msgCounts = this.db
      .prepare("SELECT chat_name, COUNT(*) as cnt FROM processed_messages GROUP BY chat_name")
      .all() as any[];

    const evtCounts = this.db
      .prepare("SELECT source_chat, COUNT(*) as cnt FROM events GROUP BY source_chat")
      .all() as any[];

    const lastActiveRows = this.db
      .prepare("SELECT source_chat, MAX(date) as last_date FROM events GROUP BY source_chat")
      .all() as any[];

    const topCatRows = this.db
      .prepare(
        "SELECT source_chat, category, COUNT(*) as cnt FROM events GROUP BY source_chat, category ORDER BY source_chat, cnt DESC"
      )
      .all() as any[];

    const evtMap = new Map<string, number>();
    for (const row of evtCounts) {
      evtMap.set(row.source_chat, row.cnt);
    }

    const lastActiveMap = new Map<string, string>();
    for (const row of lastActiveRows) {
      lastActiveMap.set(row.source_chat, row.last_date);
    }

    const topCatMap = new Map<string, string[]>();
    for (const row of topCatRows) {
      if (!topCatMap.has(row.source_chat)) topCatMap.set(row.source_chat, []);
      const arr = topCatMap.get(row.source_chat)!;
      if (arr.length < 3) arr.push(row.category);
    }

    return msgCounts
      .map((row) => {
        const eventCount = evtMap.get(row.chat_name) || 0;
        return {
          chatName: row.chat_name,
          messageCount: row.cnt,
          eventCount,
          ratio: row.cnt > 0 ? eventCount / row.cnt : 0,
          lastActive: lastActiveMap.get(row.chat_name) || null,
          topCategories: topCatMap.get(row.chat_name) || [],
        };
      })
      .sort((a, b) => b.ratio - a.ratio);
  }

  getTotalStats(): { totalMessages: number; totalEvents: number } {
    const msgs = this.db.prepare("SELECT COUNT(*) as cnt FROM processed_messages").get() as any;
    const evts = this.db.prepare("SELECT COUNT(*) as cnt FROM events").get() as any;
    return { totalMessages: msgs.cnt, totalEvents: evts.cnt };
  }

  private mapRow(row: any): StoredEvent {
    return {
      hash: row.hash,
      name: row.name,
      date: row.date,
      startTime: row.start_time,
      endTime: row.end_time,
      endDate: row.end_date,
      location: row.location,
      description: row.description || "",
      url: row.url,
      category: row.category,
      sourceChat: row.source_chat,
      sourceText: row.source_text || "",
      favorited: !!row.favorited,
      createdAt: row.created_at,
    };
  }

  close() {
    this.db.close();
  }
}
