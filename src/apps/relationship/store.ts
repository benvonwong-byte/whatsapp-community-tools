import Database from "better-sqlite3";
import { config } from "../../config";
import { SettingsStore } from "../../utils/base-store";

export interface RelationshipMessage {
  id: string;
  speaker: string;
  body: string;
  transcript: string;
  timestamp: number;
  type: "text" | "voice";
  source: "whatsapp" | "in-person" | "import";
  analyzed: number;
  createdAt?: string;
}

export interface RelationshipAnalysis {
  id: number;
  date: string;
  metricsJson: string;
  summary: string;
  messageCount: number;
  voiceMinutes: number;
  createdAt: string;
}

export class RelationshipStore extends SettingsStore {
  declare private stmts: {
    saveMessage: Database.Statement;
    isDuplicate: Database.Statement;
    getUnanalyzed: Database.Statement;
    getUnanalyzedDates: Database.Statement;
    getUnanalyzedByDate: Database.Statement;
    markAnalyzed: Database.Statement;
    saveAnalysis: Database.Statement;
    getAnalyses: Database.Statement;
    getAnalysis: Database.Statement;
    getMessages: Database.Statement;
    getMessagesByDate: Database.Statement;
    getStats: Database.Statement;
    getStatsByRange: Database.Statement;
    getAnalysesByRange: Database.Statement;
    getLastTimestamp: Database.Statement;
    getTodayCount: Database.Statement;
    getInitiatorStats: Database.Statement;
    getResponseTimes: Database.Statement;
    getVolumeByDay: Database.Statement;
    getUntranscribedVoice: Database.Statement;
    updateTranscript: Database.Statement;
  };

