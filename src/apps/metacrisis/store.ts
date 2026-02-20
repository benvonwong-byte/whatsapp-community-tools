import Database from "better-sqlite3";
import { config } from "../../config";
import { SettingsStore } from "../../utils/base-store";

export interface MetacrisisMessage {
  id: string;
  sender: string;
  sender_name: string;
  body: string;
  timestamp: number;
  processed: number;
  created_at?: string;
}

export interface MetacrisisLink {
  id: number;
  url: string;
  title: string;
  category: string;
  sender_name: string;
  message_id: string;
  timestamp: number;
  created_at: string;
}

export interface MetacrisisSummary {
  id: number;
  date: string;
  type: string;
  summary: string;
  key_topics_json: string;
  recommendations_json: string;
  who_said_what_json: string;
  message_count: number;
  pushed: number;
  created_at: string;
}

export interface MetacrisisEvent {
  id: number;
  url: string;
  name: string;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  location: string;
  description: string;
  source_message_id: string | null;
  status: string;
  created_at: string;
}

export interface MetacrisisTopic {
  topic: string;
  total_mentions: number;
}

export class MetacrisisStore extends SettingsStore {
  declare private stmts: {
    saveMessage: Database.Statement;
    isDuplicate: Database.Statement;
    getUnprocessed: Database.Statement;
    markProcessed: Database.Statement;
    saveLink: Database.Statement;
    getLinks: Database.Statement;
    getLinksByCategory: Database.Statement;
    saveSummary: Database.Statement;
    getSummaries: Database.Statement;
    getSummariesByType: Database.Statement;
    getSummary: Database.Statement;
    getSummaryByType: Database.Statement;
    markPushed: Database.Statement;
    getAllSettings: Database.Statement;
    getStats: Database.Statement;
    getLastTimestamp: Database.Statement;
    getTodayCount: Database.Statement;
    getLeaderboard: Database.Statement;
    getMessagesByDate: Database.Statement;
    getMessagesByDateRange: Database.Statement;
    // Events
    saveEvent: Database.Statement;
    getEventByUrl: Database.Statement;
    getUpcomingEvents: Database.Statement;
    markPastEvents: Database.Statement;
    // Topics
    saveTopic: Database.Statement;
    getTopicsByPeriod: Database.Statement;
  };

