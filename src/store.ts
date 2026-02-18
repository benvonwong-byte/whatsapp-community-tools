import Database from "better-sqlite3";
import crypto from "crypto";
import { config } from "./config";
import { BaseStore } from "./utils/base-store";
import {
  airtableCreate,
  airtableUpdate,
  airtableDelete,
  toAirtableFields,
  AirtableEventFields,
} from "./airtable";

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

export class EventStore extends BaseStore {
  // Pre-prepared statements for hot paths
  private stmts!: {
    isMessageProcessed: Database.Statement;
    markMessageProcessed: Database.Statement;
    isEventDuplicate: Database.Statement;
    saveEvent: Database.Statement;
    deleteEvent: Database.Statement;
    getAirtableId: Database.Statement;
    setAirtableId: Database.Statement;
    toggleFavorite: Database.Statement;
    getFavorited: Database.Statement;
  };

  constructor() {
    super();
    this.prepareStatements();
  }

  protected initTables() {
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
    // Migrate: add airtable_record_id column if missing
    try { this.db.exec("ALTER TABLE events ADD COLUMN airtable_record_id TEXT"); } catch {}
  }

  private prepareStatements() {
    this.stmts = {
      isMessageProcessed: this.db.prepare("SELECT 1 FROM processed_messages WHERE message_id = ?"),
      markMessageProcessed: this.db.prepare("INSERT OR IGNORE INTO processed_messages (message_id, chat_name, body, timestamp) VALUES (?, ?, ?, ?)"),
      isEventDuplicate: this.db.prepare("SELECT 1 FROM events WHERE hash = ?"),
      saveEvent: this.db.prepare(`INSERT OR IGNORE INTO events (hash, name, date, start_time, end_time, end_date, location, description, url, category, source_chat, source_message_id, source_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      deleteEvent: this.db.prepare("DELETE FROM events WHERE hash = ?"),
      getAirtableId: this.db.prepare("SELECT airtable_record_id FROM events WHERE hash = ?"),
      setAirtableId: this.db.prepare("UPDATE events SET airtable_record_id = ? WHERE hash = ?"),
      toggleFavorite: this.db.prepare("UPDATE events SET favorited = CASE WHEN favorited = 1 THEN 0 ELSE 1 END WHERE hash = ?"),
      getFavorited: this.db.prepare("SELECT favorited FROM events WHERE hash = ?"),
    };
  }

  isMessageProcessed(messageId: string): boolean {
    return !!this.stmts.isMessageProcessed.get(messageId);
  }

  markMessageProcessed(messageId: string, chatName: string, timestamp: number, body: string) {
    this.stmts.markMessageProcessed.run(messageId, chatName, body, timestamp);
  }

  static hashEvent(name: string, date: string, location: string): string {
    const normalized = `${name.toLowerCase().trim()}|${date.trim()}|${(location || "").toLowerCase().trim()}`;
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  isEventDuplicate(name: string, date: string, location: string): boolean {
    const hash = EventStore.hashEvent(name, date, location);
    return !!this.stmts.isEventDuplicate.get(hash);
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
    const result = this.stmts.saveEvent.run(hash, name, date, startTime, endTime, endDate, location, description, url, category, sourceChat, sourceMessageId, sourceText);

    // Fire-and-forget Airtable sync (only if a row was actually inserted)
    if (result.changes > 0) {
      const fields = toAirtableFields({
        hash, name, date, startTime, endTime, endDate, location,
        description, url, category, sourceChat,
        favorited: false, createdAt: new Date().toISOString(),
      });
      airtableCreate(fields).then((recordId) => {
        if (recordId) {
          this.stmts.setAirtableId.run(recordId, hash);
        }
      }).catch(() => {});
    }
  }

  /** Update an event's fields by hash. Returns true if a row was updated. */
  updateEvent(hash: string, fields: {
    name?: string;
    date?: string;
    startTime?: string | null;
    endTime?: string | null;
    endDate?: string | null;
    location?: string | null;
  }): boolean {
    const sets: string[] = [];
    const values: any[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); values.push(fields.name); }
    if (fields.date !== undefined) { sets.push("date = ?"); values.push(fields.date); }
    if (fields.startTime !== undefined) { sets.push("start_time = ?"); values.push(fields.startTime); }
    if (fields.endTime !== undefined) { sets.push("end_time = ?"); values.push(fields.endTime); }
    if (fields.endDate !== undefined) { sets.push("end_date = ?"); values.push(fields.endDate); }
    if (fields.location !== undefined) { sets.push("location = ?"); values.push(fields.location); }
    if (sets.length === 0) return false;
    values.push(hash);
    const result = this.db
      .prepare(`UPDATE events SET ${sets.join(", ")} WHERE hash = ?`)
      .run(...values);

    // Fire-and-forget Airtable sync
    if (result.changes > 0) {
      const row = this.stmts.getAirtableId.get(hash) as any;
      if (row?.airtable_record_id) {
        const atFields: Partial<AirtableEventFields> = {};
        if (fields.name !== undefined) atFields.Name = fields.name;
        if (fields.date !== undefined) atFields["Start Date"] = fields.date;
        if (fields.startTime !== undefined) atFields["Start Time"] = fields.startTime;
        if (fields.endTime !== undefined) atFields["End Time"] = fields.endTime;
        if (fields.endDate !== undefined) atFields["End Date"] = fields.endDate;
        if (fields.location !== undefined) atFields.Location = fields.location;
        airtableUpdate(row.airtable_record_id, atFields).catch(() => {});
      }
    }

    return result.changes > 0;
  }

  deleteEvent(hash: string): boolean {
    // Look up Airtable record ID before deleting from SQLite
    const row = this.stmts.getAirtableId.get(hash) as any;
    const airtableRecordId = row?.airtable_record_id;

    const result = this.stmts.deleteEvent.run(hash);

    // Fire-and-forget Airtable delete
    if (result.changes > 0 && airtableRecordId) {
      airtableDelete(airtableRecordId).catch(() => {});
    }

    return result.changes > 0;
  }

  /** Get all future events (date >= today). */
  getFutureEvents(): StoredEvent[] {
    const today = new Date().toISOString().split("T")[0];
    const rows = this.db
      .prepare("SELECT * FROM events WHERE date >= ? OR end_date >= ? ORDER BY date ASC, start_time ASC")
      .all(today, today) as any[];
    return rows.map(this.mapRow);
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
    this.stmts.toggleFavorite.run(hash);
    const row = this.stmts.getFavorited.get(hash) as any;
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

  /** Clear processed messages within a time window so they can be re-extracted. */
  clearProcessedMessagesSince(cutoffTimestamp: number): number {
    const result = this.db
      .prepare("DELETE FROM processed_messages WHERE timestamp >= ?")
      .run(cutoffTimestamp);
    return result.changes;
  }

  getLastProcessedTimestamp(): number | null {
    const row = this.db
      .prepare("SELECT MAX(timestamp) as ts FROM processed_messages")
      .get() as any;
    return row?.ts ?? null;
  }

  /** Returns the Unix epoch (seconds) of the most recently created event, or null if no events. */
  getLastEventCreatedTimestamp(): number | null {
    const row = this.db
      .prepare("SELECT MAX(created_at) as ca FROM events")
      .get() as any;
    if (!row?.ca) return null;
    return Math.floor(new Date(row.ca + "Z").getTime() / 1000);
  }

  getAllProcessedMessages(): { message_id: string; chat_name: string; body: string; timestamp: number }[] {
    return this.db
      .prepare("SELECT message_id, chat_name, body, timestamp FROM processed_messages")
      .all() as any[];
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

  /** Store the Airtable record ID for an event. */
  setAirtableRecordId(hash: string, recordId: string): void {
    this.stmts.setAirtableId.run(recordId, hash);
  }

  /** Get all events that haven't been synced to Airtable yet. */
  getEventsWithoutAirtableId(): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE airtable_record_id IS NULL OR airtable_record_id = '' ORDER BY date ASC")
      .all() as any[];
    return rows.map(this.mapRow);
  }

  // ── Maintenance methods ──

  getTableCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    for (const t of tables) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as { c: number };
        counts[t.name] = row.c;
      } catch { /* skip */ }
    }
    return counts;
  }

  /** Get estimated byte sizes per table using dbstat virtual table */
  getTableSizes(): Record<string, number> {
    const sizes: Record<string, number> = {};
    try {
      const rows = this.db.prepare(
        `SELECT name, SUM(pgsize) as size FROM dbstat GROUP BY name ORDER BY size DESC`
      ).all() as { name: string; size: number }[];
      for (const r of rows) {
        sizes[r.name] = r.size;
      }
    } catch {
      // dbstat not available — fall back to page_count * page_size estimate
    }
    return sizes;
  }

  vacuum(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
  }

  pruneOldMessageBodies(olderThanSec: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSec;
    const result = this.db.prepare(
      "UPDATE processed_messages SET body = '' WHERE timestamp < ? AND body != ''"
    ).run(cutoff);
    return result.changes;
  }

  countPrunableMessageBodies(olderThanSec: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSec;
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM processed_messages WHERE timestamp < ? AND body != ''"
    ).get(cutoff) as { c: number };
    return row.c;
  }

}
