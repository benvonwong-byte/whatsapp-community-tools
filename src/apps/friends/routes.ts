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
  tagExtractTrigger?: () => Promise<number>
): Router {
  const router = Router();

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

    const now = Math.floor(Date.now() / 1000);
    const ninetyDaysAgo = now - 90 * 86400;
    const stats = store.getContactStats(contact.id, ninetyDaysAgo, now);
    const groups = store.getContactGroups(contact.id);
    const tags = store.getContactTags(contact.id);
    const voiceStats = store.getVoiceStatsByContact(contact.id);
    res.json({ contact, stats, groups, tags, voiceStats });
  });

  router.get("/contacts/:id/activity", (req: Request, res: Response) => {
    const granularity = (req.query.granularity as string) || "week";
    const activity = store.getContactActivity(
      decodeURIComponent(req.params.id as string),
      granularity as "day" | "week" | "month"
    );
    res.json(activity);
  });

  router.get("/contacts/:id/messages", (req: Request, res: Response) => {
    const contactId = decodeURIComponent(req.params.id as string);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const messages = store.getContactMessages(contactId, limit, offset);
    res.json({ messages, limit, offset });
  });

  router.put("/contacts/:id/notes", (req: Request, res: Response) => {
    store.updateContactNotes(decodeURIComponent(req.params.id as string), req.body.notes || "");
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

  // ── Health ──

  router.get("/health", (_req: Request, res: Response) => {
    res.json(store.getHealth());
  });

  return router;
}
