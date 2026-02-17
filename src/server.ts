import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { EventStore } from "./store";
import { categories } from "./categories";
import { verifyAllStoredEvents, VerifyProgress, deduplicateEvents, DedupProgress } from "./verifier";

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export interface BackfillProgress {
  active: boolean;
  phase: "idle" | "fetching" | "processing" | "done" | "error";
  totalMessages: number;
  processedMessages: number;
  eventsFound: number;
  groupsScanned: number;
  totalGroups: number;
  errorMessage?: string;
}

// In-memory ring buffer for server logs (last 200 entries)
export interface LogEntry {
  timestamp: string;
  level: "log" | "warn" | "error";
  message: string;
}

const logBuffer: LogEntry[] = [];
const LOG_BUFFER_SIZE = 200;

function captureLog(level: "log" | "warn" | "error", args: any[]) {
  const message = args.map(a => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.message}${a.stack ? "\n" + a.stack : ""}`;
    try { return JSON.stringify(a, null, 2); } catch { return String(a); }
  }).join(" ");
  logBuffer.push({ timestamp: new Date().toISOString(), level, message });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

// Intercept console to capture logs
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = (...args: any[]) => { captureLog("log", args); origLog(...args); };
console.warn = (...args: any[]) => { captureLog("warn", args); origWarn(...args); };
console.error = (...args: any[]) => { captureLog("error", args); origError(...args); };

// Admin auth middleware: checks ?token= query param or Authorization: Bearer header
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = (req.query.token as string) || req.headers.authorization?.replace("Bearer ", "");
  if (!token || !timingSafeEqual(token, config.adminToken)) {
    res.status(401).json({ error: "Unauthorized. Provide ?token=<ADMIN_TOKEN> or Authorization header." });
    return;
  }
  (res as any).locals.role = "admin";
  next();
}

// Auth middleware: accepts both admin and guest tokens
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = (req.query.token as string) || req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  if (timingSafeEqual(token, config.adminToken)) {
    (res as any).locals.role = "admin";
    next();
    return;
  }
  if (timingSafeEqual(token, config.guestToken)) {
    (res as any).locals.role = "guest";
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized." });
}

export interface ServerOptions {
  store: EventStore;
  statusChecker?: () => { whatsappConnected: boolean };
  qrCodeGetter?: () => string | null;
  backfillTrigger?: (hours: number) => Promise<number>;
  backfillProgressGetter?: () => BackfillProgress;
  // IndexedDB inspection/cleanup (runs inside Puppeteer page)
  idbInspect?: () => Promise<any>;
  idbClean?: (opts: { dryRun?: boolean }) => Promise<any>;
  // App routers mounted under /api/<app> (admin-protected by default, or auth-level for guest+admin)
  appRouters?: { path: string; router: any; authLevel?: "admin" | "auth" }[];
}

export function startServer(opts: ServerOptions): void {
  const { store, statusChecker, qrCodeGetter, backfillTrigger, backfillProgressGetter } = opts;
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // CORS: allow Firebase-hosted frontend to call Railway API
  const allowedOrigins = new Set([
    "https://whatsapp-events-nyc.web.app",
    "https://whatsapp-events-nyc.firebaseapp.com",
  ]);
  app.use((req, res, next) => {
    const origin = req.headers.origin || "";
    let allowed = false;
    try {
      const { hostname } = new URL(origin);
      allowed = hostname === "localhost" || hostname === "127.0.0.1"
        || allowedOrigins.has(origin);
    } catch {}
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    // Security headers
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://whatsapp-events-nyc-production.up.railway.app https://whatsapp-events-nyc.web.app https://nominatim.openstreetmap.org; media-src 'self' blob:; img-src 'self' data:");
    next();
  });

  app.use(express.static(path.resolve(process.cwd(), "public")));

  // ── Public endpoints (read-only, safe for anyone) ──

  // Login: exchange email/password for admin token
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Too many login attempts. Try again later." } });
  app.post("/api/login", loginLimiter, (req, res) => {
    const { email, password } = req.body;
    // Check admin credentials first
    if (config.adminEmail && config.adminPassword &&
        timingSafeEqual(email || "", config.adminEmail) && timingSafeEqual(password || "", config.adminPassword)) {
      res.json({ token: config.adminToken, role: "admin" });
      return;
    }
    // Check guest credentials (email field used as username, case-insensitive)
    if (config.guestUsername && config.guestPassword &&
        (email || "").toLowerCase() === config.guestUsername.toLowerCase() &&
        timingSafeEqual(password || "", config.guestPassword)) {
      res.json({ token: config.guestToken, role: "guest" });
      return;
    }
    res.status(401).json({ error: "Invalid credentials." });
  });

  // Connection status
  app.get("/api/status", (_req, res) => {
    const status = statusChecker ? statusChecker() : { whatsappConnected: false };
    res.json({ ...status, serverTime: new Date().toISOString() });
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

  // Delete event (admin only)
  app.delete("/api/events/:hash", requireAdmin, (req, res) => {
    const deleted = store.deleteEvent(req.params.hash as string);
    if (deleted) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: "Event not found" });
    }
  });

  // Toggle favorite
  app.post("/api/events/:hash/favorite", requireAdmin, (req, res) => {
    const hash = req.params.hash as string;
    const favorited = store.toggleFavorite(hash);
    res.json({ hash, favorited });
  });

  // Get categories
  app.get("/api/categories", (_req, res) => {
    res.json(categories);
  });

  // Get recently added events
  app.get("/api/events/recent", (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 15, 1), 50);
    const events = store.getRecentEvents(limit);
    res.json(events);
  });

  // Get events by source group
  app.get("/api/events/group/:chatName", (req, res) => {
    const events = store.getEventsByGroup(decodeURIComponent(req.params.chatName));
    res.json(events);
  });

  // Backfill progress (public — frontend polls this for the progress bar)
  app.get("/api/backfill-status", (_req, res) => {
    const progress = backfillProgressGetter ? backfillProgressGetter() : { active: false, phase: "idle", totalMessages: 0, processedMessages: 0, eventsFound: 0, groupsScanned: 0, totalGroups: 0 };
    res.json(progress);
  });

  // Get dashboard stats
  app.get("/api/stats", (_req, res) => {
    const groupStats = store.getGroupStats();
    const totalStats = store.getTotalStats();
    res.json({ ...totalStats, groups: groupStats });
  });

  // ── Admin endpoints (require token) ──

  // Get server logs (admin only)
  app.get("/api/logs", requireAdmin, (req, res) => {
    const level = req.query.level as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 200);
    let logs = level ? logBuffer.filter(l => l.level === level) : [...logBuffer];
    res.json(logs.slice(-limit));
  });

  // Get QR code for WhatsApp auth
  app.get("/api/qr", requireAdmin, (_req, res) => {
    const qr = qrCodeGetter ? qrCodeGetter() : null;
    res.json({ qr });
  });

  // Get blocked groups
  app.get("/api/groups/blocked", requireAdmin, (_req, res) => {
    res.json(store.getBlockedGroups());
  });

  // Block a group
  app.post("/api/groups/:chatName/block", requireAdmin, (req, res) => {
    const chatName = decodeURIComponent(req.params.chatName as string);
    store.blockGroup(chatName);
    res.json({ chatName, blocked: true });
  });

  // Unblock a group
  app.delete("/api/groups/:chatName/block", requireAdmin, (req, res) => {
    const chatName = decodeURIComponent(req.params.chatName as string);
    store.unblockGroup(chatName);
    res.json({ chatName, blocked: false });
  });

  // Export all data (for syncing to another instance) — strip message bodies
  app.get("/api/export", requireAdmin, (_req, res) => {
    const events = store.getAllEvents();
    const blockedGroups = store.getBlockedGroups();
    const processedMessages = store.getAllProcessedMessages().map(m => ({
      message_id: m.message_id,
      chat_name: m.chat_name,
      timestamp: m.timestamp,
      body: m.body,
    }));
    res.json({ events, blockedGroups, processedMessages });
  });

  // Import data from another instance
  app.post("/api/import", requireAdmin, (req, res) => {
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
  // ?hours= to set window, otherwise smart-calculates from last event.
  // ?force=true to clear processed messages in the window and re-extract.
  app.post("/api/backfill", requireAdmin, async (req, res) => {
    let hours: number;
    const hoursParam = req.query.hours as string | undefined;
    const force = req.query.force === "true";
    if (hoursParam) {
      hours = Math.min(Math.max(parseInt(hoursParam) || 168, 1), 720); // cap 30 days
    } else {
      // Smart: calculate gap since last event was found
      const lastEventTs = store.getLastEventCreatedTimestamp();
      if (lastEventTs) {
        const gapMs = Date.now() - lastEventTs * 1000;
        hours = Math.max(1, Math.ceil(gapMs / (60 * 60 * 1000)));
        hours = Math.min(hours, 720); // cap 30 days
        console.log(`[backfill] Smart gap: last event ${new Date(lastEventTs * 1000).toISOString()}, ${hours}h ago → scanning ${hours}h`);
      } else {
        hours = 168; // No history, default to 7 days
      }
    }
    if (force) {
      const cutoff = Math.floor(Date.now() / 1000) - hours * 60 * 60;
      const cleared = store.clearProcessedMessagesSince(cutoff);
      console.log(`[backfill] Force mode: cleared ${cleared} processed messages from last ${hours}h for re-extraction.`);
    }
    if (!backfillTrigger) {
      res.status(503).json({ error: "Backfill not available (no WhatsApp connection)" });
      return;
    }
    try {
      const eventsFound = await backfillTrigger(hours);
      res.json({ message: `Backfill complete`, hours, eventsFound, force });
    } catch (err: any) {
      console.error("[backfill] Error:", err);
      res.status(500).json({ error: "Backfill failed" });
    }
  });

  // ── Verify all events ──
  const verifyProgress: VerifyProgress = {
    active: false,
    phase: "idle",
    total: 0,
    checked: 0,
    updated: 0,
    deleted: 0,
  };

  // Verify-all progress (public — frontend polls this for the progress bar)
  app.get("/api/verify-status", (_req, res) => {
    res.json(verifyProgress);
  });

  // Trigger bulk verification of all stored events (admin)
  app.post("/api/verify-all", requireAdmin, async (_req, res) => {
    if (verifyProgress.active) {
      res.status(409).json({ error: "Verification already in progress" });
      return;
    }

    if (!config.anthropicApiKey) {
      res.status(503).json({ error: "No ANTHROPIC_API_KEY configured" });
      return;
    }

    // Run in background — respond immediately
    res.json({ message: "Verification started" });

    try {
      await verifyAllStoredEvents(store, verifyProgress);
    } catch (err: any) {
      console.error("[verify-all] Fatal error:", err);
      verifyProgress.phase = "error";
      verifyProgress.active = false;
      verifyProgress.errorMessage = err?.message || String(err);
    }

    // Reset to idle after 15s
    setTimeout(() => {
      if (verifyProgress.phase === "done" || verifyProgress.phase === "error") {
        verifyProgress.phase = "idle";
      }
    }, 15000);
  });

  // ── Deduplication ──
  const dedupProgress: DedupProgress = {
    active: false,
    phase: "idle",
    total: 0,
    checked: 0,
    deleted: 0,
  };

  app.get("/api/dedup-status", (_req, res) => {
    res.json(dedupProgress);
  });

  app.post("/api/dedup", requireAdmin, (_req, res) => {
    if (dedupProgress.active) {
      res.status(409).json({ error: "Deduplication already in progress" });
      return;
    }

    // Runs synchronously (fast — just string comparisons, no API calls)
    res.json({ message: "Deduplication started" });
    deduplicateEvents(store, dedupProgress);

    // Reset to idle after 10s
    setTimeout(() => {
      if (dedupProgress.phase === "done") {
        dedupProgress.phase = "idle";
      }
    }, 10000);
  });

  // Airtable bulk sync — push all unsynced events to Airtable
  app.post("/api/airtable-sync", requireAdmin, async (_req, res) => {
    if (!config.airtableApiKey || !config.airtableBaseId || !config.airtableTableId) {
      res.status(503).json({ error: "Airtable not configured. Set AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID." });
      return;
    }

    const unsynced = store.getEventsWithoutAirtableId();
    if (unsynced.length === 0) {
      res.json({ message: "All events already synced to Airtable.", synced: 0 });
      return;
    }

    console.log(`[airtable-sync] Syncing ${unsynced.length} events to Airtable...`);
    res.json({ message: `Syncing ${unsynced.length} events to Airtable in background.` });

    const { airtableBatchCreate, toAirtableFields } = await import("./airtable");
    const fields = unsynced.map((e) => toAirtableFields(e));
    const results = await airtableBatchCreate(fields);

    for (const { hash, recordId } of results) {
      store.setAirtableRecordId(hash, recordId);
    }

    console.log(`[airtable-sync] Done! Synced ${results.length}/${unsynced.length} events.`);
  });

  // Seed sample events for testing the UI
  app.post("/api/seed", requireAdmin, (_req, res) => {
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

  // ── Disk usage & cleanup ──

  function getDirSize(dirPath: string): number {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          total += getDirSize(fullPath);
        } else {
          total += fs.statSync(fullPath).size;
        }
      } catch { /* skip inaccessible files */ }
    }
    return total;
  }

  function getFileSize(filePath: string): number {
    try { return fs.statSync(filePath).size; } catch { return 0; }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // GET /api/disk-usage — show what's consuming storage
  app.get("/api/disk-usage", requireAdmin, (_req, res) => {
    const dbFile = config.dbPath;
    const walFile = dbFile + "-wal";
    const shmFile = dbFile + "-shm";
    const authDir = config.authDir;

    const dbSize = getFileSize(dbFile);
    const walSize = getFileSize(walFile);
    const shmSize = getFileSize(shmFile);
    const authSize = getDirSize(authDir);

    // Scan auth subdirectories for size breakdown
    const authBreakdown: Record<string, string> = {};
    let clearableCacheSize = 0;
    const clearableDirNames = ["Cache", "Code Cache", "GPUCache", "Service Worker", "blob_storage", "Session Storage", "WebStorage"];
    try {
      const sessionDirs = fs.readdirSync(authDir, { withFileTypes: true })
        .filter(e => e.isDirectory());
      for (const sessionDir of sessionDirs) {
        const sessionPath = path.join(authDir, sessionDir.name);
        const sessionSize = getDirSize(sessionPath);
        authBreakdown[sessionDir.name] = formatBytes(sessionSize);
        // Scan Default/ inside session dirs
        const defPath = path.join(sessionPath, "Default");
        if (fs.existsSync(defPath)) {
          try {
            const subs = fs.readdirSync(defPath, { withFileTypes: true })
              .filter(e => e.isDirectory());
            for (const sub of subs) {
              const subSize = getDirSize(path.join(defPath, sub.name));
              if (subSize > 1024 * 1024) {
                authBreakdown[`  ${sessionDir.name}/Default/${sub.name}`] = formatBytes(subSize);
              }
              if (clearableDirNames.includes(sub.name)) {
                clearableCacheSize += subSize;
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }

    // Table row counts + sizes
    const tableCounts = store.getTableCounts();
    const rawSizes = store.getTableSizes();
    const tableSizes: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(rawSizes)) {
      tableSizes[name] = formatBytes(bytes);
    }

    const total = dbSize + walSize + shmSize + authSize;

    res.json({
      total: formatBytes(total),
      totalBytes: total,
      breakdown: {
        "events.db": formatBytes(dbSize),
        "events.db-wal": formatBytes(walSize),
        "events.db-shm": formatBytes(shmSize),
        ".auth/ (total)": formatBytes(authSize),
        "Clearable cache": formatBytes(clearableCacheSize),
      },
      authBreakdown,
      tableCounts,
      tableSizes,
    });
  });

  // GET /api/idb-inspect — inspect WhatsApp Web's IndexedDB contents
  app.get("/api/idb-inspect", requireAdmin, async (_req, res) => {
    if (!opts.idbInspect) {
      res.status(503).json({ error: "IndexedDB inspection not available (WhatsApp not connected)" });
      return;
    }
    try {
      const result = await opts.idbInspect();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Inspection failed" });
    }
  });

  // POST /api/idb-clean — clean media/thumbnail data from WhatsApp Web's IndexedDB
  app.post("/api/idb-clean", requireAdmin, async (req, res) => {
    if (!opts.idbClean) {
      res.status(503).json({ error: "IndexedDB cleanup not available (WhatsApp not connected)" });
      return;
    }
    const dryRun = req.query.dry !== "false"; // default to dry run for safety
    try {
      const result = await opts.idbClean({ dryRun });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Cleanup failed" });
    }
  });

  // POST /api/cleanup — vacuum DB, clear Chrome cache, prune old data
  app.post("/api/cleanup", requireAdmin, (req, res) => {
    const actions: string[] = [];
    const dryRun = req.query.dry === "true";

    // 1. Checkpoint and vacuum SQLite
    if (!dryRun) {
      try {
        store.vacuum();
        actions.push("WAL checkpoint + VACUUM completed");
      } catch (err: any) {
        actions.push("VACUUM failed: " + err.message);
      }
    } else {
      actions.push("[dry-run] Would checkpoint WAL and VACUUM database");
    }

    // 2. Clear Chrome cache directories (scan all session-* dirs)
    const authDir = config.authDir;
    const cacheDirNames = ["Cache", "Code Cache", "GPUCache", "Service Worker", "blob_storage", "Session Storage", "WebStorage"];
    let cacheCleared = 0;
    try {
      const sessionDirs = fs.readdirSync(authDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith("session"));
      for (const sessionDir of sessionDirs) {
        const defPath = path.join(authDir, sessionDir.name, "Default");
        if (!fs.existsSync(defPath)) continue;
        for (const sub of cacheDirNames) {
          const cacheDir = path.join(defPath, sub);
          if (fs.existsSync(cacheDir)) {
            const size = getDirSize(cacheDir);
            if (!dryRun) {
              try {
                fs.rmSync(cacheDir, { recursive: true, force: true });
                cacheCleared += size;
                actions.push(`Cleared ${sessionDir.name}/Default/${sub}/ (${formatBytes(size)})`);
              } catch (err: any) {
                actions.push(`Failed to clear ${sub}/: ${err.message}`);
              }
            } else {
              cacheCleared += size;
              actions.push(`[dry-run] Would clear ${sessionDir.name}/Default/${sub}/ (${formatBytes(size)})`);
            }
          }
        }
      }
    } catch (err: any) {
      actions.push("Cache scan failed: " + err.message);
    }

    // 3. Prune processed_messages body text older than 30 days (keep metadata for dedup)
    const thirtyDays = 30 * 86400;
    try {
      if (!dryRun) {
        const pruned = store.pruneOldMessageBodies(thirtyDays);
        actions.push(`Pruned message bodies: ${pruned} rows`);
      } else {
        const count = store.countPrunableMessageBodies(thirtyDays);
        actions.push(`[dry-run] Would prune ${count} old message bodies`);
      }
    } catch (err: any) {
      actions.push("Body pruning failed: " + err.message);
    }

    res.json({ actions, cacheCleared: formatBytes(cacheCleared) });
  });

  // Mount app-specific routers (admin-protected by default, or auth-level for guest+admin)
  if (opts.appRouters) {
    for (const { path: routePath, router, authLevel } of opts.appRouters) {
      const middleware = authLevel === "auth" ? requireAuth : requireAdmin;
      app.use(routePath, middleware, router);
      console.log(`[server] Mounted app router at ${routePath} (${authLevel || "admin"})`);
    }
  }

  app.listen(config.port, () => {
    console.log(`\nWeb UI available at http://localhost:${config.port}`);
    if (!process.env.ADMIN_TOKEN) {
      console.log(`Admin token: auto-generated (set ADMIN_TOKEN env var for a stable token)\n`);
    } else {
      console.log(`Admin token: loaded from ADMIN_TOKEN env var.\n`);
    }
  });
}
