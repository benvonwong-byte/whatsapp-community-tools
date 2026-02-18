import Database from "better-sqlite3";
import { config } from "../../config";
import { computeQualityScore } from "./metrics";
import { SettingsStore } from "../../utils/base-store";

// ── Interfaces ──

export interface FriendsChat {
  chat_id: string;
  chat_name: string;
  is_group: number;
  participant_count: number;
  monitored: number;
  created_at: string;
}

export interface FriendsContact {
  id: string;
  name: string;
  first_seen: number;
  last_seen: number;
  notes: string;
  tier_id: number | null;
  created_at: string;
}

export interface FriendsTier {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  is_default: number;
  created_at: string;
}

export interface FriendsVoiceNote {
  id: string;
  contact_id: string;
  chat_id: string;
  transcript: string;
  duration_estimate: number;
  timestamp: number;
  is_from_me: number;
  created_at: string;
}

export interface FriendsTag {
  id: number;
  name: string;
  created_at: string;
}

export interface FriendsContactTag {
  contact_id: string;
  tag_id: number;
  confidence: number;
  last_seen: number;
  mention_count: number;
}

export interface FriendsMessageInput {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_name: string;
  timestamp: number;
  is_from_me: boolean;
  message_type: string;
  char_count: number;
}

export interface FriendsGroup {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
}

export interface ContactWithStats {
  id: string;
  name: string;
  first_seen: number;
  last_seen: number;
  notes: string;
  tier_id: number | null;
  tier_name: string | null;
  tier_color: string | null;
  total_messages: number;
  sent_messages: number;
  received_messages: number;
  messages_30d: number;
  group_names: string | null;
  tag_names: string | null;
  initiation_ratio: number;
  my_avg_response_sec: number;
  their_avg_response_sec: number;
  quality_score: number;
}

export interface DashboardStats {
  totalContacts: number;
  activeContacts30d: number;
  totalGroups: number;
  messagesThisWeek: number;
  totalMessages: number;
}

export interface ActivityPoint {
  period: string;
  sent: number;
  received: number;
}

// ── Store ──

export class FriendsStore extends SettingsStore {
  declare private stmts: {
    upsertChat: Database.Statement;
    getChats: Database.Statement;
    setChatMonitored: Database.Statement;
    getChatMonitored: Database.Statement;

    upsertContact: Database.Statement;
    updateLastSeen: Database.Statement;
    getContacts: Database.Statement;
    getContact: Database.Statement;
    updateContactNotes: Database.Statement;

    saveMessage: Database.Statement;
    isDuplicate: Database.Statement;

    getGroups: Database.Statement;
    createGroup: Database.Statement;
    updateGroup: Database.Statement;
    deleteGroup: Database.Statement;
    addContactToGroup: Database.Statement;
    removeContactFromGroup: Database.Statement;
    getContactGroups: Database.Statement;
    getGroupMembers: Database.Statement;

    getLastTimestamp: Database.Statement;
    getTodayCount: Database.Statement;
  };

