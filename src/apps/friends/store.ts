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
  body?: string;
  source?: string; // 'whatsapp' | 'imessage'
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

      CREATE TABLE IF NOT EXISTS friends_call_recordings (
        id TEXT PRIMARY KEY,
        contact_id TEXT DEFAULT NULL,
        title TEXT DEFAULT '',
        call_type TEXT DEFAULT 'phone',
        duration_seconds INTEGER DEFAULT 0,
        transcript_text TEXT DEFAULT '',
        utterances_json TEXT DEFAULT '[]',
        speaker_map_json TEXT DEFAULT '{}',
        assemblyai_id TEXT DEFAULT '',
        audio_captured TEXT DEFAULT 'mic',
        status TEXT DEFAULT 'recording',
        error_message TEXT DEFAULT '',
        recorded_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_friends_calls_contact ON friends_call_recordings(contact_id);
      CREATE INDEX IF NOT EXISTS idx_friends_calls_status ON friends_call_recordings(status);
      CREATE INDEX IF NOT EXISTS idx_friends_calls_recorded ON friends_call_recordings(recorded_at);
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

    // Migration: add hidden column (hide/ignore contacts from all views)
    try {
      this.db.exec(`ALTER TABLE friends_contacts ADD COLUMN hidden INTEGER DEFAULT 0`);
    } catch { /* column already exists */ }

    // Migration: add body column to friends_messages
    try {
      this.db.exec(`ALTER TABLE friends_messages ADD COLUMN body TEXT DEFAULT ''`);
    } catch { /* column already exists */ }

    // Migration: add source column to friends_messages
    try {
      this.db.exec(`ALTER TABLE friends_messages ADD COLUMN source TEXT DEFAULT 'whatsapp'`);
    } catch { /* column already exists */ }

    // Migration: add phone_normalized to friends_contacts
    try {
      this.db.exec(`ALTER TABLE friends_contacts ADD COLUMN phone_normalized TEXT DEFAULT ''`);
    } catch { /* column already exists */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_contacts_phone ON friends_contacts(phone_normalized)`);

    // Migration: create friends_contact_notes table for timestamped notes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS friends_contact_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_friends_contact_notes_cid ON friends_contact_notes(contact_id);
    `);

    // Migrate existing notes from friends_contacts.notes to friends_contact_notes
    const legacyNotes = this.db.prepare(`
      SELECT id, notes FROM friends_contacts WHERE notes IS NOT NULL AND notes != ''
    `).all() as Array<{ id: string; notes: string }>;
    if (legacyNotes.length > 0) {
      const existingNoteContacts = new Set(
        (this.db.prepare(`SELECT DISTINCT contact_id FROM friends_contact_notes`).all() as Array<{ contact_id: string }>)
          .map(r => r.contact_id)
      );
      const insertNote = this.db.prepare(`
        INSERT INTO friends_contact_notes (contact_id, content, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
      `);
      let migrated = 0;
      for (const row of legacyNotes) {
        if (!existingNoteContacts.has(row.id)) {
          insertNote.run(row.id, row.notes);
          migrated++;
        }
      }
      if (migrated > 0) {
        console.log(`[friends] Migrated ${migrated} legacy notes to friends_contact_notes`);
        this.db.exec(`UPDATE friends_contacts SET notes = '' WHERE notes IS NOT NULL AND notes != ''`);
      }
    }

    // Performance indexes for 160K+ messages
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_msgs_chat_ts ON friends_messages(chat_id, timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_msgs_chat_fromme ON friends_messages(chat_id, is_from_me, timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_chats_isgroup ON friends_chats(is_group, chat_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_msgs_sender_chat ON friends_messages(sender_id, chat_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_contact_tags_cid ON friends_contact_tags(contact_id)`);

    // Backfill phone_normalized from WhatsApp IDs
    this.db.exec(`
      UPDATE friends_contacts
      SET phone_normalized = REPLACE(REPLACE(id, '@c.us', ''), '@s.whatsapp.net', '')
      WHERE phone_normalized = ''
        AND (id LIKE '%@c.us' OR id LIKE '%@s.whatsapp.net')
    `);

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
        INSERT OR IGNORE INTO friends_messages (id, chat_id, sender_id, sender_name, timestamp, is_from_me, message_type, char_count, body, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  // ── Timestamped contact notes ──

  getContactNotes(contactId: string): Array<{ id: number; content: string; created_at: string; updated_at: string }> {
    return this.db.prepare(`
      SELECT id, content, created_at, updated_at
      FROM friends_contact_notes WHERE contact_id = ?
      ORDER BY created_at DESC
    `).all(contactId) as any[];
  }

  addContactNote(contactId: string, content: string): number {
    const result = this.db.prepare(`
      INSERT INTO friends_contact_notes (contact_id, content) VALUES (?, ?)
    `).run(contactId, content);
    return Number(result.lastInsertRowid);
  }

  updateContactNote(noteId: number, content: string) {
    this.db.prepare(`
      UPDATE friends_contact_notes SET content = ?, updated_at = datetime('now') WHERE id = ?
    `).run(content, noteId);
  }

  deleteContactNote(noteId: number) {
    this.db.prepare(`DELETE FROM friends_contact_notes WHERE id = ?`).run(noteId);
  }

  updateDisplayName(id: string, displayName: string | null) {
    this.db.prepare(`UPDATE friends_contacts SET display_name = ? WHERE id = ?`).run(displayName || null, id);
  }

  hideContact(id: string) {
    this.db.prepare(`UPDATE friends_contacts SET hidden = 1 WHERE id = ?`).run(id);
  }

  unhideContact(id: string) {
    this.db.prepare(`UPDATE friends_contacts SET hidden = 0 WHERE id = ?`).run(id);
  }

  getHiddenContacts(): Array<{ id: string; name: string }> {
    return this.db.prepare(`SELECT id, COALESCE(display_name, name) as name FROM friends_contacts WHERE hidden = 1 ORDER BY name`).all() as any[];
  }

  // ── Message methods ──

  saveMessage(msg: FriendsMessageInput) {
    this.stmts.saveMessage.run(
      msg.id, msg.chat_id, msg.sender_id, msg.sender_name,
      msg.timestamp, msg.is_from_me ? 1 : 0, msg.message_type, msg.char_count, msg.body || "",
      msg.source || "whatsapp"
    );
  }

  updateMessageBody(id: string, body: string) {
    this.db.prepare(`UPDATE friends_messages SET body = ? WHERE id = ? AND (body IS NULL OR body = '')`).run(body, id);
  }

  isDuplicate(id: string): boolean {
    return !!this.stmts.isDuplicate.get(id);
  }

  getContactMessages(contactId: string, limit = 50, offset = 0): any[] {
    return this.db.prepare(`
      SELECT m.id, m.sender_name, m.body, m.timestamp, m.is_from_me, m.message_type,
             m.source, vn.transcript AS voice_transcript
      FROM friends_messages m
      LEFT JOIN friends_voice_notes vn ON vn.id = m.id
      WHERE m.chat_id = ?
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `).all(contactId, limit, offset) as any[];
  }

  // Get messages for a contact across all linked chat_ids (WhatsApp + iMessage)
  getContactMessagesAllSources(contactId: string, limit = 50, offset = 0): any[] {
    // Find all chat_ids that belong to this contact (same phone number)
    const contact = this.db.prepare(`SELECT phone_normalized FROM friends_contacts WHERE id = ?`).get(contactId) as any;
    if (!contact || !contact.phone_normalized) {
      // No phone number — just return messages for this exact chat_id
      return this.getContactMessages(contactId, limit, offset);
    }
    // Find all contact IDs with the same phone number
    return this.db.prepare(`
      SELECT m.id, m.sender_name, m.body, m.timestamp, m.is_from_me, m.message_type,
             m.source, vn.transcript AS voice_transcript
      FROM friends_messages m
      LEFT JOIN friends_voice_notes vn ON vn.id = m.id
      WHERE m.chat_id IN (SELECT id FROM friends_contacts WHERE phone_normalized = ?)
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `).all(contact.phone_normalized, limit, offset) as any[];
  }

  // ── iMessage sync methods ──

  findContactByPhone(phoneNormalized: string): any {
    return this.db.prepare(
      `SELECT * FROM friends_contacts WHERE phone_normalized = ? LIMIT 1`
    ).get(phoneNormalized);
  }

  upsertImessageContact(phone: string, name: string, timestamp: number): string {
    const existing = this.findContactByPhone(phone);
    if (existing) {
      // Update last_seen if newer
      this.stmts.updateLastSeen.run(timestamp, existing.id);
      if (name && !existing.name) {
        this.db.prepare(`UPDATE friends_contacts SET name = ? WHERE id = ?`).run(name, existing.id);
      }
      // Ensure a friends_chats entry exists for this contact (needed for dashboard queries)
      this.stmts.upsertChat.run(existing.id, name || existing.name || phone, 0, 2);
      return existing.id;
    }
    // Create new iMessage-only contact
    const contactId = phone + "@imessage";
    this.db.prepare(`
      INSERT OR IGNORE INTO friends_contacts (id, name, first_seen, last_seen, phone_normalized)
      VALUES (?, ?, ?, ?, ?)
    `).run(contactId, name, timestamp, timestamp, phone);
    // Register as a DM chat so dashboard queries include it
    this.stmts.upsertChat.run(contactId, name || phone, 0, 2);
    return contactId;
  }

  syncImessageMessages(messages: Array<{
    guid: string;
    phone: string;
    sender_name: string;
    text: string;
    timestamp: number;
    is_from_me: boolean;
  }>): { imported: number; updated: number } {
    let imported = 0, updated = 0;

    const insertMsg = this.db.prepare(`
      INSERT OR IGNORE INTO friends_messages (id, chat_id, sender_id, sender_name, timestamp, is_from_me, message_type, char_count, body, source)
      VALUES (?, ?, ?, ?, ?, ?, 'chat', ?, ?, 'imessage')
    `);

    const txn = this.db.transaction(() => {
      for (const msg of messages) {
        const contactId = this.upsertImessageContact(msg.phone, msg.sender_name, msg.timestamp);
        const msgId = "imsg_" + msg.guid;
        const senderId = msg.is_from_me ? "self" : contactId;

        const result = insertMsg.run(
          msgId, contactId, senderId, msg.sender_name,
          msg.timestamp, msg.is_from_me ? 1 : 0,
          msg.text?.length || 0, msg.text || ""
        );

        if (result.changes > 0) imported++;
        else updated++;
      }
    });
    txn();

    return { imported, updated };
  }

  syncImessageVoiceNotes(notes: Array<{
    guid: string;
    phone: string;
    sender_name: string;
    timestamp: number;
    is_from_me: boolean;
    transcript: string;
    duration: number;
  }>): { imported: number } {
    let imported = 0;

    const insertMsg = this.db.prepare(`
      INSERT OR IGNORE INTO friends_messages (id, chat_id, sender_id, sender_name, timestamp, is_from_me, message_type, char_count, body, source)
      VALUES (?, ?, ?, ?, ?, ?, 'ptt', 0, '', 'imessage')
    `);

    const insertVn = this.db.prepare(`
      INSERT OR IGNORE INTO friends_voice_notes (id, contact_id, chat_id, transcript, duration_estimate, timestamp, is_from_me)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      for (const note of notes) {
        const contactId = this.upsertImessageContact(note.phone, note.sender_name, note.timestamp);
        const msgId = "imsg_" + note.guid;
        const senderId = note.is_from_me ? "self" : contactId;

        const result = insertMsg.run(
          msgId, contactId, senderId, note.sender_name,
          note.timestamp, note.is_from_me ? 1 : 0
        );
        if (result.changes > 0) {
          insertVn.run(msgId, contactId, contactId, note.transcript, note.duration, note.timestamp, note.is_from_me ? 1 : 0);
          imported++;
        }
      }
    });
    txn();

    return { imported };
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

  private tierClause(tierId: number | null | undefined, alias = "c"): string {
    if (tierId === undefined) return "";
    if (tierId === null) return ` AND ${alias}.tier_id IS NULL`;
    return ` AND ${alias}.tier_id = ${Number(tierId)}`;
  }

  getDashboardStats(tierId?: number | null): DashboardStats {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 86400;
    const weekAgo = now - 7 * 86400;
    const tf = this.tierClause(tierId);

    // Count contacts that have DM chats via friends_chats (fast: no message scan)
    const total = this.db.prepare(`
      SELECT COUNT(*) as c FROM friends_contacts c
      JOIN friends_chats ch ON ch.chat_id = c.id AND ch.is_group = 0
      WHERE c.id NOT LIKE '%@broadcast'${tf}
    `).get() as any;
    const active = this.db.prepare(`
      SELECT COUNT(*) as c FROM friends_contacts c
      JOIN friends_chats ch ON ch.chat_id = c.id AND ch.is_group = 0
      WHERE c.last_seen >= ? AND c.id NOT LIKE '%@broadcast'${tf}
    `).get(thirtyDaysAgo) as any;
    const groups = this.db.prepare(`SELECT COUNT(*) as c FROM friends_groups`).get() as any;
    const weekMsgs = this.db.prepare(
      `SELECT COUNT(*) as c FROM friends_messages m JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0 ${tierId !== undefined ? 'JOIN friends_contacts c ON c.id = m.chat_id' : ''} WHERE m.chat_id NOT LIKE '%@broadcast' AND m.timestamp >= ?${tf}`
    ).get(weekAgo) as any;
    const totalMsgs = this.db.prepare(
      `SELECT COUNT(*) as c FROM friends_messages m JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0 ${tierId !== undefined ? 'JOIN friends_contacts c ON c.id = m.chat_id' : ''} WHERE m.chat_id NOT LIKE '%@broadcast'${tf}`
    ).get() as any;

    return {
      totalContacts: total.c,
      activeContacts30d: active.c,
      totalGroups: groups.c,
      messagesThisWeek: weekMsgs.c,
      totalMessages: totalMsgs.c,
    };
  }

  getWeeklyVolume(weeks: number, tierId?: number | null): Array<{ week: string; count: number; sent: number; received: number }> {
    const startTs = Math.floor(Date.now() / 1000) - weeks * 7 * 86400;
    const tf = this.tierClause(tierId);
    return this.db.prepare(`
      SELECT
        strftime('%Y-W%W', datetime(m.timestamp, 'unixepoch', 'localtime')) as week,
        COUNT(*) as count,
        SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
      FROM friends_messages m
      JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
      ${tierId !== undefined ? 'JOIN friends_contacts c ON c.id = m.chat_id' : ''}
      WHERE m.timestamp >= ? AND m.chat_id NOT LIKE '%@broadcast'${tf}
      GROUP BY week
      ORDER BY week ASC
    `).all(startTs) as any[];
  }

  getNeglectedContacts(daysSilent: number, tierId?: number | null): any[] {
    const cutoff = Math.floor(Date.now() / 1000) - daysSilent * 86400;
    const tf = this.tierClause(tierId);
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
        AND COALESCE(c.hidden_from_neglected, 0) = 0${tf}
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

  getTopInitiators(limit: number, tierId?: number | null): Array<{ contact_id: string; name: string; my_initiations: number; their_initiations: number }> {
    const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;
    const tf = this.tierClause(tierId, "fc");
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
      WHERE 1=1${tf}
      GROUP BY cm.contact_id
      ORDER BY (my_initiations + their_initiations) DESC
      LIMIT ?
    `).all(ninetyDaysAgo, limit) as any[];
  }

  getContactsWithStats(): ContactWithStats[] {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 86400;

    // Get all contacts with basic message stats, tier info, and tags (DM chats only)
    // Use chat_id directly as contact_id (since DM chat_id IS the contact id)
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
          fm.chat_id as contact_id,
          COUNT(*) as total_messages,
          SUM(CASE WHEN fm.is_from_me = 1 THEN 1 ELSE 0 END) as sent_messages,
          SUM(CASE WHEN fm.is_from_me = 0 THEN 1 ELSE 0 END) as received_messages,
          SUM(CASE WHEN fm.timestamp >= ? THEN 1 ELSE 0 END) as messages_30d
        FROM friends_messages fm
        JOIN friends_chats ch ON ch.chat_id = fm.chat_id AND ch.is_group = 0
        WHERE fm.chat_id NOT LIKE '%@broadcast'
        GROUP BY fm.chat_id
      ) stats ON stats.contact_id = c.id
      WHERE stats.total_messages > 0 AND c.id NOT LIKE '%@broadcast' AND COALESCE(c.hidden, 0) = 0
      ORDER BY c.last_seen DESC
    `).all(thirtyDaysAgo) as any[];

    // Skip expensive per-contact CTE queries (initiation, response times, weekly std dev)
    // These are computed on-demand when opening a contact detail panel instead
    return contacts.map((c: any) => ({
      ...c,
      initiation_ratio: 50,
      my_avg_response_sec: 0,
      their_avg_response_sec: 0,
      quality_score: Math.min(100, Math.round(
        (Math.min(c.messages_30d, 50) / 50) * 40 +
        (Math.min(c.sent_messages, c.received_messages) / Math.max(c.sent_messages, c.received_messages, 1)) * 40 +
        (c.messages_30d > 0 ? 20 : 0)
      )),
    }));
  }

  /** Get active days, word count (text msgs only), and voice note count per contact for graph metrics */
  getGraphMetrics(): { chat_id: string; active_days: number; total_chars_text: number; voice_notes: number }[] {
    return this.db.prepare(`
      SELECT fm.chat_id,
        COUNT(DISTINCT date(fm.timestamp, 'unixepoch')) as active_days,
        COALESCE(SUM(
          CASE WHEN fm.message_type IN ('text', 'chat') THEN fm.char_count ELSE 0 END
        ), 0) as total_chars_text,
        SUM(CASE WHEN fm.message_type = 'ptt' OR fm.message_type = 'audio' THEN 1 ELSE 0 END) as voice_notes
      FROM friends_messages fm
      JOIN friends_chats ch ON ch.chat_id = fm.chat_id AND ch.is_group = 0
      WHERE fm.chat_id NOT LIKE '%@broadcast'
      GROUP BY fm.chat_id
    `).all() as { chat_id: string; active_days: number; total_chars_text: number; voice_notes: number }[];
  }

  /** Resolve all DM chat_ids for a contact (handles both sender_id and chat_id lookups for iMessage) */
  private contactChatIds(contactId: string): string[] {
    const bySender = this.db.prepare(`
      SELECT DISTINCT m.chat_id FROM friends_messages m
      JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
      WHERE m.sender_id = ?
    `).all(contactId) as { chat_id: string }[];
    const byChat = this.db.prepare(`
      SELECT DISTINCT fm.chat_id FROM friends_messages fm
      JOIN friends_chats ch ON ch.chat_id = fm.chat_id AND ch.is_group = 0
      WHERE fm.chat_id = ?
    `).all(contactId) as { chat_id: string }[];
    const ids = new Set([...bySender.map(r => r.chat_id), ...byChat.map(r => r.chat_id)]);
    return [...ids];
  }

  getInitiatorStatsForContact(contactId: string, startTs?: number, endTs?: number) {
    const chatIds = this.contactChatIds(contactId);
    if (chatIds.length === 0) return { my_initiations: 0, their_initiations: 0 };
    const placeholders = chatIds.map(() => "?").join(",");
    const timeClause = startTs != null ? `AND timestamp >= ? AND timestamp <= ?` : "";
    const params: any[] = [...chatIds, ...(startTs != null ? [startTs, endTs] : [])];

    const result = this.db.prepare(`
      WITH msgs AS (
        SELECT
          is_from_me,
          timestamp,
          LAG(timestamp) OVER (PARTITION BY chat_id ORDER BY timestamp) as prev_ts
        FROM friends_messages
        WHERE chat_id IN (${placeholders})
          ${timeClause}
      )
      SELECT
        COALESCE(SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END), 0) as my_initiations,
        COALESCE(SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END), 0) as their_initiations
      FROM msgs
      WHERE (timestamp - COALESCE(prev_ts, 0)) > 14400
    `).get(...params) as any;

    return {
      my_initiations: result?.my_initiations || 0,
      their_initiations: result?.their_initiations || 0,
    };
  }

  getResponseTimesForContact(contactId: string, startTs?: number, endTs?: number) {
    const chatIds = this.contactChatIds(contactId);
    if (chatIds.length === 0) return { my_avg_response_sec: 3600, their_avg_response_sec: 3600 };
    const placeholders = chatIds.map(() => "?").join(",");
    const timeClause = startTs != null ? `AND timestamp >= ? AND timestamp <= ?` : "";
    const params: any[] = [...chatIds, ...(startTs != null ? [startTs, endTs] : [])];

    const result = this.db.prepare(`
      WITH ordered AS (
        SELECT
          is_from_me,
          timestamp,
          LAG(is_from_me) OVER (PARTITION BY chat_id ORDER BY timestamp) as prev_from_me,
          LAG(timestamp) OVER (PARTITION BY chat_id ORDER BY timestamp) as prev_ts
        FROM friends_messages
        WHERE chat_id IN (${placeholders})
          ${timeClause}
      )
      SELECT
        COALESCE(AVG(CASE WHEN is_from_me = 1 AND prev_from_me = 0 THEN timestamp - prev_ts END), 3600) as my_avg_response_sec,
        COALESCE(AVG(CASE WHEN is_from_me = 0 AND prev_from_me = 1 THEN timestamp - prev_ts END), 3600) as their_avg_response_sec
      FROM ordered
      WHERE is_from_me != prev_from_me
        AND (timestamp - prev_ts) < 14400
        AND (timestamp - prev_ts) > 0
    `).get(...params) as any;

    return {
      my_avg_response_sec: result?.my_avg_response_sec || 3600,
      their_avg_response_sec: result?.their_avg_response_sec || 3600,
    };
  }

  getContactActivity(contactId: string, granularity: "day" | "week" | "month", startTs?: number): ActivityPoint[] {
    const fmt = granularity === "day" ? "%Y-%m-%d"
      : granularity === "week" ? "%Y-W%W"
      : "%Y-%m";

    const chatIds = this.contactChatIds(contactId);
    if (chatIds.length === 0) return [];
    const placeholders = chatIds.map(() => "?").join(",");
    const since = startTs ?? (Math.floor(Date.now() / 1000) - 730 * 86400); // default: 2 years

    return this.db.prepare(`
      SELECT
        strftime('${fmt}', datetime(timestamp, 'unixepoch', 'localtime')) as period,
        SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received
      FROM friends_messages
      WHERE chat_id IN (${placeholders})
        AND timestamp >= ?
      GROUP BY period
      ORDER BY period ASC
    `).all(...chatIds, since) as ActivityPoint[];
  }

  getContactStats(contactId: string, startTs?: number, endTs?: number) {
    const init = this.getInitiatorStatsForContact(contactId, startTs, endTs);
    const resp = this.getResponseTimesForContact(contactId, startTs, endTs);

    const chatIds = this.contactChatIds(contactId);
    if (chatIds.length === 0) {
      return {
        total_messages: 0, sent_messages: 0, received_messages: 0,
        initiation_ratio: 0, my_avg_response_sec: 3600, their_avg_response_sec: 3600,
      };
    }
    const placeholders = chatIds.map(() => "?").join(",");
    const timeClause = startTs != null ? `AND fm.timestamp >= ? AND fm.timestamp <= ?` : "";
    const params: any[] = [...chatIds, ...(startTs != null ? [startTs, endTs] : [])];

    const msgStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN fm.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN fm.is_from_me = 0 THEN 1 ELSE 0 END) as received
      FROM friends_messages fm
      WHERE fm.chat_id IN (${placeholders})
        ${timeClause}
    `).get(...params) as any;

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

  updateTierSortOrder(id: number, sortOrder: number) {
    this.db.prepare(`UPDATE friends_tiers SET sort_order = ? WHERE id = ?`).run(sortOrder, id);
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

  getVoiceStatsByContact(contactId: string, startTs?: number, endTs?: number): { total_notes: number; total_minutes: number; sent_notes: number; received_notes: number; last_voice: number | null } {
    const timeClause = startTs != null ? `AND timestamp >= ? AND timestamp <= ?` : "";
    const params: any[] = [contactId, ...(startTs != null ? [startTs, endTs] : [])];
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_notes,
        COALESCE(SUM(duration_estimate) / 60.0, 0) as total_minutes,
        SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent_notes,
        SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received_notes,
        MAX(timestamp) as last_voice
      FROM friends_voice_notes WHERE contact_id = ? ${timeClause}
    `).get(...params) as any;
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

  getDashboardVoiceTotal(tierId?: number | null): { total_notes: number; total_minutes: number } {
    const tf = this.tierClause(tierId);
    const row = this.db.prepare(`
      SELECT COUNT(*) as total_notes, COALESCE(SUM(v.duration_estimate) / 60.0, 0) as total_minutes
      FROM friends_voice_notes v
      ${tierId !== undefined ? 'JOIN friends_contacts c ON c.id = v.contact_id' : ''}
      WHERE 1=1${tf}
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

  getContactTags(contactId: string): Array<{ tag_id: number; name: string; confidence: number; mention_count: number; contact_count: number }> {
    return this.db.prepare(`
      SELECT ct.tag_id, t.name, ct.confidence, ct.mention_count,
             (SELECT COUNT(*) FROM friends_contact_tags ct2 WHERE ct2.tag_id = ct.tag_id) as contact_count
      FROM friends_contact_tags ct
      JOIN friends_tags t ON t.id = ct.tag_id
      WHERE ct.contact_id = ?
      ORDER BY ct.mention_count DESC
    `).all(contactId) as any[];
  }

  getAllTags(tierId?: number | null): Array<{ id: number; name: string; contact_count: number }> {
    const tf = this.tierClause(tierId);
    if (tierId !== undefined) {
      return this.db.prepare(`
        SELECT t.id, t.name, COUNT(ct.contact_id) as contact_count
        FROM friends_tags t
        LEFT JOIN friends_contact_tags ct ON ct.tag_id = t.id
        LEFT JOIN friends_contacts c ON c.id = ct.contact_id
        WHERE 1=1${tf}
        GROUP BY t.id
        HAVING contact_count > 0
        ORDER BY contact_count DESC
      `).all() as any[];
    }
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

  /** Merge multiple source tags into a single canonical tag. Returns number of reassigned contact-tag rows. */
  mergeTags(sourceTagIds: number[], canonicalTagId: number): number {
    if (sourceTagIds.length === 0) return 0;
    let reassigned = 0;
    const txn = this.db.transaction(() => {
      for (const srcId of sourceTagIds) {
        if (srcId === canonicalTagId) continue;
        // For contacts that already have the canonical tag, merge mention_count
        this.db.prepare(`
          UPDATE friends_contact_tags SET
            mention_count = mention_count + COALESCE((SELECT mention_count FROM friends_contact_tags WHERE contact_id = friends_contact_tags.contact_id AND tag_id = ?), 0),
            confidence = MAX(confidence, COALESCE((SELECT confidence FROM friends_contact_tags WHERE contact_id = friends_contact_tags.contact_id AND tag_id = ?), 0))
          WHERE tag_id = ? AND contact_id IN (SELECT contact_id FROM friends_contact_tags WHERE tag_id = ?)
        `).run(srcId, srcId, canonicalTagId, srcId);
        // Delete the source tag rows for contacts that already have canonical
        this.db.prepare(`
          DELETE FROM friends_contact_tags WHERE tag_id = ? AND contact_id IN (SELECT contact_id FROM friends_contact_tags WHERE tag_id = ?)
        `).run(srcId, canonicalTagId);
        // Reassign remaining source tag rows to canonical
        const result = this.db.prepare(`UPDATE friends_contact_tags SET tag_id = ? WHERE tag_id = ?`).run(canonicalTagId, srcId);
        reassigned += result.changes;
        // Delete orphaned source tag
        this.db.prepare(`DELETE FROM friends_tags WHERE id = ? AND id NOT IN (SELECT DISTINCT tag_id FROM friends_contact_tags)`).run(srcId);
      }
    });
    txn();
    // Clean up any now-unused tags
    this.db.prepare(`DELETE FROM friends_tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM friends_contact_tags)`).run();
    return reassigned;
  }

  /** Rename a tag */
  renameTag(tagId: number, newName: string): boolean {
    const normalized = newName.toLowerCase().trim();
    // Check if target name already exists
    const existing = this.db.prepare(`SELECT id FROM friends_tags WHERE name = ? AND id != ?`).get(normalized, tagId) as { id: number } | undefined;
    if (existing) {
      // Merge into existing tag
      this.mergeTags([tagId], existing.id);
      return true;
    }
    this.db.prepare(`UPDATE friends_tags SET name = ? WHERE id = ?`).run(normalized, tagId);
    return true;
  }

  // ── Tag buffer methods ──

  addToTagBuffer(contactId: string, body: string, timestamp: number) {
    this.db.prepare(`INSERT INTO friends_tag_buffer (contact_id, message_body, timestamp) VALUES (?, ?, ?)`).run(contactId, body, timestamp);
  }

  /** Archive messages older than a given number of days. Deletes message bodies but keeps metadata. */
  archiveOldMessages(olderThanDays = 1095): { archived: number; freedChars: number } {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
    // Get stats first
    const stats = this.db.prepare(`
      SELECT COUNT(*) as count, SUM(LENGTH(body)) as chars
      FROM friends_messages WHERE timestamp < ? AND body != '' AND body IS NOT NULL
    `).get(cutoff) as any;
    // Clear body text but keep the message row (for count/stats tracking)
    this.db.prepare(`
      UPDATE friends_messages SET body = '' WHERE timestamp < ? AND body != '' AND body IS NOT NULL
    `).run(cutoff);
    return { archived: stats?.count || 0, freedChars: stats?.chars || 0 };
  }

  /** Search contacts by exact phrases in message content. Any phrase match counts; results sorted by total matches. */
  searchMessageContent(phrases: string[], limit = 50): Array<{ contact_id: string; name: string; tier_name: string | null; tier_color: string | null; tag_names: string | null; snippet: string; match_count: number }> {
    if (phrases.length === 0) return [];
    // Each phrase is searched as a complete substring (e.g. "guest room" searches for that exact phrase)
    const conditions = phrases.map(() => `LOWER(m.body) LIKE LOWER(?)`).join(" OR ");
    const snippetConditions = phrases.map(() => `LOWER(m2.body) LIKE LOWER(?)`).join(" OR ");
    const params = phrases.map(p => `%${p}%`);
    return this.db.prepare(`
      SELECT c.id as contact_id, COALESCE(c.display_name, c.name) as name,
             t.name as tier_name, t.color as tier_color,
             (SELECT GROUP_CONCAT(tg.name, ', ')
              FROM friends_contact_tags ct JOIN friends_tags tg ON tg.id = ct.tag_id
              WHERE ct.contact_id = c.id) as tag_names,
             (SELECT m2.body FROM friends_messages m2 WHERE m2.chat_id = c.id AND (${snippetConditions}) AND m2.body != '' ORDER BY m2.timestamp DESC LIMIT 1) as snippet,
             COUNT(*) as match_count
      FROM friends_messages m
      JOIN friends_contacts c ON c.id = m.chat_id
      JOIN friends_chats ch ON ch.chat_id = c.id AND ch.is_group = 0
      LEFT JOIN friends_tiers t ON t.id = c.tier_id
      WHERE (${conditions}) AND m.body != '' AND COALESCE(c.hidden, 0) = 0
      GROUP BY c.id
      ORDER BY match_count DESC
      LIMIT ?
    `).all(...params, ...params, limit) as any[];
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

  getCalendarData(year: number, month: number, tierId?: number | null): Array<{ day: number; contacts: Array<{ id: string; name: string; count: number; tier_color: string | null }> }> {
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;
    const tf = this.tierClause(tierId);

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
      WHERE r.rn <= 5${tf}
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
  getTopFriends(limit = 5, windowDays = 30, offsetDays = 0, tierId?: number | null): Array<{ id: string; name: string; messages: number; messages_prev: number; tier_color: string | null; tag_names: string | null }> {
    const now = Math.floor(Date.now() / 1000);
    const windowEnd = now - offsetDays * 86400;
    const windowStart = windowEnd - windowDays * 86400;
    const prevStart = windowStart - windowDays * 86400;
    const tf = this.tierClause(tierId);
    return this.db.prepare(`
      SELECT
        c.id, COALESCE(c.display_name, c.name) as name,
        SUM(CASE WHEN m.timestamp >= ? AND m.timestamp < ? THEN 1 ELSE 0 END) as messages,
        SUM(CASE WHEN m.timestamp >= ? AND m.timestamp < ? THEN 1 ELSE 0 END) as messages_prev,
        t.color as tier_color, t.name as tier_name,
        (SELECT GROUP_CONCAT(tg.name, ', ')
         FROM friends_contact_tags ct JOIN friends_tags tg ON tg.id = ct.tag_id
         WHERE ct.contact_id = c.id) as tag_names
      FROM friends_contacts c
      JOIN friends_chats ch ON ch.chat_id = c.id AND ch.is_group = 0
      JOIN friends_messages m ON m.chat_id = c.id
      LEFT JOIN friends_tiers t ON t.id = c.tier_id
      WHERE m.timestamp >= ?
        AND c.id NOT LIKE '%@broadcast'${tf}
      GROUP BY c.id
      ORDER BY messages DESC
      LIMIT ?
    `).all(windowStart, windowEnd, prevStart, windowStart, prevStart, limit) as any[];
  }

  /** Reciprocity stats per contact — sent/received balance (DM only), sorted by healthiest balance */
  getReciprocityStats(tierId?: number | null): Array<{ id: string; name: string; sent: number; received: number; ratio: number; tag_names: string | null; group_names: string | null }> {
    const tf = this.tierClause(tierId);
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
      WHERE c.id NOT LIKE '%@broadcast'${tf}
      GROUP BY c.id
      HAVING (sent + received) > 10
      ORDER BY (sent + received) DESC
    `).all().map((r: any) => ({
      ...r,
      ratio: Math.round(Math.min(r.sent, r.received) / Math.max(r.sent, r.received, 1) * 100),
    })).sort((a: any, b: any) => b.ratio - a.ratio) as any[];
  }

  /** Streak data: consecutive days with messages per contact (DM only) */
  getLongestStreaks(limit = 5, tierId?: number | null): Array<{ id: string; name: string; current_streak: number; longest_streak: number }> {
    const tf = this.tierClause(tierId);
    const contacts = this.db.prepare(`
      SELECT c.id, COALESCE(c.display_name, c.name) as name FROM friends_contacts c
      JOIN friends_chats ch ON ch.chat_id = c.id AND ch.is_group = 0
      WHERE c.id NOT LIKE '%@broadcast'${tf}
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
  getHourlyDistribution(tierId?: number | null): Array<{ hour: number; count: number }> {
    const tf = this.tierClause(tierId);
    return this.db.prepare(`
      SELECT CAST(strftime('%H', datetime(m.timestamp, 'unixepoch', 'localtime')) AS INTEGER) as hour,
        COUNT(*) as count
      FROM friends_messages m
      JOIN friends_chats ch ON ch.chat_id = m.chat_id AND ch.is_group = 0
      ${tierId !== undefined ? 'JOIN friends_contacts c ON c.id = m.chat_id' : ''}
      WHERE m.chat_id NOT LIKE '%@broadcast'${tf}
      GROUP BY hour
      ORDER BY hour ASC
    `).all() as any[];
  }

  /** Fastest responders */
  getFastestResponders(limit = 5, tierId?: number | null): Array<{ id: string; name: string; avg_response_sec: number }> {
    const now = Math.floor(Date.now() / 1000);
    const ninetyDaysAgo = now - 90 * 86400;
    const tf = this.tierClause(tierId).replace(/\bc\./g, 'friends_contacts.');
    const contacts = this.db.prepare(`SELECT id, COALESCE(display_name, name) as name FROM friends_contacts WHERE last_seen >= ?${tf} ORDER BY last_seen DESC`).all(ninetyDaysAgo) as any[];
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
  getMostBalanced(tierId?: number | null): { id: string; name: string; sent: number; received: number; ratio: number } | null {
    const stats = this.getReciprocityStats(tierId);
    if (stats.length === 0) return null;
    return stats.reduce((best, curr) => curr.ratio > best.ratio ? curr : best);
  }

  // ── Health ──

  getHealth() {
    const lastTs = (this.stmts.getLastTimestamp.get() as any)?.ts || null;
    const todayCount = (this.stmts.getTodayCount.get() as any)?.count || 0;
    return { lastMessageTimestamp: lastTs, todayMessageCount: todayCount };
  }

  // ── Call Recordings ──

  saveCallRecording(call: {
    id: string; contact_id?: string | null; title?: string; call_type?: string;
    duration_seconds: number; transcript_text: string; utterances_json: string;
    speaker_map_json?: string; assemblyai_id?: string; audio_captured?: string;
    status: string; error_message?: string; recorded_at: number;
  }) {
    this.db.prepare(`
      INSERT INTO friends_call_recordings (id, contact_id, title, call_type, duration_seconds, transcript_text, utterances_json, speaker_map_json, assemblyai_id, audio_captured, status, error_message, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        contact_id = excluded.contact_id, title = excluded.title, call_type = excluded.call_type,
        duration_seconds = excluded.duration_seconds, transcript_text = excluded.transcript_text,
        utterances_json = excluded.utterances_json, speaker_map_json = excluded.speaker_map_json,
        assemblyai_id = excluded.assemblyai_id, audio_captured = excluded.audio_captured,
        status = excluded.status, error_message = excluded.error_message
    `).run(
      call.id, call.contact_id || null, call.title || "", call.call_type || "phone",
      call.duration_seconds, call.transcript_text, call.utterances_json,
      call.speaker_map_json || "{}", call.assemblyai_id || "", call.audio_captured || "mic",
      call.status, call.error_message || "", call.recorded_at
    );
  }

  getCallRecording(id: string) {
    return this.db.prepare(`SELECT * FROM friends_call_recordings WHERE id = ?`).get(id) as any;
  }

  getCallRecordings(limit = 50, offset = 0, contactId?: string) {
    if (contactId) {
      return this.db.prepare(`
        SELECT cr.*, COALESCE(c.display_name, c.name) as contact_name
        FROM friends_call_recordings cr
        LEFT JOIN friends_contacts c ON c.id = cr.contact_id
        WHERE cr.contact_id = ? ORDER BY cr.recorded_at DESC LIMIT ? OFFSET ?
      `).all(contactId, limit, offset) as any[];
    }
    return this.db.prepare(`
      SELECT cr.*, COALESCE(c.display_name, c.name) as contact_name
      FROM friends_call_recordings cr
      LEFT JOIN friends_contacts c ON c.id = cr.contact_id
      ORDER BY cr.recorded_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];
  }

  updateCallContact(id: string, contactId: string | null) {
    this.db.prepare(`UPDATE friends_call_recordings SET contact_id = ? WHERE id = ?`).run(contactId, id);
  }

  updateCallSpeakers(id: string, speakerMap: string) {
    this.db.prepare(`UPDATE friends_call_recordings SET speaker_map_json = ? WHERE id = ?`).run(speakerMap, id);
  }

  updateCallTitle(id: string, title: string) {
    this.db.prepare(`UPDATE friends_call_recordings SET title = ? WHERE id = ?`).run(title, id);
  }

  deleteCallRecording(id: string) {
    this.db.prepare(`DELETE FROM friends_call_recordings WHERE id = ?`).run(id);
  }

  searchCallTranscripts(query: string, limit = 20) {
    return this.db.prepare(`
      SELECT cr.id, cr.title, cr.contact_id, COALESCE(c.display_name, c.name) as contact_name,
        cr.duration_seconds, cr.recorded_at, cr.status
      FROM friends_call_recordings cr
      LEFT JOIN friends_contacts c ON c.id = cr.contact_id
      WHERE cr.transcript_text LIKE ? OR cr.title LIKE ?
      ORDER BY cr.recorded_at DESC LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit) as any[];
  }

}
