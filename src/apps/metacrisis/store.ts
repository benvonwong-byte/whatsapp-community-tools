import Database from "better-sqlite3";
import { config } from "../../config";

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
  summary: string;
  key_topics_json: string;
  message_count: number;
  pushed: number;
  created_at: string;
}

export class MetacrisisStore {
  private db: Database.Database;
  private stmts!: {
    saveMessage: Database.Statement;
    isDuplicate: Database.Statement;
    getUnprocessed: Database.Statement;
    markProcessed: Database.Statement;
    saveLink: Database.Statement;
    getLinks: Database.Statement;
    getLinksByCategory: Database.Statement;
    saveSummary: Database.Statement;
    getSummaries: Database.Statement;
    getSummary: Database.Statement;
    markPushed: Database.Statement;
    getSetting: Database.Statement;
    setSetting: Database.Statement;
    getAllSettings: Database.Statement;
    getStats: Database.Statement;
    getLastTimestamp: Database.Statement;
    getTodayCount: Database.Statement;
    getLeaderboard: Database.Statement;
    getMessagesByDate: Database.Statement;
  };

  constructor() {
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
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

      CREATE TABLE IF NOT EXISTS metacrisis_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL,
        key_topics_json TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        pushed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS metacrisis_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

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
      saveSummary: this.db.prepare(
        `INSERT OR REPLACE INTO metacrisis_summaries (date, summary, key_topics_json, message_count) VALUES (?, ?, ?, ?)`
      ),
      getSummaries: this.db.prepare(
        `SELECT * FROM metacrisis_summaries ORDER BY date DESC LIMIT ?`
      ),
      getSummary: this.db.prepare(
        `SELECT * FROM metacrisis_summaries WHERE date = ?`
      ),
      markPushed: this.db.prepare(
        `UPDATE metacrisis_summaries SET pushed = 1 WHERE date = ?`
      ),
      getSetting: this.db.prepare(
        `SELECT value FROM metacrisis_settings WHERE key = ?`
      ),
      setSetting: this.db.prepare(
        `INSERT OR REPLACE INTO metacrisis_settings (key, value) VALUES (?, ?)`
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
    };
  }

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

  saveSummary(
    date: string,
    summary: string,
    keyTopicsJson: string,
    messageCount: number
  ) {
    this.stmts.saveSummary.run(date, summary, keyTopicsJson, messageCount);
  }

  getSummaries(limit: number = 30): MetacrisisSummary[] {
    return this.stmts.getSummaries.all(limit) as MetacrisisSummary[];
  }

  getSummary(date: string): MetacrisisSummary | undefined {
    return this.stmts.getSummary.get(date) as MetacrisisSummary | undefined;
  }

  markPushed(date: string) {
    this.stmts.markPushed.run(date);
  }

  getSetting(key: string): string | undefined {
    const row = this.stmts.getSetting.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string) {
    this.stmts.setSetting.run(key, value);
  }

  getAllSettings(): Record<string, string> {
    const rows = this.stmts.getAllSettings.all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

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

  getMessagesByDate(date: string): MetacrisisMessage[] {
    return this.stmts.getMessagesByDate.all(date) as MetacrisisMessage[];
  }

  close() {
    this.db.close();
  }
}