  protected initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS friends_chats (
        chat_id TEXT PRIMARY KEY,
        chat_name TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0,
        participant_count INTEGER DEFAULT 1,
        monitored INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS friends_contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_friends_contacts_last_seen ON friends_contacts(last_seen);

      CREATE TABLE IF NOT EXISTS friends_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT DEFAULT '',
        timestamp INTEGER NOT NULL,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        message_type TEXT DEFAULT 'text',
        char_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_friends_msgs_chat ON friends_messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_friends_msgs_sender ON friends_messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_friends_msgs_timestamp ON friends_messages(timestamp);

      CREATE TABLE IF NOT EXISTS friends_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#4fc3f7',
        sort_order INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS friends_contact_groups (
        contact_id TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        PRIMARY KEY (contact_id, group_id),
        FOREIGN KEY (contact_id) REFERENCES friends_contacts(id),
        FOREIGN KEY (group_id) REFERENCES friends_groups(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friends_tiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#4fc3f7',
        sort_order INTEGER DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS friends_voice_notes (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        transcript TEXT DEFAULT '',
        duration_estimate REAL DEFAULT 30.0,
        timestamp INTEGER NOT NULL,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_friends_voice_contact ON friends_voice_notes(contact_id);
      CREATE INDEX IF NOT EXISTS idx_friends_voice_timestamp ON friends_voice_notes(timestamp);

      CREATE TABLE IF NOT EXISTS friends_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS friends_contact_tags (
        contact_id TEXT NOT NULL,
        tag_id INTEGER NOT NULL,
        confidence REAL DEFAULT 1.0,
        last_seen INTEGER NOT NULL,
        mention_count INTEGER DEFAULT 1,
        PRIMARY KEY (contact_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS friends_tag_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT NOT NULL,
        message_body TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Migration: add tier_id column to friends_contacts
    try {
      this.db.exec(`ALTER TABLE friends_contacts ADD COLUMN tier_id INTEGER REFERENCES friends_tiers(id) ON DELETE SET NULL`);
    } catch { /* column already exists */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_contacts_tier ON friends_contacts(tier_id)`);

    // Migration: add display_name column to friends_contacts
    try {
      this.db.exec(`ALTER TABLE friends_contacts ADD COLUMN display_name TEXT DEFAULT NULL`);
    } catch { /* column already exists */ }

    // Migration: add hidden_from_neglected column
    try {
      this.db.exec(`ALTER TABLE friends_contacts ADD COLUMN hidden_from_neglected INTEGER DEFAULT 0`);
    } catch { /* column already exists */ }

    // Seed default tiers if none exist
    const tierCount = (this.db.prepare(`SELECT COUNT(*) as c FROM friends_tiers`).get() as any).c;
    if (tierCount === 0) {
      const seedTiers = this.db.prepare(`INSERT INTO friends_tiers (name, color, sort_order, is_default) VALUES (?, ?, ?, ?)`);
      seedTiers.run("Inner Circle", "#e91e63", 0, 1);
      seedTiers.run("Close Friends", "#4fc3f7", 1, 0);
      seedTiers.run("Acquaintances", "#fdcb6e", 2, 0);
      seedTiers.run("New", "#00b894", 3, 0);
      seedTiers.run("Dormant", "#636e72", 4, 0);
      console.log("[friends] Seeded 5 default tiers.");
    }

    this.initSettings("friends_settings");

    this.stmts = {
      upsertChat: this.db.prepare(`
        INSERT INTO friends_chats (chat_id, chat_name, is_group, participant_count)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          chat_name = excluded.chat_name,
          participant_count = excluded.participant_count
      `),
      getChats: this.db.prepare(`SELECT * FROM friends_chats ORDER BY chat_name ASC`),
      setChatMonitored: this.db.prepare(`UPDATE friends_chats SET monitored = ? WHERE chat_id = ?`),
      getChatMonitored: this.db.prepare(`SELECT monitored FROM friends_chats WHERE chat_id = ?`),

      upsertContact: this.db.prepare(`
        INSERT INTO friends_contacts (id, name, first_seen, last_seen)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = CASE WHEN excluded.name != '' THEN excluded.name ELSE friends_contacts.name END,
          last_seen = MAX(friends_contacts.last_seen, excluded.last_seen)
      `),
      updateLastSeen: this.db.prepare(`UPDATE friends_contacts SET last_seen = MAX(last_seen, ?) WHERE id = ?`),
      getContacts: this.db.prepare(`SELECT * FROM friends_contacts ORDER BY last_seen DESC`),
      getContact: this.db.prepare(`SELECT *, COALESCE(display_name, name) as name, name as original_name FROM friends_contacts WHERE id = ?`),
      updateContactNotes: this.db.prepare(`UPDATE friends_contacts SET notes = ? WHERE id = ?`),

      saveMessage: this.db.prepare(`
        INSERT OR IGNORE INTO friends_messages (id, chat_id, sender_id, sender_name, timestamp, is_from_me, message_type, char_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      isDuplicate: this.db.prepare(`SELECT 1 FROM friends_messages WHERE id = ?`),

      getGroups: this.db.prepare(`SELECT * FROM friends_groups ORDER BY sort_order ASC, name ASC`),
      createGroup: this.db.prepare(`INSERT INTO friends_groups (name, color) VALUES (?, ?)`),
      updateGroup: this.db.prepare(`UPDATE friends_groups SET name = ?, color = ?, sort_order = ? WHERE id = ?`),
      deleteGroup: this.db.prepare(`DELETE FROM friends_groups WHERE id = ?`),
      addContactToGroup: this.db.prepare(`INSERT OR IGNORE INTO friends_contact_groups (contact_id, group_id) VALUES (?, ?)`),
      removeContactFromGroup: this.db.prepare(`DELETE FROM friends_contact_groups WHERE contact_id = ? AND group_id = ?`),
      getContactGroups: this.db.prepare(`
        SELECT g.* FROM friends_groups g
        JOIN friends_contact_groups cg ON g.id = cg.group_id
        WHERE cg.contact_id = ?
        ORDER BY g.sort_order ASC
      `),
      getGroupMembers: this.db.prepare(`
        SELECT c.* FROM friends_contacts c
        JOIN friends_contact_groups cg ON c.id = cg.contact_id
        WHERE cg.group_id = ?
        ORDER BY c.name ASC
      `),

      getLastTimestamp: this.db.prepare(`SELECT MAX(timestamp) as ts FROM friends_messages`),
      getTodayCount: this.db.prepare(
        `SELECT COUNT(*) as count FROM friends_messages WHERE date(datetime(timestamp, 'unixepoch', 'localtime')) = date('now', 'localtime')`
      ),
    };
  }

  // ── Chat methods ──

  upsertChat(chatId: string, chatName: string, isGroup: boolean, participantCount: number) {
    this.stmts.upsertChat.run(chatId, chatName, isGroup ? 1 : 0, participantCount);
  }

  getChats(): FriendsChat[] {
    return this.stmts.getChats.all() as FriendsChat[];
  }

  getMonitoredChatIds(): Set<string> {
    const rows = this.db.prepare(`SELECT chat_id FROM friends_chats WHERE monitored = 1`).all() as Array<{ chat_id: string }>;
    return new Set(rows.map(r => r.chat_id));
  }

  getChatMonitored(chatId: string): boolean {
    const row = this.stmts.getChatMonitored.get(chatId) as { monitored: number } | undefined;
    return row ? row.monitored === 1 : true; // default to monitored if not found
  }

  setChatMonitored(chatId: string, monitored: boolean) {
    this.stmts.setChatMonitored.run(monitored ? 1 : 0, chatId);
  }

  // ── Contact methods ──

  upsertContact(id: string, name: string, timestamp: number) {
    this.stmts.upsertContact.run(id, name, timestamp, timestamp);
  }

  updateLastSeen(id: string, timestamp: number) {
    this.stmts.updateLastSeen.run(timestamp, id);
  }

  getContacts(): FriendsContact[] {
    return this.stmts.getContacts.all() as FriendsContact[];
  }

  getContact(id: string): FriendsContact | undefined {
    return this.stmts.getContact.get(id) as FriendsContact | undefined;
  }

  updateContactNotes(id: string, notes: string) {
    this.stmts.updateContactNotes.run(notes, id);
  }

  updateDisplayName(id: string, displayName: string | null) {
    this.db.prepare(`UPDATE friends_contacts SET display_name = ? WHERE id = ?`).run(displayName || null, id);
  }

  // ── Message methods ──

  saveMessage(msg: FriendsMessageInput) {
    this.stmts.saveMessage.run(
      msg.id, msg.chat_id, msg.sender_id, msg.sender_name,
      msg.timestamp, msg.is_from_me ? 1 : 0, msg.message_type, msg.char_count
    );
  }

  isDuplicate(id: string): boolean {
    return !!this.stmts.isDuplicate.get(id);
  }

  // ── Group methods ──

  getGroups(): FriendsGroup[] {
    return this.stmts.getGroups.all() as FriendsGroup[];
  }

  createGroup(name: string, color: string): number {
    const result = this.stmts.createGroup.run(name, color);
    return result.lastInsertRowid as number;
  }

  updateGroup(id: number, name: string, color: string, sortOrder: number) {
    this.stmts.updateGroup.run(name, color, sortOrder, id);
  }

  deleteGroup(id: number) {
    this.stmts.deleteGroup.run(id);
  }

  addContactToGroup(contactId: string, groupId: number) {
    this.stmts.addContactToGroup.run(contactId, groupId);
  }

  removeContactFromGroup(contactId: string, groupId: number) {
    this.stmts.removeContactFromGroup.run(contactId, groupId);
  }

  getContactGroups(contactId: string): FriendsGroup[] {
    return this.stmts.getContactGroups.all(contactId) as FriendsGroup[];
  }

  getGroupMembers(groupId: number): FriendsContact[] {
    return this.stmts.getGroupMembers.all(groupId) as FriendsContact[];
  }

  // ── Analytics ──

  getDashboardStats(): DashboardStats {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 86400;
    const weekAgo = now - 7 * 86400;

    // Only count contacts that have DM chats (not group-only contacts, not broadcasts)
    const total = this.db.prepare(`
      SELECT COUNT(DISTINCT c.id) as c FROM friends_contacts c
      WHERE c.id NOT LIKE '%@broadcast'
        AND EXISTS (SELECT 1 FROM friends_messages m JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
          WHERE m.chat_id NOT LIKE '%@broadcast' AND (m.sender_id = c.id OR m.chat_id = c.id))
    `).get() as any;
    const active = this.db.prepare(`
      SELECT COUNT(DISTINCT c.id) as c FROM friends_contacts c
      WHERE c.last_seen >= ?
        AND c.id NOT LIKE '%@broadcast'
        AND EXISTS (SELECT 1 FROM friends_messages m JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
          WHERE m.chat_id NOT LIKE '%@broadcast' AND (m.sender_id = c.id OR m.chat_id = c.id))
    `).get(thirtyDaysAgo) as any;
    const groups = this.db.prepare(`SELECT COUNT(*) as c FROM friends_groups`).get() as any;
    const weekMsgs = this.db.prepare(
      `SELECT COUNT(*) as c FROM friends_messages m JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0 WHERE m.chat_id NOT LIKE '%@broadcast' AND m.timestamp >= ?`
    ).get(weekAgo) as any;
    const totalMsgs = this.db.prepare(
      `SELECT COUNT(*) as c FROM friends_messages m JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0 WHERE m.chat_id NOT LIKE '%@broadcast'`
    ).get() as any;

    return {
      totalContacts: total.c,
      activeContacts30d: active.c,
      totalGroups: groups.c,
      messagesThisWeek: weekMsgs.c,
      totalMessages: totalMsgs.c,
    };
  }

  getWeeklyVolume(weeks: number): Array<{ week: string; count: number; sent: number; received: number }> {
    const startTs = Math.floor(Date.now() / 1000) - weeks * 7 * 86400;
    return this.db.prepare(`
      SELECT
        strftime('%Y-W%W', datetime(m.timestamp, 'unixepoch', 'localtime')) as week,
        COUNT(*) as count,
        SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
      FROM friends_messages m
      JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
      WHERE m.timestamp >= ? AND m.chat_id NOT LIKE '%@broadcast'
      GROUP BY week
      ORDER BY week ASC
    `).all(startTs) as any[];
  }

  getNeglectedContacts(daysSilent: number): any[] {
    const cutoff = Math.floor(Date.now() / 1000) - daysSilent * 86400;
    return this.db.prepare(`
      SELECT
        c.id, COALESCE(c.display_name, c.name) as name,
        c.last_seen,
        c.tier_id, t.name as tier_name, t.color as tier_color,
        COALESCE(msg_stats.total_messages, 0) as total_messages,
        (SELECT GROUP_CONCAT(tg.name, ', ')
         FROM friends_contact_tags ct JOIN friends_tags tg ON tg.id = ct.tag_id
         WHERE ct.contact_id = c.id) as tag_names,
        (SELECT GROUP_CONCAT(g.name, ', ')
         FROM friends_contact_groups cg JOIN friends_groups g ON g.id = cg.group_id
         WHERE cg.contact_id = c.id) as group_names
      FROM friends_contacts c
      LEFT JOIN friends_tiers t ON t.id = c.tier_id
      LEFT JOIN (
        SELECT m.chat_id, COUNT(*) as total_messages
        FROM friends_messages m
        JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
        GROUP BY m.chat_id
      ) msg_stats ON msg_stats.chat_id = c.id
      WHERE c.last_seen < ? AND c.last_seen > 0
        AND c.id NOT LIKE '%@broadcast'
        AND COALESCE(c.hidden_from_neglected, 0) = 0
      ORDER BY c.last_seen ASC
      LIMIT 100
    `).all(cutoff) as any[];
  }

  dismissNeglectedContact(contactId: string): void {
    this.db.prepare(`UPDATE friends_contacts SET hidden_from_neglected = 1 WHERE id = ?`).run(contactId);
  }

  undismissNeglectedContact(contactId: string): void {
    this.db.prepare(`UPDATE friends_contacts SET hidden_from_neglected = 0 WHERE id = ?`).run(contactId);
  }

  getTopInitiators(limit: number): Array<{ contact_id: string; name: string; my_initiations: number; their_initiations: number }> {
    const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;
    return this.db.prepare(`
      WITH chat_gaps AS (
        SELECT
          m.chat_id,
          m.is_from_me,
          m.timestamp,
          LAG(m.timestamp) OVER (PARTITION BY m.chat_id ORDER BY m.timestamp) as prev_ts
        FROM friends_messages m
        JOIN friends_chats c ON c.chat_id = m.chat_id AND c.is_group = 0
        WHERE m.timestamp >= ?
      ),
      initiations AS (
        SELECT chat_id, is_from_me
        FROM chat_gaps
        WHERE (timestamp - COALESCE(prev_ts, 0)) > 14400
      ),
      contact_map AS (
        SELECT DISTINCT chat_id,
          (SELECT sender_id FROM friends_messages fm
           WHERE fm.chat_id = initiations.chat_id AND fm.is_from_me = 0 LIMIT 1) as contact_id
        FROM initiations
      )
      SELECT
        cm.contact_id,
        COALESCE(fc.display_name, fc.name) as name,
        SUM(CASE WHEN i.is_from_me = 1 THEN 1 ELSE 0 END) as my_initiations,
        SUM(CASE WHEN i.is_from_me = 0 THEN 1 ELSE 0 END) as their_initiations
      FROM initiations i
      JOIN contact_map cm ON cm.chat_id = i.chat_id
      JOIN friends_contacts fc ON fc.id = cm.contact_id
      GROUP BY cm.contact_id
      ORDER BY (my_initiations + their_initiations) DESC
      LIMIT ?
    `).all(ninetyDaysAgo, limit) as any[];
  }

  getContactsWithStats(): ContactWithStats[] {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 86400;
    const ninetyDaysAgo = now - 90 * 86400;

    // Get all contacts with basic message stats, tier info, and tags (DM chats only)
    const contacts = this.db.prepare(`
      SELECT
        c.id, COALESCE(c.display_name, c.name) as name, c.first_seen, c.last_seen, c.notes,
        c.tier_id, t.name as tier_name, t.color as tier_color,
        COALESCE(stats.total_messages, 0) as total_messages,
        COALESCE(stats.sent_messages, 0) as sent_messages,
        COALESCE(stats.received_messages, 0) as received_messages,
        COALESCE(stats.messages_30d, 0) as messages_30d,
        (SELECT GROUP_CONCAT(g.name, ', ')
         FROM friends_contact_groups cg
         JOIN friends_groups g ON g.id = cg.group_id
         WHERE cg.contact_id = c.id) as group_names,
        (SELECT GROUP_CONCAT(tg.name, ', ')
         FROM friends_contact_tags ct
         JOIN friends_tags tg ON tg.id = ct.tag_id
         WHERE ct.contact_id = c.id) as tag_names
      FROM friends_contacts c
      LEFT JOIN friends_tiers t ON t.id = c.tier_id
      LEFT JOIN (
        SELECT
          CASE WHEN fm.is_from_me = 0 THEN fm.sender_id
               ELSE (SELECT sender_id FROM friends_messages fm2
                     WHERE fm2.chat_id = fm.chat_id AND fm2.is_from_me = 0
                     LIMIT 1)
          END as contact_id,
          COUNT(*) as total_messages,
          SUM(CASE WHEN fm.is_from_me = 1 THEN 1 ELSE 0 END) as sent_messages,
          SUM(CASE WHEN fm.is_from_me = 0 THEN 1 ELSE 0 END) as received_messages,
          SUM(CASE WHEN fm.timestamp >= ? THEN 1 ELSE 0 END) as messages_30d
        FROM friends_messages fm
        JOIN friends_chats ch ON ch.chat_id = fm.chat_id AND ch.is_group = 0
        WHERE fm.chat_id NOT LIKE '%@broadcast'
        GROUP BY contact_id
      ) stats ON stats.contact_id = c.id
      WHERE stats.total_messages > 0 AND c.id NOT LIKE '%@broadcast'
      ORDER BY c.last_seen DESC
    `).all(thirtyDaysAgo) as any[];

    // Compute initiation and response metrics per contact
    return contacts.map((c: any) => {
      const init = this.getInitiatorStatsForContact(c.id, ninetyDaysAgo, now);
      const resp = this.getResponseTimesForContact(c.id, ninetyDaysAgo, now);
      const totalInit = (init.my_initiations + init.their_initiations) || 1;
      const initiationRatio = Math.round((init.my_initiations / totalInit) * 100);

      const weeklyStdDev = this.getWeeklyStdDev(c.id, ninetyDaysAgo, now);

      const quality = computeQualityScore({
        initiationRatio,
        myAvgResponseSec: resp.my_avg_response_sec,
        theirAvgResponseSec: resp.their_avg_response_sec,
        messages30d: c.messages_30d,
        weeklyStdDev,
      });

      return {
        ...c,
        initiation_ratio: initiationRatio,
        my_avg_response_sec: Math.round(resp.my_avg_response_sec),
        their_avg_response_sec: Math.round(resp.their_avg_response_sec),
        quality_score: quality.totalScore,
      };
    });
  }

  getInitiatorStatsForContact(contactId: string, startTs: number, endTs: number) {
    const result = this.db.prepare(`
      WITH contact_chats AS (
        SELECT DISTINCT m.chat_id FROM friends_messages m
        JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
        WHERE m.sender_id = ?
      ),
      msgs AS (
        SELECT
          is_from_me,
          timestamp,
          LAG(timestamp) OVER (PARTITION BY chat_id ORDER BY timestamp) as prev_ts
        FROM friends_messages
        WHERE chat_id IN (SELECT chat_id FROM contact_chats)
          AND timestamp >= ? AND timestamp <= ?
      )
      SELECT
        COALESCE(SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END), 0) as my_initiations,
        COALESCE(SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END), 0) as their_initiations
      FROM msgs
      WHERE (timestamp - COALESCE(prev_ts, 0)) > 14400
    `).get(contactId, startTs, endTs) as any;

    return {
      my_initiations: result?.my_initiations || 0,
      their_initiations: result?.their_initiations || 0,
    };
  }

  getResponseTimesForContact(contactId: string, startTs: number, endTs: number) {
    const result = this.db.prepare(`
      WITH contact_chats AS (
        SELECT DISTINCT m.chat_id FROM friends_messages m
        JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
        WHERE m.sender_id = ?
      ),
      ordered AS (
        SELECT
          is_from_me,
          timestamp,
          LAG(is_from_me) OVER (PARTITION BY chat_id ORDER BY timestamp) as prev_from_me,
          LAG(timestamp) OVER (PARTITION BY chat_id ORDER BY timestamp) as prev_ts
        FROM friends_messages
        WHERE chat_id IN (SELECT chat_id FROM contact_chats)
          AND timestamp >= ? AND timestamp <= ?
      )
      SELECT
        COALESCE(AVG(CASE WHEN is_from_me = 1 AND prev_from_me = 0 THEN timestamp - prev_ts END), 3600) as my_avg_response_sec,
        COALESCE(AVG(CASE WHEN is_from_me = 0 AND prev_from_me = 1 THEN timestamp - prev_ts END), 3600) as their_avg_response_sec
      FROM ordered
      WHERE is_from_me != prev_from_me
        AND (timestamp - prev_ts) < 14400
        AND (timestamp - prev_ts) > 0
    `).get(contactId, startTs, endTs) as any;

    return {
      my_avg_response_sec: result?.my_avg_response_sec || 3600,
      their_avg_response_sec: result?.their_avg_response_sec || 3600,
    };
  }

  getContactActivity(contactId: string, granularity: "day" | "week" | "month"): ActivityPoint[] {
    const fmt = granularity === "day" ? "%Y-%m-%d"
      : granularity === "week" ? "%Y-W%W"
      : "%Y-%m";

    const sixMonthsAgo = Math.floor(Date.now() / 1000) - 180 * 86400;

    return this.db.prepare(`
      WITH contact_chats AS (
        SELECT DISTINCT m.chat_id FROM friends_messages m
        JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
        WHERE m.sender_id = ?
      )
      SELECT
        strftime('${fmt}', datetime(timestamp, 'unixepoch', 'localtime')) as period,
        SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received
      FROM friends_messages
      WHERE chat_id IN (SELECT chat_id FROM contact_chats)
        AND timestamp >= ?
      GROUP BY period
      ORDER BY period ASC
    `).all(contactId, sixMonthsAgo) as ActivityPoint[];
  }

  getContactStats(contactId: string, startTs: number, endTs: number) {
    const init = this.getInitiatorStatsForContact(contactId, startTs, endTs);
    const resp = this.getResponseTimesForContact(contactId, startTs, endTs);

    const msgStats = this.db.prepare(`
      WITH contact_chats AS (
        SELECT DISTINCT m.chat_id FROM friends_messages m
        JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
        WHERE m.sender_id = ?
      )
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received
      FROM friends_messages
      WHERE chat_id IN (SELECT chat_id FROM contact_chats)
        AND timestamp >= ? AND timestamp <= ?
    `).get(contactId, startTs, endTs) as any;

    const totalInit = (init.my_initiations + init.their_initiations) || 1;
    const initiationRatio = Math.round((init.my_initiations / totalInit) * 100);

    return {
      total_messages: msgStats?.total || 0,
      sent_messages: msgStats?.sent || 0,
      received_messages: msgStats?.received || 0,
      initiation_ratio: initiationRatio,
      my_avg_response_sec: Math.round(resp.my_avg_response_sec),
      their_avg_response_sec: Math.round(resp.their_avg_response_sec),
    };
  }

  private getWeeklyStdDev(contactId: string, startTs: number, endTs: number): number {
    const weeks = this.db.prepare(`
      WITH contact_chats AS (
        SELECT DISTINCT m.chat_id FROM friends_messages m
        JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
        WHERE m.sender_id = ?
      )
      SELECT
        strftime('%Y-W%W', datetime(timestamp, 'unixepoch', 'localtime')) as week,
        COUNT(*) as count
      FROM friends_messages
      WHERE chat_id IN (SELECT chat_id FROM contact_chats)
        AND timestamp >= ? AND timestamp <= ?
      GROUP BY week
    `).all(contactId, startTs, endTs) as Array<{ week: string; count: number }>;

    if (weeks.length < 2) return 0;
    const mean = weeks.reduce((s, w) => s + w.count, 0) / weeks.length;
    const variance = weeks.reduce((s, w) => s + Math.pow(w.count - mean, 2), 0) / weeks.length;
    return Math.sqrt(variance);
  }

  // ── Tier methods ──

  getTiers(): FriendsTier[] {
    return this.db.prepare(`SELECT * FROM friends_tiers ORDER BY sort_order ASC, name ASC`).all() as FriendsTier[];
  }

  createTier(name: string, color: string): number {
    const maxOrder = (this.db.prepare(`SELECT MAX(sort_order) as m FROM friends_tiers`).get() as any)?.m || 0;
    const result = this.db.prepare(`INSERT INTO friends_tiers (name, color, sort_order) VALUES (?, ?, ?)`).run(name, color, maxOrder + 1);
    return result.lastInsertRowid as number;
  }

  updateTier(id: number, name: string, color: string, sortOrder: number) {
    this.db.prepare(`UPDATE friends_tiers SET name = ?, color = ?, sort_order = ? WHERE id = ?`).run(name, color, sortOrder, id);
  }

  deleteTier(id: number) {
    this.db.prepare(`DELETE FROM friends_tiers WHERE id = ?`).run(id);
  }

  setContactTier(contactId: string, tierId: number | null) {
    this.db.prepare(`UPDATE friends_contacts SET tier_id = ? WHERE id = ?`).run(tierId, contactId);
  }

  getTierDistribution(): Array<{ tier_id: number | null; tier_name: string | null; tier_color: string | null; count: number }> {
    return this.db.prepare(`
      SELECT c.tier_id, t.name as tier_name, t.color as tier_color, COUNT(*) as count
      FROM friends_contacts c
      LEFT JOIN friends_tiers t ON t.id = c.tier_id
      GROUP BY c.tier_id
      ORDER BY t.sort_order ASC
    `).all() as any[];
  }

  // ── Voice note methods ──

  saveVoiceNote(note: { id: string; contact_id: string; chat_id: string; transcript: string; duration_estimate: number; timestamp: number; is_from_me: boolean }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO friends_voice_notes (id, contact_id, chat_id, transcript, duration_estimate, timestamp, is_from_me)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(note.id, note.contact_id, note.chat_id, note.transcript, note.duration_estimate, note.timestamp, note.is_from_me ? 1 : 0);
  }

  isVoiceNoteDuplicate(id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM friends_voice_notes WHERE id = ?`).get(id);
  }

  getVoiceNotesByContact(contactId: string, limit = 50): FriendsVoiceNote[] {
    return this.db.prepare(`
      SELECT * FROM friends_voice_notes WHERE contact_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(contactId, limit) as FriendsVoiceNote[];
  }

  getVoiceStatsByContact(contactId: string): { total_notes: number; total_minutes: number; sent_notes: number; received_notes: number; last_voice: number | null } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_notes,
        COALESCE(SUM(duration_estimate) / 60.0, 0) as total_minutes,
        SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_notes,
        SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_notes,
        MAX(timestamp) as last_voice
      FROM friends_voice_notes WHERE contact_id = ?
    `).get(contactId) as any;
    return {
      total_notes: row?.total_notes || 0,
      total_minutes: Math.round((row?.total_minutes || 0) * 10) / 10,
      sent_notes: row?.sent_notes || 0,
      received_notes: row?.received_notes || 0,
      last_voice: row?.last_voice || null,
    };
  }

  getVoiceStatsAll(): Array<{ contact_id: string; name: string; total_notes: number; total_minutes: number; sent_notes: number; received_notes: number }> {
    return this.db.prepare(`
      SELECT
        v.contact_id, COALESCE(c.display_name, c.name) as name,
        COUNT(*) as total_notes,
        ROUND(SUM(v.duration_estimate) / 60.0, 1) as total_minutes,
        SUM(CASE WHEN v.is_from_me = 1 THEN 1 ELSE 0 END) as sent_notes,
        SUM(CASE WHEN v.is_from_me = 0 THEN 1 ELSE 0 END) as received_notes
      FROM friends_voice_notes v
      JOIN friends_contacts c ON c.id = v.contact_id
      GROUP BY v.contact_id
      ORDER BY total_minutes DESC
    `).all() as any[];
  }

  getDashboardVoiceTotal(): { total_notes: number; total_minutes: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total_notes, COALESCE(SUM(duration_estimate) / 60.0, 0) as total_minutes
      FROM friends_voice_notes
    `).get() as any;
    return { total_notes: row?.total_notes || 0, total_minutes: Math.round((row?.total_minutes || 0) * 10) / 10 };
  }

  // ── Tag methods ──

  getOrCreateTag(name: string): number {
    const normalized = name.toLowerCase().trim();
    const existing = this.db.prepare(`SELECT id FROM friends_tags WHERE name = ?`).get(normalized) as { id: number } | undefined;
    if (existing) return existing.id;
    const result = this.db.prepare(`INSERT INTO friends_tags (name) VALUES (?)`).run(normalized);
    return result.lastInsertRowid as number;
  }

  addContactTag(contactId: string, tagName: string, timestamp: number, confidence = 1.0) {
    const tagId = this.getOrCreateTag(tagName);
    this.db.prepare(`
      INSERT INTO friends_contact_tags (contact_id, tag_id, confidence, last_seen, mention_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(contact_id, tag_id) DO UPDATE SET
        confidence = MAX(friends_contact_tags.confidence, excluded.confidence),
        last_seen = MAX(friends_contact_tags.last_seen, excluded.last_seen),
        mention_count = friends_contact_tags.mention_count + 1
    `).run(contactId, tagId, confidence, timestamp);
  }

  getContactTags(contactId: string): Array<{ tag_id: number; name: string; confidence: number; mention_count: number }> {
    return this.db.prepare(`
      SELECT ct.tag_id, t.name, ct.confidence, ct.mention_count
      FROM friends_contact_tags ct
      JOIN friends_tags t ON t.id = ct.tag_id
      WHERE ct.contact_id = ?
      ORDER BY ct.mention_count DESC
    `).all(contactId) as any[];
  }

  getAllTags(): Array<{ id: number; name: string; contact_count: number }> {
    return this.db.prepare(`
      SELECT t.id, t.name, COUNT(ct.contact_id) as contact_count
      FROM friends_tags t
      LEFT JOIN friends_contact_tags ct ON ct.tag_id = t.id
      GROUP BY t.id
      ORDER BY contact_count DESC
    `).all() as any[];
  }

  getContactsWithTags(tagNames: string[], mode: "AND" | "OR" = "OR"): string[] {
    if (tagNames.length === 0) return [];
    const placeholders = tagNames.map(() => "?").join(",");
    if (mode === "OR") {
      const rows = this.db.prepare(`
        SELECT DISTINCT ct.contact_id
        FROM friends_contact_tags ct
        JOIN friends_tags t ON t.id = ct.tag_id
        WHERE t.name IN (${placeholders})
      `).all(...tagNames) as Array<{ contact_id: string }>;
      return rows.map(r => r.contact_id);
    } else {
      const rows = this.db.prepare(`
        SELECT ct.contact_id
        FROM friends_contact_tags ct
        JOIN friends_tags t ON t.id = ct.tag_id
        WHERE t.name IN (${placeholders})
        GROUP BY ct.contact_id
        HAVING COUNT(DISTINCT t.name) = ?
      `).all(...tagNames, tagNames.length) as Array<{ contact_id: string }>;
      return rows.map(r => r.contact_id);
    }
  }

  removeContactTag(contactId: string, tagId: number): boolean {
    const result = this.db.prepare(`DELETE FROM friends_contact_tags WHERE contact_id = ? AND tag_id = ?`).run(contactId, tagId);
    return result.changes > 0;
  }

  // ── Tag buffer methods ──

  addToTagBuffer(contactId: string, body: string, timestamp: number) {
    this.db.prepare(`INSERT INTO friends_tag_buffer (contact_id, message_body, timestamp) VALUES (?, ?, ?)`).run(contactId, body, timestamp);
  }

  getTagBufferContacts(minMessages = 20): Array<{ contact_id: string; message_count: number }> {
    return this.db.prepare(`
      SELECT contact_id, COUNT(*) as message_count
      FROM friends_tag_buffer
      GROUP BY contact_id
      HAVING message_count >= ?
    `).all(minMessages) as any[];
  }

  getTagBufferMessages(contactId: string): Array<{ message_body: string; timestamp: number }> {
    return this.db.prepare(`
      SELECT message_body, timestamp FROM friends_tag_buffer
      WHERE contact_id = ?
      ORDER BY timestamp ASC
    `).all(contactId) as any[];
  }

  clearTagBufferForContact(contactId: string) {
    this.db.prepare(`DELETE FROM friends_tag_buffer WHERE contact_id = ?`).run(contactId);
  }

  // ── Calendar ──

  getCalendarData(year: number, month: number): Array<{ day: number; contacts: Array<{ id: string; name: string; count: number; tier_color: string | null }> }> {
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

    const rows = this.db.prepare(`
      WITH daily AS (
        SELECT
          CAST(strftime('%d', datetime(m.timestamp, 'unixepoch', 'localtime')) AS INTEGER) as day,
          CASE WHEN m.is_from_me = 0 THEN m.sender_id
               ELSE (SELECT sender_id FROM friends_messages fm2
                     WHERE fm2.chat_id = m.chat_id AND fm2.is_from_me = 0
                     LIMIT 1)
          END as contact_id,
          COUNT(*) as msg_count
        FROM friends_messages m
        JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
        WHERE date(datetime(m.timestamp, 'unixepoch', 'localtime')) >= ? AND date(datetime(m.timestamp, 'unixepoch', 'localtime')) < ?
          AND m.chat_id NOT LIKE '%@broadcast'
        GROUP BY day, contact_id
      ),
      ranked AS (
        SELECT day, contact_id, msg_count,
          ROW_NUMBER() OVER (PARTITION BY day ORDER BY msg_count DESC) as rn
        FROM daily
        WHERE contact_id IS NOT NULL
      )
      SELECT r.day, r.contact_id as id, COALESCE(c.display_name, c.name) as name, r.msg_count as count, t.color as tier_color
      FROM ranked r
      LEFT JOIN friends_contacts c ON c.id = r.contact_id
      LEFT JOIN friends_tiers t ON t.id = c.tier_id
      WHERE r.rn <= 5
      ORDER BY r.day ASC, r.msg_count DESC
    `).all(startDate, endDate) as any[];

    // Group by day
    const dayMap = new Map<number, Array<{ id: string; name: string; count: number; tier_color: string | null }>>();
    for (const row of rows) {
      if (!dayMap.has(row.day)) dayMap.set(row.day, []);
      dayMap.get(row.day)!.push({ id: row.id, name: row.name || "Unknown", count: row.count, tier_color: row.tier_color });
    }

    return Array.from(dayMap.entries()).map(([day, contacts]) => ({ day, contacts }));
  }

  // ── Enhanced Dashboard Analytics ──

  /** Top friends by message volume within a time window — DM chats only */
  getTopFriends(limit = 5, windowDays = 30, offsetDays = 0): Array<{ id: string; name: string; messages: number; messages_prev: number; tier_color: string | null; tag_names: string | null }> {
    const now = Math.floor(Date.now() / 1000);
    const windowEnd = now - offsetDays * 86400;
    const windowStart = windowEnd - windowDays * 86400;
    const prevStart = windowStart - windowDays * 86400;
    return this.db.prepare(`
      SELECT
        c.id, COALESCE(c.display_name, c.name) as name,
        SUM(CASE WHEN m.timestamp >= ? AND m.timestamp < ? THEN 1 ELSE 0 END) as messages,
        SUM(CASE WHEN m.timestamp >= ? AND m.timestamp < ? THEN 1 ELSE 0 END) as messages_prev,
        t.color as tier_color,
        (SELECT GROUP_CONCAT(tg.name, ', ')
         FROM friends_contact_tags ct JOIN friends_tags tg ON tg.id = ct.tag_id
         WHERE ct.contact_id = c.id) as tag_names
      FROM friends_contacts c
      JOIN friends_chats ch ON ch.chat_id = c.id AND ch.is_group = 0
      JOIN friends_messages m ON m.chat_id = c.id
      LEFT JOIN friends_tiers t ON t.id = c.tier_id
      WHERE m.timestamp >= ?
        AND c.id NOT LIKE '%@broadcast'
      GROUP BY c.id
      ORDER BY messages DESC
      LIMIT ?
    `).all(windowStart, windowEnd, prevStart, windowStart, prevStart, limit) as any[];
  }

  /** Reciprocity stats per contact — sent/received balance (DM only), sorted by healthiest balance */
  getReciprocityStats(): Array<{ id: string; name: string; sent: number; received: number; ratio: number; tag_names: string | null; group_names: string | null }> {
    return this.db.prepare(`
      SELECT
        c.id, COALESCE(c.display_name, c.name) as name,
        SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
        (SELECT GROUP_CONCAT(tg.name, ', ')
         FROM friends_contact_tags ct JOIN friends_tags tg ON tg.id = ct.tag_id
         WHERE ct.contact_id = c.id) as tag_names,
        (SELECT GROUP_CONCAT(g.name, ', ')
         FROM friends_contact_groups cg JOIN friends_groups g ON g.id = cg.group_id
         WHERE cg.contact_id = c.id) as group_names
      FROM friends_contacts c
      JOIN friends_chats ch ON ch.chat_id = c.id AND ch.is_group = 0
      JOIN friends_messages m ON m.chat_id = c.id
      WHERE c.id NOT LIKE '%@broadcast'
      GROUP BY c.id
      HAVING (sent + received) > 10
      ORDER BY (sent + received) DESC
    `).all().map((r: any) => ({
      ...r,
      ratio: Math.round(Math.min(r.sent, r.received) / Math.max(r.sent, r.received, 1) * 100),
    })).sort((a: any, b: any) => b.ratio - a.ratio) as any[];
  }

  /** Streak data: consecutive days with messages per contact (DM only) */
  getLongestStreaks(limit = 5): Array<{ id: string; name: string; current_streak: number; longest_streak: number }> {
    const contacts = this.db.prepare(`
      SELECT c.id, COALESCE(c.display_name, c.name) as name FROM friends_contacts c
      JOIN friends_chats ch ON ch.chat_id = c.id AND ch.is_group = 0
      WHERE c.id NOT LIKE '%@broadcast'
      ORDER BY c.last_seen DESC LIMIT 50
    `).all() as any[];
    const results: Array<{ id: string; name: string; current_streak: number; longest_streak: number }> = [];

    for (const c of contacts) {
      const days = this.db.prepare(`
        SELECT DISTINCT date(datetime(m.timestamp, 'unixepoch', 'localtime')) as day
        FROM friends_messages m
        WHERE m.chat_id = ?
        ORDER BY day ASC
      `).all(c.id) as Array<{ day: string }>;

      if (days.length < 2) continue;

      let longest = 1, current = 1;
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 1; i < days.length; i++) {
        const prev = new Date(days[i - 1].day).getTime();
        const curr = new Date(days[i].day).getTime();
        if (curr - prev === 86400000) {
          current++;
          if (current > longest) longest = current;
        } else {
          current = 1;
        }
      }
      // Check if current streak is still active (last day is today or yesterday)
      const lastDay = days[days.length - 1].day;
      const isActive = lastDay === today || lastDay === new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      results.push({ id: c.id, name: c.name, current_streak: isActive ? current : 0, longest_streak: longest });
    }

    return results.sort((a, b) => b.longest_streak - a.longest_streak).slice(0, limit);
  }

  /** Message volume by hour of day (DM only) */
  getHourlyDistribution(): Array<{ hour: number; count: number }> {
    return this.db.prepare(`
      SELECT CAST(strftime('%H', datetime(m.timestamp, 'unixepoch', 'localtime')) AS INTEGER) as hour,
        COUNT(*) as count
      FROM friends_messages m
      JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
      WHERE m.chat_id NOT LIKE '%@broadcast'
      GROUP BY hour
      ORDER BY hour ASC
    `).all() as any[];
  }

  /** Fastest responders */
  getFastestResponders(limit = 5): Array<{ id: string; name: string; avg_response_sec: number }> {
    const now = Math.floor(Date.now() / 1000);
    const ninetyDaysAgo = now - 90 * 86400;
    const contacts = this.db.prepare(`SELECT id, COALESCE(display_name, name) as name FROM friends_contacts WHERE last_seen >= ? ORDER BY last_seen DESC`).all(ninetyDaysAgo) as any[];
    const results: Array<{ id: string; name: string; avg_response_sec: number }> = [];
    for (const c of contacts) {
      const resp = this.getResponseTimesForContact(c.id, ninetyDaysAgo, now);
      if (resp.their_avg_response_sec > 0) {
        results.push({ id: c.id, name: c.name, avg_response_sec: Math.round(resp.their_avg_response_sec) });
      }
    }
    return results.sort((a, b) => a.avg_response_sec - b.avg_response_sec).slice(0, limit);
  }

  /** Most balanced friendship (closest reciprocity to 50/50) */
  getMostBalanced(): { id: string; name: string; sent: number; received: number; ratio: number } | null {
    const stats = this.getReciprocityStats();
    if (stats.length === 0) return null;
    return stats.reduce((best, curr) => curr.ratio > best.ratio ? curr : best);
  }

  // ── Health ──

  getHealth() {
    const lastTs = (this.stmts.getLastTimestamp.get() as any)?.ts || null;
    const todayCount = (this.stmts.getTodayCount.get() as any)?.count || 0;
    return { lastMessageTimestamp: lastTs, todayMessageCount: todayCount };
  }

}