  protected initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relationship_messages (
        id TEXT PRIMARY KEY,
        speaker TEXT NOT NULL,
        body TEXT DEFAULT '',
        transcript TEXT DEFAULT '',
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        source TEXT NOT NULL DEFAULT 'whatsapp',
        analyzed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rel_msgs_timestamp ON relationship_messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_rel_msgs_analyzed ON relationship_messages(analyzed);

      CREATE TABLE IF NOT EXISTS relationship_analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        metrics_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        voice_minutes REAL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    this.initSettings("relationship_settings");

    // Migrate existing DBs: add source column if missing
    try {
      this.db.exec(`ALTER TABLE relationship_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'whatsapp'`);
    } catch {
      // column already exists
    }

    this.stmts = {
      saveMessage: this.db.prepare(
        `INSERT OR IGNORE INTO relationship_messages (id, speaker, body, transcript, timestamp, type, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      isDuplicate: this.db.prepare(`SELECT 1 FROM relationship_messages WHERE id = ?`),
      getUnanalyzed: this.db.prepare(
        `SELECT * FROM relationship_messages WHERE analyzed = 0 ORDER BY timestamp ASC`
      ),
      getUnanalyzedDates: this.db.prepare(
        `SELECT DISTINCT date(datetime(timestamp, 'unixepoch')) as day FROM relationship_messages WHERE analyzed = 0 ORDER BY day ASC`
      ),
      getUnanalyzedByDate: this.db.prepare(
        `SELECT * FROM relationship_messages WHERE analyzed = 0 AND date(datetime(timestamp, 'unixepoch')) = ? ORDER BY timestamp ASC`
      ),
      markAnalyzed: this.db.prepare(
        `UPDATE relationship_messages SET analyzed = 1 WHERE id = ?`
      ),
      saveAnalysis: this.db.prepare(
        `INSERT OR REPLACE INTO relationship_analyses (date, metrics_json, summary, message_count, voice_minutes) VALUES (?, ?, ?, ?, ?)`
      ),
      getAnalyses: this.db.prepare(
        `SELECT id, date, metrics_json AS metricsJson, summary, message_count AS messageCount, voice_minutes AS voiceMinutes, created_at AS createdAt FROM relationship_analyses ORDER BY date DESC LIMIT ?`
      ),
      getAnalysis: this.db.prepare(
        `SELECT id, date, metrics_json AS metricsJson, summary, message_count AS messageCount, voice_minutes AS voiceMinutes, created_at AS createdAt FROM relationship_analyses WHERE date = ?`
      ),
      getMessages: this.db.prepare(
        `SELECT * FROM relationship_messages ORDER BY timestamp DESC LIMIT ?`
      ),
      getMessagesByDate: this.db.prepare(
        `SELECT * FROM relationship_messages WHERE date(datetime(timestamp, 'unixepoch')) = ? ORDER BY timestamp ASC`
      ),
      getStats: this.db.prepare(`
        SELECT
          COUNT(*) as totalMessages,
          SUM(CASE WHEN speaker = 'self' THEN 1 ELSE 0 END) as selfMessages,
          SUM(CASE WHEN speaker != 'self' THEN 1 ELSE 0 END) as partnerMessages,
          SUM(CASE WHEN type = 'voice' THEN 1 ELSE 0 END) as voiceMessages,
          MIN(timestamp) as firstTimestamp,
          MAX(timestamp) as lastTimestamp
        FROM relationship_messages
      `),
      getStatsByRange: this.db.prepare(`
        SELECT
          COUNT(*) as totalMessages,
          SUM(CASE WHEN speaker = 'self' THEN 1 ELSE 0 END) as selfMessages,
          SUM(CASE WHEN speaker != 'self' THEN 1 ELSE 0 END) as partnerMessages,
          SUM(CASE WHEN type = 'voice' THEN 1 ELSE 0 END) as voiceMessages,
          MIN(timestamp) as firstTimestamp,
          MAX(timestamp) as lastTimestamp
        FROM relationship_messages
        WHERE timestamp >= ? AND timestamp <= ?
      `),
      getAnalysesByRange: this.db.prepare(
        `SELECT id, date, metrics_json AS metricsJson, summary, message_count AS messageCount, voice_minutes AS voiceMinutes, created_at AS createdAt FROM relationship_analyses WHERE date >= ? AND date <= ? ORDER BY date DESC`
      ),
      getLastTimestamp: this.db.prepare(
        `SELECT MAX(timestamp) as ts FROM relationship_messages`
      ),
      getTodayCount: this.db.prepare(
        `SELECT COUNT(*) as count FROM relationship_messages WHERE date(datetime(timestamp, 'unixepoch')) = date('now')`
      ),
      getInitiatorStats: this.db.prepare(`
        WITH gaps AS (
          SELECT
            speaker,
            timestamp,
            LAG(timestamp) OVER (ORDER BY timestamp) as prev_ts
          FROM relationship_messages
          WHERE timestamp >= ? AND timestamp <= ?
        )
        SELECT speaker, COUNT(*) as initiations
        FROM gaps
        WHERE (timestamp - COALESCE(prev_ts, 0)) > 7200
        GROUP BY speaker
      `),
      getResponseTimes: this.db.prepare(`
        WITH ordered AS (
          SELECT
            speaker,
            timestamp,
            LAG(speaker) OVER (ORDER BY timestamp) as prev_speaker,
            LAG(timestamp) OVER (ORDER BY timestamp) as prev_ts
          FROM relationship_messages
          WHERE timestamp >= ? AND timestamp <= ?
        )
        SELECT
          speaker,
          AVG(timestamp - prev_ts) as avg_response_sec,
          COUNT(*) as responses
        FROM ordered
        WHERE speaker != prev_speaker
          AND (timestamp - prev_ts) < 7200
          AND (timestamp - prev_ts) > 0
        GROUP BY speaker
      `),
      getVolumeByDay: this.db.prepare(`
        SELECT
          date(datetime(timestamp, 'unixepoch')) as day,
          speaker,
          COUNT(*) as count
        FROM relationship_messages
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY day, speaker
        ORDER BY day ASC
      `),
      getUntranscribedVoice: this.db.prepare(
        `SELECT * FROM relationship_messages WHERE type = 'voice' AND (transcript = '' OR transcript IS NULL) ORDER BY timestamp ASC`
      ),
      updateTranscript: this.db.prepare(
        `UPDATE relationship_messages SET transcript = ? WHERE id = ?`
      ),
    };
  }

  saveMessage(msg: { id: string; speaker: string; body: string; transcript: string; timestamp: number; type: string; source?: string }) {
    this.stmts.saveMessage.run(msg.id, msg.speaker, msg.body, msg.transcript, msg.timestamp, msg.type, msg.source || "whatsapp");
  }

  isDuplicate(id: string): boolean {
    return !!this.stmts.isDuplicate.get(id);
  }

  getUnanalyzedMessages(): RelationshipMessage[] {
    return this.stmts.getUnanalyzed.all() as RelationshipMessage[];
  }

  getUnanalyzedDates(): string[] {
    return (this.stmts.getUnanalyzedDates.all() as Array<{ day: string }>).map(r => r.day);
  }

  getUnanalyzedMessagesByDate(date: string): RelationshipMessage[] {
    return this.stmts.getUnanalyzedByDate.all(date) as RelationshipMessage[];
  }

  markAnalyzed(ids: string[]) {
    const markMany = this.db.transaction((messageIds: string[]) => {
      for (const id of messageIds) {
        this.stmts.markAnalyzed.run(id);
      }
    });
    markMany(ids);
  }

  resetAnalyzedFlags(): number {
    const result = this.db.prepare(`UPDATE relationship_messages SET analyzed = 0`).run();
    return result.changes;
  }

  /** Reset only today's messages to unanalyzed so re-analysis captures new messages */
  resetTodayAnalyzedFlags(): number {
    const result = this.db.prepare(
      `UPDATE relationship_messages SET analyzed = 0 WHERE date(datetime(timestamp, 'unixepoch')) = date('now')`
    ).run();
    return result.changes;
  }

  /** Count unanalyzed messages */
  getUnanalyzedCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM relationship_messages WHERE analyzed = 0`).get() as { count: number };
    return row?.count ?? 0;
  }

  saveAnalysis(date: string, metricsJson: string, summary: string, messageCount: number, voiceMinutes: number) {
    this.stmts.saveAnalysis.run(date, metricsJson, summary, messageCount, voiceMinutes);
  }

  getAnalyses(limit: number = 30): RelationshipAnalysis[] {
    return this.stmts.getAnalyses.all(limit) as RelationshipAnalysis[];
  }

  getAnalysis(date: string): RelationshipAnalysis | undefined {
    return this.stmts.getAnalysis.get(date) as RelationshipAnalysis | undefined;
  }

  getMessages(limit: number = 50): RelationshipMessage[] {
    return this.stmts.getMessages.all(limit) as RelationshipMessage[];
  }

  getMessagesByDate(date: string): RelationshipMessage[] {
    return this.stmts.getMessagesByDate.all(date) as RelationshipMessage[];
  }

  getStats() {
    return this.stmts.getStats.get() as any;
  }

  getStatsByRange(startTs: number, endTs: number) {
    return this.stmts.getStatsByRange.get(startTs, endTs) as any;
  }

  getAnalysesByRange(startDate: string, endDate: string): RelationshipAnalysis[] {
    return this.stmts.getAnalysesByRange.all(startDate, endDate) as RelationshipAnalysis[];
  }

  getInitiatorStats(startTs: number, endTs: number) {
    return this.stmts.getInitiatorStats.all(startTs, endTs) as Array<{ speaker: string; initiations: number }>;
  }

  getResponseTimes(startTs: number, endTs: number) {
    return this.stmts.getResponseTimes.all(startTs, endTs) as Array<{ speaker: string; avg_response_sec: number; responses: number }>;
  }

  getVolumeByDay(startTs: number, endTs: number) {
    return this.stmts.getVolumeByDay.all(startTs, endTs) as Array<{ day: string; speaker: string; count: number }>;
  }

  getDayMessageCounts(date: string): { total: number; voice: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN type = 'voice' THEN 1 ELSE 0 END) as voice
      FROM relationship_messages WHERE date(datetime(timestamp, 'unixepoch')) = ?
    `).get(date) as { total: number; voice: number };
    return { total: row?.total ?? 0, voice: row?.voice ?? 0 };
  }

  getUntranscribedVoiceMessages(): RelationshipMessage[] {
    return this.stmts.getUntranscribedVoice.all() as RelationshipMessage[];
  }

  updateTranscript(id: string, transcript: string) {
    this.stmts.updateTranscript.run(transcript, id);
  }

  getHealth() {
    const lastTs = (this.stmts.getLastTimestamp.get() as any)?.ts || null;
    const todayCount = (this.stmts.getTodayCount.get() as any)?.count || 0;
    return { lastMessageTimestamp: lastTs, todayMessageCount: todayCount };
  }

  /** Fetch messages from the last N hours */
  getRecentMessages(hours: number = 24): RelationshipMessage[] {
    const sinceTs = Math.floor(Date.now() / 1000) - hours * 3600;
    return this.db.prepare(
      `SELECT * FROM relationship_messages WHERE timestamp >= ? ORDER BY timestamp ASC`
    ).all(sinceTs) as RelationshipMessage[];
  }

  /** Fetch messages between two dates (for AI chat tool use) */
  getMessagesByRange(startDate: string, endDate: string): RelationshipMessage[] {
    return this.db.prepare(
      `SELECT * FROM relationship_messages WHERE date(datetime(timestamp, 'unixepoch')) >= ? AND date(datetime(timestamp, 'unixepoch')) <= ? ORDER BY timestamp ASC`
    ).all(startDate, endDate) as RelationshipMessage[];
  }

  /** Compact daily message counts for the last N days (for AI chat context) */
  getDailyMessageCounts(days: number): Array<{ day: string; count: number }> {
    return this.db.prepare(`
      SELECT date(datetime(timestamp, 'unixepoch')) as day, COUNT(*) as count
      FROM relationship_messages
      WHERE timestamp >= unixepoch('now', '-' || ? || ' days')
      GROUP BY day ORDER BY day DESC
    `).all(days) as Array<{ day: string; count: number }>;
  }

  /** Get all analysis summaries (compact — for AI chat context) */
  getAllAnalysisSummaries(): Array<{ date: string; score: number; summary: string }> {
    return this.db.prepare(`
      SELECT date, json_extract(metrics_json, '$.overallHealthScore') as score, summary
      FROM relationship_analyses ORDER BY date DESC
    `).all() as Array<{ date: string; score: number; summary: string }>;
  }

  deleteMessage(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM relationship_messages WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  getInPersonStats() {
    const total = this.db.prepare(
      `SELECT COUNT(*) as count FROM relationship_messages WHERE source = 'in-person'`
    ).get() as { count: number };
    const today = this.db.prepare(
      `SELECT COUNT(*) as count FROM relationship_messages WHERE source = 'in-person' AND date(datetime(timestamp, 'unixepoch')) = date('now')`
    ).get() as { count: number };
    const lastMsg = this.db.prepare(
      `SELECT * FROM relationship_messages WHERE source = 'in-person' ORDER BY timestamp DESC LIMIT 1`
    ).get() as RelationshipMessage | undefined;
    const recent = this.db.prepare(
      `SELECT * FROM relationship_messages WHERE source = 'in-person' ORDER BY timestamp DESC LIMIT 20`
    ).all() as RelationshipMessage[];
    return {
      totalMessages: total?.count ?? 0,
      todayMessages: today?.count ?? 0,
      lastMessageAt: lastMsg ? lastMsg.timestamp : null,
      recentMessages: recent,
    };
  }

}
