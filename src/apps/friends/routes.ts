import { Router, Request, Response } from "express";
import { FriendsStore } from "./store";

export interface SendProgress {
  active: boolean;
  phase: "idle" | "sending" | "done" | "error";
  total: number;
  sent: number;
  failed: number;
  errorMessage?: string;
}

export function createFriendsRouter(
  store: FriendsStore,
  scanTrigger: () => Promise<number>,
  backfillTrigger: () => Promise<number>,
  sendMessageTrigger: (
    contactIds: string[],
    message: string,
    media: { base64: string; mimetype: string; filename: string } | null
  ) => Promise<void>,
  sendProgress: SendProgress,
  tagExtractTrigger?: () => Promise<number>,
  fetchHistoryTrigger?: (contactId: string) => Promise<number>,
  tagConsolidateTrigger?: () => Promise<{ merged: number; deleted: number; remaining: number }>
): Router {
  const router = Router();

  /** Parse a range string like "7d", "30d", "90d", "1y", "all" into startTs/endTs */
  function parseRange(range?: string): { startTs?: number; endTs?: number } {
    if (!range || range === "all") return {}; // undefined = no filter (all time)
    const now = Math.floor(Date.now() / 1000);
    const endTs = now;
    let startTs = 0;
    if (range === "7d") startTs = now - 7 * 86400;
    else if (range === "30d") startTs = now - 30 * 86400;
    else if (range === "90d") startTs = now - 90 * 86400;
    else if (range === "1y") startTs = now - 365 * 86400;
    else return {}; // unknown range = all time
    return { startTs, endTs };
  }

  // ── Dashboard ──

  router.get("/dashboard", (req: Request, res: Response) => {
    // Parse optional tier filter
    const tierParam = req.query.tier as string | undefined;
    let tierId: number | null | undefined = undefined;
    if (tierParam === "none") tierId = null;
    else if (tierParam && !isNaN(parseInt(tierParam))) tierId = parseInt(tierParam);

    const stats = store.getDashboardStats(tierId);
    const weeklyVolume = store.getWeeklyVolume(12, tierId);
    const neglected = store.getNeglectedContacts(30, tierId);
    const topInitiators = store.getTopInitiators(10, tierId);
    const health = store.getHealth();
    const tierDistribution = store.getTierDistribution(); // Always global
    const voiceTotal = store.getDashboardVoiceTotal(tierId);
    const topFriends = store.getTopFriends(5, 30, 0, tierId);
    const reciprocity = store.getReciprocityStats(tierId);
    const streaks = store.getLongestStreaks(5, tierId);
    const hourly = store.getHourlyDistribution(tierId);
    const fastResponders = store.getFastestResponders(5, tierId);
    const mostBalanced = store.getMostBalanced(tierId);
    res.json({ stats, weeklyVolume, neglected, topInitiators, health, tierDistribution, voiceTotal,
      topFriends, reciprocity, streaks, hourly, fastResponders, mostBalanced });
  });

  // ── Neglected Friends (time-browsable) ──

  router.get("/neglected", (req: Request, res: Response) => {
    const days = parseInt(req.query.days as string) || 30;
    const tierParam = req.query.tier as string | undefined;
    let tierId: number | null | undefined = undefined;
    if (tierParam === "none") tierId = null;
    else if (tierParam && !isNaN(parseInt(tierParam))) tierId = parseInt(tierParam);
    const contacts = store.getNeglectedContacts(days, tierId);
    res.json({ contacts, days });
  });

  // ── Top Friends (time-browsable) ──

  router.get("/top-friends", (req: Request, res: Response) => {
    const days = parseInt(req.query.days as string) || 30;
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 5;
    const tierParam = req.query.tier as string | undefined;
    let tierId: number | null | undefined = undefined;
    if (tierParam === "none") tierId = null;
    else if (tierParam && !isNaN(parseInt(tierParam))) tierId = parseInt(tierParam);
    const topFriends = store.getTopFriends(Math.min(limit, 20), days, offset, tierId);

    // Compute date labels for the window
    const now = new Date();
    const windowEnd = new Date(now.getTime() - offset * 86400000);
    const windowStart = new Date(windowEnd.getTime() - days * 86400000);
    res.json({
      friends: topFriends,
      window: { days, offset },
      dateRange: {
        start: windowStart.toISOString().slice(0, 10),
        end: windowEnd.toISOString().slice(0, 10),
      },
    });
  });

  // ── Contacts ──

  router.get("/contacts", (req: Request, res: Response) => {
    let contacts = store.getContactsWithStats();

    // Filter by group name
    const groupFilter = req.query.group as string;
    if (groupFilter) {
      contacts = contacts.filter(c => c.group_names?.includes(groupFilter));
    }

    // Filter by tier
    const tierFilter = req.query.tier as string;
    if (tierFilter) {
      const tierId = parseInt(tierFilter);
      if (tierFilter === "none") {
        contacts = contacts.filter(c => c.tier_id === null);
      } else if (!isNaN(tierId)) {
        contacts = contacts.filter(c => c.tier_id === tierId);
      }
    }

    // Filter by tags
    const tagsParam = req.query.tags as string;
    if (tagsParam) {
      const tagNames = tagsParam.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
      const tagMode = (req.query.tagMode as string || "OR").toUpperCase() as "AND" | "OR";
      if (tagNames.length > 0) {
        const matchingIds = new Set(store.getContactsWithTags(tagNames, tagMode));
        contacts = contacts.filter(c => matchingIds.has(c.id));
      }
    }

    // Filter by minimum quality score
    const minScore = parseInt(req.query.minScore as string);
    if (!isNaN(minScore)) {
      contacts = contacts.filter(c => c.quality_score >= minScore);
    }

    // Filter by search term
    const search = (req.query.search as string || "").toLowerCase();
    if (search) {
      contacts = contacts.filter(c => c.name.toLowerCase().includes(search));
    }

    // Sort
    const sort = (req.query.sort as string) || "last_seen";
    const dir = req.query.dir === "asc" ? 1 : -1;
    contacts.sort((a: any, b: any) => ((a[sort] ?? 0) - (b[sort] ?? 0)) * dir);

    res.json(contacts);
  });

  router.get("/contacts/:id", (req: Request, res: Response) => {
    const contact = store.getContact(decodeURIComponent(req.params.id as string));
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const { startTs, endTs } = parseRange(req.query.range as string);
    const stats = store.getContactStats(contact.id, startTs, endTs);
    const groups = store.getContactGroups(contact.id);
    const tags = store.getContactTags(contact.id);
    const voiceStats = store.getVoiceStatsByContact(contact.id, startTs, endTs);
    const notes = store.getContactNotes(contact.id);
    res.json({ contact, stats, groups, tags, voiceStats, notes, range: req.query.range || "all" });
  });

  router.get("/contacts/:id/activity", (req: Request, res: Response) => {
    const granularity = (req.query.granularity as string) || "week";
    const { startTs } = parseRange(req.query.range as string);
    const activity = store.getContactActivity(
      decodeURIComponent(req.params.id as string),
      granularity as "day" | "week" | "month",
      startTs
    );
    res.json(activity);
  });

  router.get("/contacts/:id/messages", (req: Request, res: Response) => {
    const contactId = decodeURIComponent(req.params.id as string);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    // Use cross-source query to show WhatsApp + iMessage messages together
    const messages = store.getContactMessagesAllSources(contactId, limit, offset);
    res.json({ messages, limit, offset });
  });

  router.post("/contacts/:id/fetch-history", async (req: Request, res: Response) => {
    if (!fetchHistoryTrigger) return res.status(501).json({ error: "Not available" });
    const contactId = decodeURIComponent(req.params.id as string);
    try {
      const count = await fetchHistoryTrigger(contactId);
      const messages = store.getContactMessages(contactId, 50, 0);
      res.json({ updated: count, messages });
    } catch (err: any) {
      console.error("[fetch-history] Error:", err?.message || err);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  // Legacy single-note endpoint (kept for backwards compat)
  router.put("/contacts/:id/notes", (req: Request, res: Response) => {
    store.updateContactNotes(decodeURIComponent(req.params.id as string), req.body.notes || "");
    res.json({ ok: true });
  });

  // Timestamped notes CRUD
  router.get("/contacts/:id/notes", (req: Request, res: Response) => {
    const notes = store.getContactNotes(decodeURIComponent(req.params.id as string));
    res.json({ notes });
  });

  router.post("/contacts/:id/notes", (req: Request, res: Response) => {
    const content = (req.body.content || "").trim();
    if (!content) { res.status(400).json({ error: "Content required" }); return; }
    const noteId = store.addContactNote(decodeURIComponent(req.params.id as string), content);
    res.json({ ok: true, id: noteId });
  });

  router.put("/contacts/:id/notes/:noteId", (req: Request, res: Response) => {
    const content = (req.body.content || "").trim();
    if (!content) { res.status(400).json({ error: "Content required" }); return; }
    store.updateContactNote(parseInt(req.params.noteId as string), content);
    res.json({ ok: true });
  });

  router.delete("/contacts/:id/notes/:noteId", (req: Request, res: Response) => {
    store.deleteContactNote(parseInt(req.params.noteId as string));
    res.json({ ok: true });
  });

  router.put("/contacts/:id/display-name", (req: Request, res: Response) => {
    const contactId = decodeURIComponent(req.params.id as string);
    const displayName = req.body.display_name;
    store.updateDisplayName(contactId, typeof displayName === "string" ? displayName.trim() || null : null);
    res.json({ ok: true });
  });

  router.put("/contacts/:id/tier", (req: Request, res: Response) => {
    const tierId = req.body.tier_id;
    store.setContactTier(decodeURIComponent(req.params.id as string), tierId ?? null);
    res.json({ ok: true });
  });

  router.post("/contacts/:id/dismiss-neglected", (req: Request, res: Response) => {
    store.dismissNeglectedContact(decodeURIComponent(req.params.id as string));
    res.json({ ok: true });
  });

  router.delete("/contacts/:id/dismiss-neglected", (req: Request, res: Response) => {
    store.undismissNeglectedContact(decodeURIComponent(req.params.id as string));
    res.json({ ok: true });
  });

  // Hide/unhide contacts
  router.post("/contacts/:id/hide", (req: Request, res: Response) => {
    store.hideContact(decodeURIComponent(req.params.id as string));
    res.json({ ok: true });
  });

  router.post("/contacts/:id/unhide", (req: Request, res: Response) => {
    store.unhideContact(decodeURIComponent(req.params.id as string));
    res.json({ ok: true });
  });

  router.get("/contacts/hidden", (_req: Request, res: Response) => {
    res.json(store.getHiddenContacts());
  });

  router.get("/contacts/:id/voice", (req: Request, res: Response) => {
    const contactId = decodeURIComponent(req.params.id as string);
    const notes = store.getVoiceNotesByContact(contactId);
    const stats = store.getVoiceStatsByContact(contactId);
    res.json({ notes, stats });
  });

  router.get("/contacts/:id/tags", (req: Request, res: Response) => {
    const tags = store.getContactTags(decodeURIComponent(req.params.id as string));
    res.json(tags);
  });

  router.post("/contacts/:id/tags", (req: Request, res: Response) => {
    const contactId = decodeURIComponent(req.params.id as string);
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "Tag name required" });
      return;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    store.addContactTag(contactId, name.trim(), timestamp, 1.0);
    const tags = store.getContactTags(contactId);
    res.json(tags);
  });

  router.delete("/contacts/:id/tags/:tagId", (req: Request, res: Response) => {
    const contactId = decodeURIComponent(req.params.id as string);
    const tagId = parseInt(req.params.tagId as string);
    if (isNaN(tagId)) { res.status(400).json({ error: "Invalid tag ID" }); return; }
    store.removeContactTag(contactId, tagId);
    const tags = store.getContactTags(contactId);
    res.json(tags);
  });

  // ── Chats ──

  router.get("/chats", (_req: Request, res: Response) => {
    res.json(store.getChats());
  });

  router.post("/chats/:chatId/monitor", (req: Request, res: Response) => {
    store.setChatMonitored(decodeURIComponent(req.params.chatId as string), true);
    res.json({ ok: true });
  });

  router.delete("/chats/:chatId/monitor", (req: Request, res: Response) => {
    store.setChatMonitored(decodeURIComponent(req.params.chatId as string), false);
    res.json({ ok: true });
  });

  router.post("/scan", async (_req: Request, res: Response) => {
    try {
      const count = await scanTrigger();
      res.json({ ok: true, chatsFound: count });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Scan failed" });
    }
  });

  // ── Groups ──

  router.get("/groups", (_req: Request, res: Response) => {
    const groups = store.getGroups();
    const withMembers = groups.map(g => ({
      ...g,
      members: store.getGroupMembers(g.id),
      memberCount: store.getGroupMembers(g.id).length,
    }));
    res.json(withMembers);
  });

  router.post("/groups", (req: Request, res: Response) => {
    const { name, color } = req.body;
    if (!name) { res.status(400).json({ error: "Name required" }); return; }
    const id = store.createGroup(name, color || "#4fc3f7");
    res.json({ ok: true, id });
  });

  router.put("/groups/:id", (req: Request, res: Response) => {
    const { name, color, sort_order } = req.body;
    store.updateGroup(parseInt(req.params.id as string), name, color, sort_order ?? 0);
    res.json({ ok: true });
  });

  router.delete("/groups/:id", (req: Request, res: Response) => {
    store.deleteGroup(parseInt(req.params.id as string));
    res.json({ ok: true });
  });

  router.post("/groups/:id/members", (req: Request, res: Response) => {
    const { contactIds } = req.body;
    if (!Array.isArray(contactIds)) { res.status(400).json({ error: "contactIds array required" }); return; }
    const groupId = parseInt(req.params.id as string);
    for (const cid of contactIds) {
      store.addContactToGroup(cid, groupId);
    }
    res.json({ ok: true, added: contactIds.length });
  });

  router.delete("/groups/:id/members/:contactId", (req: Request, res: Response) => {
    store.removeContactFromGroup(
      decodeURIComponent(req.params.contactId as string),
      parseInt(req.params.id as string)
    );
    res.json({ ok: true });
  });

  // ── Messaging Portal ──

  router.post("/send", async (req: Request, res: Response) => {
    if (sendProgress.active) {
      res.status(409).json({ error: "Send already in progress" });
      return;
    }

    const { contactIds, groupIds, message, mediaBase64, mediaMimetype, mediaFilename } = req.body;
    if (!message && !mediaBase64) {
      res.status(400).json({ error: "Message or media required" });
      return;
    }

    // Resolve all contact IDs (expand group IDs to member contacts)
    let allContactIds: string[] = [...(contactIds || [])];
    if (groupIds && Array.isArray(groupIds)) {
      for (const gid of groupIds) {
        const members = store.getGroupMembers(gid);
        allContactIds.push(...members.map(m => m.id));
      }
    }
    allContactIds = [...new Set(allContactIds)];

    if (allContactIds.length === 0) {
      res.status(400).json({ error: "No recipients selected" });
      return;
    }

    const media = mediaBase64
      ? { base64: mediaBase64, mimetype: mediaMimetype || "image/jpeg", filename: mediaFilename || "image.jpg" }
      : null;

    res.json({ ok: true, recipients: allContactIds.length });

    sendMessageTrigger(allContactIds, message || "", media).catch((err: any) => {
      console.error("[friends-send] Background error:", err);
    });
  });

  router.get("/send-status", (_req: Request, res: Response) => {
    res.json(sendProgress);
  });

  // ── Backfill ──

  router.post("/backfill", async (_req: Request, res: Response) => {
    try {
      const count = await backfillTrigger();
      res.json({ ok: true, messagesImported: count });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Backfill failed" });
    }
  });

  // ── Settings ──

  router.get("/settings", (_req: Request, res: Response) => {
    res.json({
      autoMonitorPrivate: store.getSetting("auto_monitor_private") || "true",
      autoMonitorSmallGroups: store.getSetting("auto_monitor_small_groups") || "true",
      maxGroupSize: store.getSetting("max_group_size") || "6",
    });
  });

  router.post("/settings", (req: Request, res: Response) => {
    const allowed = ["auto_monitor_private", "auto_monitor_small_groups", "max_group_size"];
    for (const [key, value] of Object.entries(req.body)) {
      if (allowed.includes(key) && typeof value === "string") {
        store.setSetting(key, value);
      }
    }
    res.json({ ok: true });
  });

  // ── Tiers ──

  router.get("/tiers", (_req: Request, res: Response) => {
    const tiers = store.getTiers();
    res.json(tiers);
  });

  router.post("/tiers", (req: Request, res: Response) => {
    const { name, color } = req.body;
    if (!name) { res.status(400).json({ error: "Name required" }); return; }
    const id = store.createTier(name, color || "#4fc3f7");
    res.json({ ok: true, id });
  });

  router.put("/tiers/reorder", (req: Request, res: Response) => {
    const { order } = req.body; // array of { id, sort_order }
    if (!Array.isArray(order)) { res.status(400).json({ error: "order must be an array" }); return; }
    for (const item of order) {
      store.updateTierSortOrder(item.id, item.sort_order);
    }
    res.json({ ok: true });
  });

  router.put("/tiers/:id", (req: Request, res: Response) => {
    const { name, color, sort_order } = req.body;
    store.updateTier(parseInt(req.params.id as string), name, color, sort_order ?? 0);
    res.json({ ok: true });
  });

  router.delete("/tiers/:id", (req: Request, res: Response) => {
    store.deleteTier(parseInt(req.params.id as string));
    res.json({ ok: true });
  });

  // ── Voice ──

  router.get("/voice/stats", (_req: Request, res: Response) => {
    res.json(store.getVoiceStatsAll());
  });

  // ── Tags ──

  router.get("/tags", (req: Request, res: Response) => {
    const tierParam = req.query.tier as string | undefined;
    let tierId: number | null | undefined = undefined;
    if (tierParam === "none") tierId = null;
    else if (tierParam && !isNaN(parseInt(tierParam))) tierId = parseInt(tierParam);
    res.json(store.getAllTags(tierId));
  });

  router.post("/tags/extract", async (_req: Request, res: Response) => {
    if (!tagExtractTrigger) {
      res.status(503).json({ error: "Tag extraction not configured" });
      return;
    }
    try {
      const count = await tagExtractTrigger();
      res.json({ ok: true, contactsProcessed: count });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Tag extraction failed" });
    }
  });

  // Merge tags: merge source tag IDs into a canonical tag ID
  router.post("/tags/merge", (req: Request, res: Response) => {
    const { merges } = req.body;
    if (!Array.isArray(merges)) {
      res.status(400).json({ error: "Expected { merges: [{ sourceIds: number[], canonicalId: number }] }" });
      return;
    }
    let totalReassigned = 0;
    for (const m of merges) {
      if (!Array.isArray(m.sourceIds) || typeof m.canonicalId !== "number") continue;
      totalReassigned += store.mergeTags(m.sourceIds, m.canonicalId);
    }
    const remaining = store.getAllTags();
    res.json({ ok: true, reassigned: totalReassigned, remainingTags: remaining.length });
  });

  // Rename a tag
  router.put("/tags/:id", (req: Request, res: Response) => {
    const tagId = parseInt(req.params.id as string);
    const { name } = req.body;
    if (isNaN(tagId) || !name) { res.status(400).json({ error: "Tag ID and name required" }); return; }
    store.renameTag(tagId, name);
    res.json({ ok: true });
  });

  // Delete singleton tags (used by 0-1 contacts)
  router.post("/tags/cleanup", (req: Request, res: Response) => {
    const maxCount = parseInt(req.body.maxContactCount as string) || 1;
    const allTags = store.getAllTags();
    const toDelete = allTags.filter(t => t.contact_count <= maxCount);
    let deleted = 0;
    for (const t of toDelete) {
      store.mergeTags([t.id], t.id); // this will just clean up orphans
    }
    // Actually delete contact_tags for low-count tags, then clean tags table
    const db = (store as any).db;
    for (const t of toDelete) {
      db.prepare(`DELETE FROM friends_contact_tags WHERE tag_id = ?`).run(t.id);
      db.prepare(`DELETE FROM friends_tags WHERE id = ?`).run(t.id);
      deleted++;
    }
    const remaining = store.getAllTags();
    res.json({ ok: true, deleted, remainingTags: remaining.length });
  });

  // AI-powered tag consolidation
  router.post("/tags/consolidate", async (_req: Request, res: Response) => {
    if (!tagConsolidateTrigger) {
      res.status(503).json({ error: "Tag consolidation not configured" });
      return;
    }
    try {
      const result = await tagConsolidateTrigger();
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Consolidation failed" });
    }
  });

  // ── Graph data (with server-side cache) ──

  let _graphCache: { data: any; time: number; minMessages: number } | null = null;
  const GRAPH_CACHE_TTL = 60000; // 60 seconds

  router.get("/graph", (_req: Request, res: Response) => {
    const minMessages = parseInt(_req.query.minMessages as string) || 10;

    // Return cached response if fresh
    if (_graphCache && _graphCache.minMessages === minMessages && (Date.now() - _graphCache.time) < GRAPH_CACHE_TTL) {
      res.json(_graphCache.data);
      return;
    }

    const allContacts = store.getContactsWithStats().filter(c => c.total_messages >= minMessages);
    const now = Math.floor(Date.now() / 1000);

    // Build tier list for frontend
    const tiers = store.getTiers();

    // Batch query: active days, word count, voice notes per contact
    const metricsMap: Record<string, { activeDays: number; totalWords: number; voiceNotes: number }> = {};
    for (const r of store.getGraphMetrics()) {
      metricsMap[r.chat_id] = { activeDays: r.active_days, totalWords: r.total_words, voiceNotes: r.voice_notes };
    }

    const nodes = allContacts.map(c => {
      const groupArr = c.group_names ? c.group_names.split(", ") : [];
      const tagArr = c.tag_names ? c.tag_names.split(", ") : [];
      const daysSince = Math.max(0, Math.round((now - (c.last_seen || now)) / 86400));
      const daysKnown = Math.max(1, Math.round(((c.last_seen || now) - (c.first_seen || c.last_seen || now)) / 86400));
      const ratio = c.received_messages > 0 ? Math.round((c.sent_messages / c.received_messages) * 100) / 100 : 0;
      // Phone fallback for name
      let displayName = c.name;
      if (!displayName || !displayName.trim() || displayName === "Unknown") {
        const ph = (c.id || "").split("@")[0];
        if (ph && /^\d{7,15}$/.test(ph)) displayName = "+" + ph;
        else displayName = c.name || c.id || "?";
      }
      const msgsPerDay = daysKnown > 0 ? Math.round((c.total_messages / daysKnown) * 100) / 100 : 0;
      const recentPerDay = Math.round((c.messages_30d / 30) * 100) / 100;
      const gm = metricsMap[c.id] || { activeDays: 1, totalWords: 0, voiceNotes: 0 };
      const wordsPerActiveDay = gm.activeDays > 0 ? Math.round((gm.totalWords / gm.activeDays) * 100) / 100 : 0;
      return {
        id: c.id, name: displayName,
        // Raw metrics
        messages: c.total_messages, messages30d: c.messages_30d,
        sent: c.sent_messages, received: c.received_messages,
        lastSeen: c.last_seen, firstSeen: c.first_seen,
        // Computed metrics for axes
        daysSince, daysKnown, ratio, quality: c.quality_score || 0,
        msgsPerDay, recentPerDay, wordsPerActiveDay, voiceNotes: gm.voiceNotes,
        groupCount: groupArr.length, tagCount: tagArr.length,
        // Metadata
        tierId: c.tier_id, tierName: c.tier_name, tierColor: c.tier_color,
        tags: tagArr, groups: groupArr
      };
    });

    // Edges based on shared groups (with group names)
    const edges: Array<{ source: string; target: string; weight: number; groups: string[] }> = [];
    const groupMembers: Record<string, string[]> = {};
    for (const c of allContacts) {
      if (c.group_names) {
        for (const g of c.group_names.split(", ")) {
          if (!groupMembers[g]) groupMembers[g] = [];
          groupMembers[g].push(c.id);
        }
      }
    }
    const edgeMap = new Map<string, { weight: number; groups: string[] }>();
    for (const [groupName, members] of Object.entries(groupMembers)) {
      if (members.length > 50) continue;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const key = members[i] < members[j] ? members[i] + "|" + members[j] : members[j] + "|" + members[i];
          const existing = edgeMap.get(key);
          if (existing) { existing.weight++; existing.groups.push(groupName); }
          else edgeMap.set(key, { weight: 1, groups: [groupName] });
        }
      }
    }
    for (const [key, val] of edgeMap) {
      const [source, target] = key.split("|");
      edges.push({ source, target, weight: val.weight, groups: val.groups });
    }

    // Shared tag edges (contacts sharing 3+ tags = likely connected)
    const tagEdges: Array<{ source: string; target: string; sharedTags: string[] }> = [];
    const contactTagMap: Record<string, Set<string>> = {};
    for (const n of nodes) {
      if (n.tags.length > 0) contactTagMap[n.id] = new Set(n.tags);
    }
    const contactIds = Object.keys(contactTagMap);
    for (let i = 0; i < contactIds.length; i++) {
      for (let j = i + 1; j < contactIds.length; j++) {
        const shared: string[] = [];
        for (const t of contactTagMap[contactIds[i]]) {
          if (contactTagMap[contactIds[j]].has(t)) shared.push(t);
        }
        if (shared.length >= 3) {
          tagEdges.push({ source: contactIds[i], target: contactIds[j], sharedTags: shared });
        }
      }
    }

    const responseData = { nodes, edges, tagEdges, tiers };
    _graphCache = { data: responseData, time: Date.now(), minMessages };
    res.json(responseData);
  });

  // ── Data Management ──

  router.post("/archive", (req: Request, res: Response) => {
    const days = parseInt(req.body.olderThanDays as string) || 1095; // default 3 years
    const result = store.archiveOldMessages(days);
    res.json({ ok: true, ...result, freedMB: Math.round(result.freedChars / 1024 / 1024 * 10) / 10 });
  });

  // ── AI Search ──

  router.post("/search", async (req: Request, res: Response) => {
    const { query } = req.body;
    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "Query string required" });
      return;
    }

    try {
      // Step 1: Parse query — extract exact phrases for message search
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const { config } = await import("../../config");
      if (!config.geminiApiKey) {
        res.status(503).json({ error: "AI search requires GEMINI_API_KEY" });
        return;
      }
      const genAI = new GoogleGenerativeAI(config.geminiApiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const parseResult = await model.generateContent(`You parse natural language search queries into structured search parameters for a personal contacts database.

CRITICAL RULES:
- "phrases": Keep the user's EXACT wording. Do NOT generalize or paraphrase. "guest room" stays "guest room", NOT "housing" or "accommodation".
- Only break into multiple phrases if the query clearly has distinct concepts (e.g. "lives in SF and plays guitar" → ["san francisco", "guitar"]).
- "name": Only set if the user is searching for a specific person by name.
- Do NOT invent synonyms, broader categories, or related concepts. Be LITERAL.

Return ONLY a JSON object:
{
  "phrases": ["exact phrase from query"],
  "name": null,
  "explanation": "brief description of what user wants"
}

Examples:
- "guest room" → {"phrases": ["guest room"], "name": null, "explanation": "People who mentioned having a guest room"}
- "friends in San Francisco" → {"phrases": ["san francisco", "sf"], "name": null, "explanation": "People connected to San Francisco"}
- "John who does photography" → {"phrases": ["photography", "photo"], "name": "John", "explanation": "Person named John involved in photography"}
- "people who surf" → {"phrases": ["surf", "surfing"], "name": null, "explanation": "People who surf"}

User query: "${query.replace(/"/g, '\\"')}"`);

      const parseText = parseResult.response.text();
      const jsonMatch = parseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        res.status(500).json({ error: "Failed to parse search query" });
        return;
      }
      const parsed = JSON.parse(jsonMatch[0]);
      const phrases: string[] = parsed.phrases || [];

      // Step 2: Search using extracted parameters
      let results: any[] = [];
      const seenIds = new Set<string>();

      // Search message content with exact phrases (highest priority)
      if (phrases.length > 0) {
        const msgResults = store.searchMessageContent(phrases, 50);
        for (const r of msgResults) {
          if (!seenIds.has(r.contact_id)) {
            seenIds.add(r.contact_id);
            results.push({
              id: r.contact_id, name: r.name, tier_name: r.tier_name, tier_color: r.tier_color,
              tag_names: r.tag_names, match_source: "message",
              match_reason: `${r.match_count} message matches`,
              snippet: r.snippet?.substring(0, 200),
              score: r.match_count * 10
            });
          }
        }
      }

      // Search by tags — only literal substring matches, not conceptual
      if (phrases.length > 0) {
        const allTags = store.getAllTags().slice(0, 500);
        const matchingTags = allTags.filter(t =>
          phrases.some(p => t.name.includes(p.toLowerCase()) || p.toLowerCase().includes(t.name))
        ).map(t => t.name);

        if (matchingTags.length > 0) {
          const tagContacts = store.getContactsWithTags(matchingTags, "OR");
          const allContacts = store.getContactsWithStats();
          for (const c of allContacts) {
            if (tagContacts.includes(c.id) && !seenIds.has(c.id)) {
              seenIds.add(c.id);
              const matchedTags = matchingTags.filter((t: string) =>
                (c as any).tag_names && (c as any).tag_names.includes(t)
              );
              results.push({
                ...c, match_source: "tag",
                match_reason: "Tagged: " + matchedTags.join(", "),
                score: matchedTags.length * 5
              });
            }
          }
        }
      }

      // Search by name
      if (parsed.name) {
        const allContacts = store.getContactsWithStats();
        for (const c of allContacts) {
          if (c.name.toLowerCase().includes(parsed.name.toLowerCase()) && !seenIds.has(c.id)) {
            seenIds.add(c.id);
            results.push({
              ...c, match_source: "name", match_reason: "Name match", score: 3
            });
          }
        }
      }

      // Sort by score descending
      results.sort((a, b) => (b.score || 0) - (a.score || 0));

      res.json({
        query,
        parsed: { phrases, name: parsed.name, explanation: parsed.explanation },
        results: results.slice(0, 50)
      });
    } catch (err: any) {
      console.error("[ai-search] Error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Search failed" });
    }
  });

  // ── Calendar ──

  router.get("/calendar", (req: Request, res: Response) => {
    const now = new Date();
    const year = parseInt(req.query.year as string) || now.getFullYear();
    const month = parseInt(req.query.month as string) || (now.getMonth() + 1);
    const tierParam = req.query.tier as string | undefined;
    let tierId: number | null | undefined = undefined;
    if (tierParam === "none") tierId = null;
    else if (tierParam && !isNaN(parseInt(tierParam))) tierId = parseInt(tierParam);
    const data = store.getCalendarData(year, month, tierId);
    res.json({ year, month, days: data });
  });

  // ── iMessage Sync ──

  router.post("/imessage/sync", (req: Request, res: Response) => {
    const syncKey = req.headers["x-sync-key"] as string;
    const expectedKey = process.env.IMESSAGE_SYNC_KEY;
    if (!expectedKey || syncKey !== expectedKey) {
      return res.status(401).json({ error: "Invalid sync key" });
    }

    const { messages, voiceNotes } = req.body;
    const result: any = { imported: 0, updated: 0, voiceImported: 0 };

    try {
      if (Array.isArray(messages) && messages.length > 0) {
        const msgResult = store.syncImessageMessages(messages);
        result.imported = msgResult.imported;
        result.updated = msgResult.updated;
        console.log(`[imessage-sync] Messages: imported ${msgResult.imported}, skipped ${msgResult.updated}`);
      }

      if (Array.isArray(voiceNotes) && voiceNotes.length > 0) {
        const vnResult = store.syncImessageVoiceNotes(voiceNotes);
        result.voiceImported = vnResult.imported;
        console.log(`[imessage-sync] Voice notes: imported ${vnResult.imported}`);
      }

      res.json(result);
    } catch (err: any) {
      console.error("[imessage-sync] Error:", err?.message || err);
      res.status(500).json({ error: "Sync failed" });
    }
  });

  // ── Health ──

  router.get("/health", (_req: Request, res: Response) => {
    res.json(store.getHealth());
  });

  return router;
}