  protected initTables() {
    // Core tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metacrisis_messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        sender_name TEXT DEFAULT '',
        body TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_meta_msgs_timestamp ON metacrisis_messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_meta_msgs_processed ON metacrisis_messages(processed);

      CREATE TABLE IF NOT EXISTS metacrisis_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT DEFAULT '',
        category TEXT DEFAULT 'other',
        sender_name TEXT DEFAULT '',
        message_id TEXT,
        timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_meta_links_category ON metacrisis_links(category);
      CREATE INDEX IF NOT EXISTS idx_meta_links_timestamp ON metacrisis_links(timestamp);

    `);

    this.initSettings("metacrisis_settings");

    // Migrate summaries table: add type, recommendations_json, who_said_what_json columns
    // Check if the old table exists without type column
    const cols = this.db.prepare("PRAGMA table_info(metacrisis_summaries)").all() as any[];
    const hasType = cols.find((c: any) => c.name === "type");

    if (cols.length > 0 && !hasType) {
      // Existing table without type — migrate
      this.db.exec(`
        CREATE TABLE metacrisis_summaries_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'weekly',
          summary TEXT NOT NULL,
          key_topics_json TEXT NOT NULL,
          recommendations_json TEXT DEFAULT '[]',
          who_said_what_json TEXT DEFAULT '[]',
          message_count INTEGER DEFAULT 0,
          pushed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(date, type)
        );
        INSERT INTO metacrisis_summaries_new (id, date, type, summary, key_topics_json, message_count, pushed, created_at)
          SELECT id, date, 'weekly', summary, key_topics_json, message_count, pushed, created_at FROM metacrisis_summaries;
        DROP TABLE metacrisis_summaries;
        ALTER TABLE metacrisis_summaries_new RENAME TO metacrisis_summaries;
      `);
      console.log("[metacrisis-store] Migrated metacrisis_summaries table (added type column)");
    } else if (cols.length === 0) {
      // Fresh install — create with new schema
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metacrisis_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'weekly',
          summary TEXT NOT NULL,
          key_topics_json TEXT NOT NULL,
          recommendations_json TEXT DEFAULT '[]',
          who_said_what_json TEXT DEFAULT '[]',
          message_count INTEGER DEFAULT 0,
          pushed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(date, type)
        );
      `);
    }

    // Events table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metacrisis_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        name TEXT DEFAULT '',
        date TEXT,
        start_time TEXT,
        end_time TEXT,
        location TEXT DEFAULT '',
        description TEXT DEFAULT '',
        source_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_meta_events_date ON metacrisis_events(date);
      CREATE INDEX IF NOT EXISTS idx_meta_events_status ON metacrisis_events(status);
    `);

    // Topics table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metacrisis_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        date TEXT NOT NULL,
        mention_count INTEGER DEFAULT 1,
        sentiment TEXT DEFAULT 'neutral',
        UNIQUE(topic, date)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_topics_date ON metacrisis_topics(date);
      CREATE INDEX IF NOT EXISTS idx_meta_topics_topic ON metacrisis_topics(topic);
    `);

    // Migrate links table: add description and event_date columns if missing
    const linkCols = this.db.prepare("PRAGMA table_info(metacrisis_links)").all() as any[];
    if (linkCols.length > 0 && !linkCols.find((c: any) => c.name === "description")) {
      this.db.exec(`ALTER TABLE metacrisis_links ADD COLUMN description TEXT DEFAULT ''`);
      console.log("[metacrisis-store] Migrated metacrisis_links: added description column");
    }
    if (linkCols.length > 0 && !linkCols.find((c: any) => c.name === "event_date")) {
      this.db.exec(`ALTER TABLE metacrisis_links ADD COLUMN event_date TEXT DEFAULT NULL`);
      console.log("[metacrisis-store] Migrated metacrisis_links: added event_date column");
    }

    // Insert default settings if they don't exist
    const insertDefault = this.db.prepare(
      `INSERT OR IGNORE INTO metacrisis_settings (key, value) VALUES (?, ?)`
    );
    const insertDefaults = this.db.transaction(() => {
      insertDefault.run("push_schedule", "manual");
      insertDefault.run("push_day", "1");
      insertDefault.run("push_hour", "9");
      insertDefault.run(
        "format_template",
        "📋 *Metacrisis Community Update — {{date}}*\n\n{{summary}}\n\n🏷️ Key Topics: {{topics}}"
      );
    });
    insertDefaults();

    // Fix any @lid sender names with known overrides
    const SENDER_FIXES: Record<string, string> = {
      "116084476788850:76@lid": "Benjamin Von Wong",
    };
    for (const [rawId, displayName] of Object.entries(SENDER_FIXES)) {
      this.db.prepare(`UPDATE metacrisis_messages SET sender_name = ? WHERE sender = ? AND (sender_name = ? OR sender_name = '' OR sender_name IS NULL)`).run(displayName, rawId, rawId);
      this.db.prepare(`UPDATE metacrisis_links SET sender_name = ? WHERE sender_name = ?`).run(displayName, rawId);
      // Also fix in summary who_said_what_json
      const summaries = this.db.prepare(`SELECT id, who_said_what_json FROM metacrisis_summaries WHERE who_said_what_json LIKE ?`).all(`%${rawId}%`) as any[];
      for (const s of summaries) {
        const fixed = s.who_said_what_json.replace(new RegExp(rawId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), displayName);
        this.db.prepare(`UPDATE metacrisis_summaries SET who_said_what_json = ? WHERE id = ?`).run(fixed, s.id);
      }
    }

    this.stmts = {
      saveMessage: this.db.prepare(
        `INSERT OR IGNORE INTO metacrisis_messages (id, sender, sender_name, body, timestamp) VALUES (?, ?, ?, ?, ?)`
      ),
      isDuplicate: this.db.prepare(
        `SELECT 1 FROM metacrisis_messages WHERE id = ?`
      ),
      getUnprocessed: this.db.prepare(
        `SELECT * FROM metacrisis_messages WHERE processed = 0 ORDER BY timestamp ASC`
      ),
      markProcessed: this.db.prepare(
        `UPDATE metacrisis_messages SET processed = 1 WHERE id = ?`
      ),
      saveLink: this.db.prepare(
        `INSERT INTO metacrisis_links (url, title, category, sender_name, message_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
      ),
      getLinks: this.db.prepare(
        `SELECT * FROM metacrisis_links ORDER BY timestamp DESC LIMIT ?`
      ),
      getLinksByCategory: this.db.prepare(
        `SELECT * FROM metacrisis_links WHERE category = ? ORDER BY timestamp DESC LIMIT ?`
      ),
      // Summaries — now with type support
      saveSummary: this.db.prepare(
        `INSERT OR REPLACE INTO metacrisis_summaries (date, type, summary, key_topics_json, recommendations_json, who_said_what_json, message_count) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      getSummaries: this.db.prepare(
        `SELECT * FROM metacrisis_summaries ORDER BY date DESC LIMIT ?`
      ),
      getSummariesByType: this.db.prepare(
        `SELECT * FROM metacrisis_summaries WHERE type = ? ORDER BY date DESC LIMIT ?`
      ),
      getSummary: this.db.prepare(
        `SELECT * FROM metacrisis_summaries WHERE date = ? ORDER BY type ASC LIMIT 1`
      ),
      getSummaryByType: this.db.prepare(
        `SELECT * FROM metacrisis_summaries WHERE date = ? AND type = ?`
      ),
      markPushed: this.db.prepare(
        `UPDATE metacrisis_summaries SET pushed = 1 WHERE date = ? AND type = ?`
      ),
      getAllSettings: this.db.prepare(
        `SELECT * FROM metacrisis_settings`
      ),
      getStats: this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM metacrisis_messages) as totalMessages,
          (SELECT COUNT(*) FROM metacrisis_summaries) as totalSummaries,
          (SELECT COUNT(*) FROM metacrisis_links) as totalLinks
      `),
      getLastTimestamp: this.db.prepare(
        `SELECT MAX(timestamp) as ts FROM metacrisis_messages`
      ),
      getTodayCount: this.db.prepare(
        `SELECT COUNT(*) as count FROM metacrisis_messages WHERE date(datetime(timestamp, 'unixepoch')) = date('now')`
      ),
      getLeaderboard: this.db.prepare(
        `SELECT sender_name, COUNT(*) as message_count FROM metacrisis_messages WHERE sender_name != '' GROUP BY sender_name ORDER BY message_count DESC LIMIT ?`
      ),
      getMessagesByDate: this.db.prepare(
        `SELECT * FROM metacrisis_messages WHERE date(datetime(timestamp, 'unixepoch')) = ? ORDER BY timestamp ASC`
      ),
      getMessagesByDateRange: this.db.prepare(
        `SELECT * FROM metacrisis_messages WHERE date(datetime(timestamp, 'unixepoch')) >= ? AND date(datetime(timestamp, 'unixepoch')) <= ? ORDER BY timestamp ASC`
      ),
      // Events
      saveEvent: this.db.prepare(
        `INSERT OR REPLACE INTO metacrisis_events (url, name, date, start_time, end_time, location, description, source_message_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      getEventByUrl: this.db.prepare(
        `SELECT * FROM metacrisis_events WHERE url = ?`
      ),
      getUpcomingEvents: this.db.prepare(
        `SELECT * FROM metacrisis_events WHERE status != 'past' AND (date >= date('now') OR date IS NULL) ORDER BY date ASC`
      ),
      markPastEvents: this.db.prepare(
        `UPDATE metacrisis_events SET status = 'past' WHERE date < date('now') AND status != 'past'`
      ),
      // Topics
      saveTopic: this.db.prepare(
        `INSERT OR REPLACE INTO metacrisis_topics (topic, date, mention_count, sentiment) VALUES (?, ?, ?, ?)`
      ),
      getTopicsByPeriod: this.db.prepare(
        `SELECT topic, SUM(mention_count) as total_mentions FROM metacrisis_topics WHERE date >= ? AND date <= ? GROUP BY topic ORDER BY total_mentions DESC LIMIT 20`
      ),
    };
  }

  // ── Messages ──

  saveMessage(msg: {
    id: string;
    sender: string;
    sender_name: string;
    body: string;
    timestamp: number;
  }) {
    this.stmts.saveMessage.run(
      msg.id,
      msg.sender,
      msg.sender_name,
      msg.body,
      msg.timestamp
    );
  }

  isDuplicate(id: string): boolean {
    return !!this.stmts.isDuplicate.get(id);
  }

  getUnprocessedMessages(): MetacrisisMessage[] {
    return this.stmts.getUnprocessed.all() as MetacrisisMessage[];
  }

  markProcessed(ids: string[]) {
    const markMany = this.db.transaction((messageIds: string[]) => {
      for (const id of messageIds) {
        this.stmts.markProcessed.run(id);
      }
    });
    markMany(ids);
  }

  getMessagesByDate(date: string): MetacrisisMessage[] {
    return this.stmts.getMessagesByDate.all(date) as MetacrisisMessage[];
  }

  getMessagesByDateRange(startDate: string, endDate: string): MetacrisisMessage[] {
    return this.stmts.getMessagesByDateRange.all(startDate, endDate) as MetacrisisMessage[];
  }

  // ── Links ──

  saveLink(link: {
    url: string;
    title?: string;
    category: string;
    sender_name: string;
    message_id: string;
    timestamp: number;
  }) {
    this.stmts.saveLink.run(
      link.url,
      link.title || "",
      link.category,
      link.sender_name,
      link.message_id,
      link.timestamp
    );
  }

  getLinks(limit: number = 50): MetacrisisLink[] {
    return this.stmts.getLinks.all(limit) as MetacrisisLink[];
  }

  getLinksByCategory(category: string, limit: number = 50): MetacrisisLink[] {
    return this.stmts.getLinksByCategory.all(category, limit) as MetacrisisLink[];
  }

  /** Get links that haven't been scraped yet (no title or description) */
  getUnscrapedLinks(limit: number = 20): Array<{ id: number; url: string; category: string }> {
    return this.db.prepare(`
      SELECT id, url, category FROM metacrisis_links
      WHERE (title IS NULL OR title = '') AND (description IS NULL OR description = '')
      ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as any[];
  }

  /** Update a link's scraped title, description, and optionally event_date + category */
  updateLinkMeta(id: number, title: string, description: string, eventDate?: string | null, category?: string) {
    if (eventDate !== undefined || category) {
      this.db.prepare(`UPDATE metacrisis_links SET title = ?, description = ?, event_date = ?, category = COALESCE(?, category) WHERE id = ?`)
        .run(title, description, eventDate || null, category || null, id);
    } else {
      this.db.prepare(`UPDATE metacrisis_links SET title = ?, description = ? WHERE id = ?`)
        .run(title, description, id);
    }
  }

  /** Get composer links: articles/videos from last 7 days + future events */
  getComposerLinks(): Array<{
    id: number; url: string; title: string; description: string;
    category: string; sender_name: string; timestamp: number;
    event_date: string | null;
  }> {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    const today = new Date().toISOString().split("T")[0];
    return this.db.prepare(`
      SELECT id, url, COALESCE(title, '') as title,
             COALESCE(description, '') as description,
             category, sender_name, timestamp, event_date
      FROM metacrisis_links
      WHERE
        (category IN ('article', 'video', 'podcast', 'other') AND timestamp >= ?)
        OR (category = 'event' AND (event_date IS NULL OR event_date >= ?))
      ORDER BY
        CASE WHEN category = 'event' THEN 0 ELSE 1 END,
        timestamp DESC
    `).all(cutoff, today) as any[];
  }

  // ── Summaries ──

  saveSummary(
    date: string,
    type: string,
    summary: string,
    keyTopicsJson: string,
    recommendationsJson: string,
    whoSaidWhatJson: string,
    messageCount: number
  ) {
    this.stmts.saveSummary.run(date, type, summary, keyTopicsJson, recommendationsJson, whoSaidWhatJson, messageCount);
  }

  getSummaries(limit: number = 30, type?: string): MetacrisisSummary[] {
    if (type) {
      return this.stmts.getSummariesByType.all(type, limit) as MetacrisisSummary[];
    }
    return this.stmts.getSummaries.all(limit) as MetacrisisSummary[];
  }

  getSummary(date: string, type?: string): MetacrisisSummary | undefined {
    if (type) {
      return this.stmts.getSummaryByType.get(date, type) as MetacrisisSummary | undefined;
    }
    return this.stmts.getSummary.get(date) as MetacrisisSummary | undefined;
  }

  markPushed(date: string, type: string = "weekly") {
    this.stmts.markPushed.run(date, type);
  }

  // ── Events ──

  saveEvent(event: {
    url: string;
    name: string;
    date: string | null;
    start_time: string | null;
    end_time: string | null;
    location: string;
    description: string;
    source_message_id: string | null;
    status?: string;
  }) {
    this.stmts.saveEvent.run(
      event.url,
      event.name,
      event.date,
      event.start_time,
      event.end_time,
      event.location,
      event.description,
      event.source_message_id,
      event.status || (event.date ? "active" : "pending")
    );
  }

  getEventByUrl(url: string): MetacrisisEvent | undefined {
    return this.stmts.getEventByUrl.get(url) as MetacrisisEvent | undefined;
  }

  getUpcomingEvents(): MetacrisisEvent[] {
    return this.stmts.getUpcomingEvents.all() as MetacrisisEvent[];
  }

  markPastEvents(): number {
    return this.stmts.markPastEvents.run().changes;
  }

  // ── Topics ──

  saveTopics(date: string, topics: { topic: string; count: number; sentiment: string }[]) {
    const saveMany = this.db.transaction((items: typeof topics) => {
      for (const t of items) {
        this.stmts.saveTopic.run(t.topic, date, t.count, t.sentiment);
      }
    });
    saveMany(topics);
  }

  getTopicsByPeriod(startDate: string, endDate: string): MetacrisisTopic[] {
    return this.stmts.getTopicsByPeriod.all(startDate, endDate) as MetacrisisTopic[];
  }

  getAllSettings(): Record<string, string> {
    const rows = this.stmts.getAllSettings.all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  // ── Stats ──

  getStats() {
    return this.stmts.getStats.get() as {
      totalMessages: number;
      totalSummaries: number;
      totalLinks: number;
    };
  }

  getHealth() {
    const lastTs = (this.stmts.getLastTimestamp.get() as any)?.ts || null;
    const todayCount = (this.stmts.getTodayCount.get() as any)?.count || 0;
    return { lastMessageTimestamp: lastTs, todayMessageCount: todayCount };
  }

  getLeaderboard(limit: number = 10): { sender_name: string; message_count: number }[] {
    return this.stmts.getLeaderboard.all(limit) as {
      sender_name: string;
      message_count: number;
    }[];
  }

  // ── Weekly Draft helpers ──

  getTopResources(days: number = 7, limit: number = 3): { url: string; title: string; category: string; share_count: number; shared_by: string }[] {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    return this.db.prepare(`
      SELECT url, MAX(title) as title, MAX(category) as category,
             COUNT(*) as share_count,
             GROUP_CONCAT(DISTINCT sender_name) as shared_by
      FROM metacrisis_links
      WHERE timestamp >= ?
      GROUP BY url
      ORDER BY share_count DESC, MAX(timestamp) DESC
      LIMIT ?
    `).all(cutoff, limit) as any[];
  }

  getWeeklyTopMember(days: number = 7): { sender_name: string; message_count: number } | undefined {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    return this.db.prepare(`
      SELECT sender_name, COUNT(*) as message_count
      FROM metacrisis_messages
      WHERE timestamp >= ? AND sender_name != ''
      GROUP BY sender_name
      ORDER BY message_count DESC
      LIMIT 1
    `).get(cutoff) as any;
  }

  getRecentDailyDigests(days: number = 7): MetacrisisSummary[] {
    return this.db.prepare(`
      SELECT * FROM metacrisis_summaries
      WHERE type = 'daily' AND date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC
    `).all(days) as MetacrisisSummary[];
  }

  /** Get recent messages that contain links, grouped with link metadata, for the composer */
  getMessagesWithLinks(days: number = 7, limit: number = 20): Array<{
    sender_name: string; body: string; timestamp: number;
    url: string; link_title: string; link_description: string; category: string;
  }> {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    return this.db.prepare(`
      SELECT m.sender_name, m.body, m.timestamp,
             l.url, COALESCE(l.title, '') as link_title,
             COALESCE(l.description, '') as link_description, l.category
      FROM metacrisis_links l
      JOIN metacrisis_messages m ON m.id = l.message_id
      WHERE l.timestamp >= ? AND m.sender_name != ''
      ORDER BY l.timestamp DESC
      LIMIT ?
    `).all(cutoff, limit) as any[];
  }

  /** Get discussion highlights: top topics with who discussed them */
  getWeeklyHighlights(days: number = 7): Array<{ topic: string; mention_count: number; sentiment: string }> {
    return this.db.prepare(`
      SELECT topic, SUM(mention_count) as mention_count, sentiment
      FROM metacrisis_topics
      WHERE date >= date('now', '-' || ? || ' days')
      GROUP BY topic
      ORDER BY mention_count DESC
      LIMIT 10
    `).all(days) as any[];
  }

}
