import express from "express";
import path from "path";
import { config } from "./config";
import { EventStore } from "./store";
import { categories } from "./categories";

export function startServer(store: EventStore, statusChecker?: () => { whatsappConnected: boolean }, qrCodeGetter?: () => string | null, backfillTrigger?: (days: number) => Promise<number>): void {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.static(path.resolve(process.cwd(), "public")));

  // Connection status
  app.get("/api/status", (_req, res) => {
    const status = statusChecker ? statusChecker() : { whatsappConnected: false };
    res.json({ ...status, serverTime: new Date().toISOString() });
  });

  // Get QR code for WhatsApp auth (admin only)
  app.get("/api/qr", (_req, res) => {
    const qr = qrCodeGetter ? qrCodeGetter() : null;
    res.json({ qr });
  });

  // Get all events
  app.get("/api/events", (_req, res) => {
    const events = store.getAllEvents();
    res.json(events);
  });

  // Get events by category
  app.get("/api/events/category/:category", (req, res) => {
    const events = store.getEventsByCategory(req.params.category);
    res.json(events);
  });

  // Get favorites
  app.get("/api/events/favorites", (_req, res) => {
    const events = store.getFavorites();
    res.json(events);
  });

  // Toggle favorite
  app.post("/api/events/:hash/favorite", (req, res) => {
    const favorited = store.toggleFavorite(req.params.hash);
    res.json({ hash: req.params.hash, favorited });
  });

  // Get categories
  app.get("/api/categories", (_req, res) => {
    res.json(categories);
  });

  // Get recently added events
  app.get("/api/events/recent", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 15, 50);
    const events = store.getRecentEvents(limit);
    res.json(events);
  });

  // Get events by source group
  app.get("/api/events/group/:chatName", (req, res) => {
    const events = store.getEventsByGroup(decodeURIComponent(req.params.chatName));
    res.json(events);
  });

  // Get dashboard stats
  app.get("/api/stats", (_req, res) => {
    const groupStats = store.getGroupStats();
    const totalStats = store.getTotalStats();
    res.json({ ...totalStats, groups: groupStats });
  });

  // Get blocked groups
  app.get("/api/groups/blocked", (_req, res) => {
    res.json(store.getBlockedGroups());
  });

  // Block a group
  app.post("/api/groups/:chatName/block", (req, res) => {
    const chatName = decodeURIComponent(req.params.chatName);
    store.blockGroup(chatName);
    res.json({ chatName, blocked: true });
  });

  // Unblock a group
  app.delete("/api/groups/:chatName/block", (req, res) => {
    const chatName = decodeURIComponent(req.params.chatName);
    store.unblockGroup(chatName);
    res.json({ chatName, blocked: false });
  });

  // Export all data (for syncing to another instance)
  app.get("/api/export", (_req, res) => {
    const events = store.getAllEvents();
    const blockedGroups = store.getBlockedGroups();
    const processedMessages = store.getAllProcessedMessages();
    res.json({ events, blockedGroups, processedMessages });
  });

  // Import data from another instance
  app.post("/api/import", (req, res) => {
    const { events, blockedGroups, processedMessages } = req.body;
    let imported = 0;
    if (events && Array.isArray(events)) {
      for (const e of events) {
        if (!store.isEventDuplicate(e.name, e.date, e.location || "")) {
          store.saveEvent(
            e.name, e.date, e.startTime || null, e.endTime || null,
            e.endDate || null, e.location || null,
            e.description || "", e.url || null, e.category || "other",
            e.sourceChat || "import", e.sourceMessageId || "import",
            e.sourceText || ""
          );
          imported++;
        }
      }
    }
    let blocked = 0;
    if (blockedGroups && Array.isArray(blockedGroups)) {
      for (const name of blockedGroups) {
        store.blockGroup(name);
        blocked++;
      }
    }
    let messages = 0;
    if (processedMessages && Array.isArray(processedMessages)) {
      for (const m of processedMessages) {
        if (!store.isMessageProcessed(m.messageId || m.message_id)) {
          store.markMessageProcessed(
            m.messageId || m.message_id,
            m.chatName || m.chat_name,
            m.timestamp,
            m.body || ""
          );
          messages++;
        }
      }
    }
    res.json({ imported, skippedDuplicates: (events?.length || 0) - imported, blockedGroups: blocked, processedMessages: messages });
  });

  // Trigger backfill (admin)
  app.post("/api/backfill", async (req, res) => {
    const days = Math.min(parseInt(req.query.days as string) || 7, 30);
    if (!backfillTrigger) {
      res.status(503).json({ error: "Backfill not available (no WhatsApp connection)" });
      return;
    }
    try {
      const eventsFound = await backfillTrigger(days);
      res.json({ message: `Backfill complete`, days, eventsFound });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Backfill failed" });
    }
  });

  // Seed sample events for testing the UI
  app.post("/api/seed", (_req, res) => {
    const today = new Date();
    const d = (offset: number) => {
      const dt = new Date(today);
      dt.setDate(dt.getDate() + offset);
      return dt.toISOString().split("T")[0];
    };

    const samples = [
      { name: "Breathwork & Somatic Release Circle", date: d(1), startTime: "18:30", endTime: "20:30", location: "The Assemblage NoMad, 114 E 25th St", description: "A guided breathwork session followed by somatic release practices. Explore the connection between breath, body, and emotional regulation.", category: "somatic", sourceChat: "NYC Embodiment Collective" },
      { name: "Ecstatic Dance NYC", date: d(2), startTime: "10:00", endTime: "13:00", location: "Gibney Dance, 280 Broadway", description: "Freeform movement session with a live DJ. No talking on the dance floor — pure embodied expression.", category: "dance_movement", sourceChat: "NYC Movement Community" },
      { name: "Metacrisis Reading Group: Daniel Schmachtenberger", date: d(3), startTime: "19:00", endTime: "21:00", location: "Brooklyn Commons, 388 Atlantic Ave", description: "Monthly discussion group exploring metacrisis, existential risk, and civilizational design. This month: Game B frameworks.", category: "systems_metacrisis", sourceChat: "NYC Systems Thinkers" },
      { name: "Climate Justice Workshop: Building Local Resilience", date: d(4), startTime: "14:00", endTime: "17:00", location: "The New School, 66 W 12th St", description: "Hands-on workshop on building community resilience in the face of climate change. Covers mutual aid networks, urban agriculture, and local energy systems.", category: "environment", sourceChat: "NYC Climate Action" },
      { name: "Community Land Trust Info Session", date: d(5), startTime: "18:00", endTime: "19:30", location: "Cooper Union, 7 E 7th St", description: "Learn how community land trusts work and how they can address housing affordability in NYC. Panel with CLT organizers from across the five boroughs.", category: "social_impact", sourceChat: "NYC Housing Justice" },
      { name: "Salon: The Future of Education", date: d(6), startTime: "19:00", endTime: "21:30", location: "The Intervale, 59 E 4th St", description: "An intimate salon exploring alternative education models — unschooling, democratic free schools, and learning communities. Featuring three speakers and open discussion.", category: "learning", sourceChat: "NYC Intellectual Salons" },
      { name: "Nonviolent Communication Workshop", date: d(7), startTime: "10:00", endTime: "16:00", location: "Brooklyn Society for Ethical Culture, 53 Prospect Park West", description: "Full-day NVC workshop for beginners. Learn the four components of NVC and practice with real-life scenarios. Lunch provided.", category: "skills", sourceChat: "NYC NVC Practice Group" },
      { name: "5-Day Permaculture Design Intensive", date: d(10), startTime: "09:00", endTime: "17:00", endDate: d(14), location: "Snug Harbor Cultural Center, Staten Island", description: "Immersive 5-day permaculture design course covering food forests, water management, soil building, and community design. Includes site visits.", category: "multiday", sourceChat: "NYC Permaculture Network" },
      { name: "Regenerative Futures Summit NYC", date: d(15), startTime: "09:00", endTime: "18:00", endDate: d(16), location: "NYU Kimmel Center, 60 Washington Square S", description: "Two-day conference bringing together systems thinkers, activists, designers, and builders working on regenerative futures. 40+ speakers, workshops, and networking.", category: "conference", sourceChat: "NYC Regenerative Network" },
      { name: "Contact Improvisation Jam", date: d(2), startTime: "15:00", endTime: "18:00", location: "Movement Research at the Judson Church, 55 Washington Square S", description: "Open jam for contact improvisation practitioners of all levels. Warm-up followed by free exploration.", category: "dance_movement", sourceChat: "NYC Contact Improv" },
      { name: "Tantra & Intimacy Workshop for Couples", date: d(8), startTime: "14:00", endTime: "18:00", location: "Private Loft Space, Williamsburg", description: "Explore tantric principles and somatic practices designed to deepen intimacy and presence with your partner.", category: "somatic", sourceChat: "NYC Tantra Community" },
      { name: "Systems Mapping Workshop: NYC Food Systems", date: d(9), startTime: "13:00", endTime: "17:00", location: "Urban Design Forum, 200 Lexington Ave", description: "Collaborative systems mapping workshop focused on NYC's food system. Identify leverage points for intervention.", category: "systems_metacrisis", sourceChat: "NYC Systems Thinkers" },
      { name: "Collective Sensemaking: Weekly Zoom Circle", date: d(3), startTime: "20:00", endTime: "21:30", location: "Zoom", description: "Weekly online gathering for collective sensemaking and meaning-making. Open to all. Zoom link shared in group.", category: "online", sourceChat: "NYC Systems Thinkers" },
    ];

    let added = 0;
    for (const s of samples) {
      if (!store.isEventDuplicate(s.name, s.date, s.location || "")) {
        store.saveEvent(
          s.name, s.date, s.startTime || null, s.endTime || null,
          (s as any).endDate || null, s.location || null,
          s.description || "", null, s.category,
          s.sourceChat || "Seed Data", "seed",
          `[Sample] ${s.name} - ${s.description || ""}`
        );
        added++;
      }
    }

    res.json({ message: `Seeded ${added} sample events (${samples.length - added} already existed).` });
  });

  app.listen(config.port, () => {
    console.log(`\nWeb UI available at http://localhost:${config.port}\n`);
  });
}
