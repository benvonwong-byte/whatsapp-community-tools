import { Router, Request, Response } from "express";
import { MetacrisisStore } from "./store";
import { MetacrisisHandlerDiagnostics } from "./handler";

export function createMetacrisisRouter(
  store: MetacrisisStore,
  weeklySummarizeTrigger: () => Promise<void>,
  dailyDigestTrigger: () => Promise<void>,
  pushToWhatsApp: (date: string) => Promise<void>,
  backfillTrigger: () => Promise<number>,
  processEventsTrigger: () => Promise<number>,
  handlerDiagnostics?: () => MetacrisisHandlerDiagnostics
): Router {
  const router = Router();

  // GET /api/metacrisis/summaries?days=30&type=daily|weekly
  router.get("/summaries", (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query.days as string) || 30, 365);
    const type = req.query.type as string | undefined;
    const summaries = store.getSummaries(days, type);
    res.json(summaries);
  });

  // GET /api/metacrisis/summaries/:date
  router.get("/summaries/:date", (req: Request, res: Response) => {
    const type = req.query.type as string | undefined;
    const summary = store.getSummary(req.params.date as string, type);
    if (!summary) {
      res.status(404).json({ error: "No summary for this date" });
      return;
    }
    res.json(summary);
  });

  // GET /api/metacrisis/messages?date=YYYY-MM-DD
  router.get("/messages", (req: Request, res: Response) => {
    const date = req.query.date as string;
    if (date) {
      const messages = store.getMessagesByDate(date);
      res.json(messages);
      return;
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const messages = store.getUnprocessedMessages().slice(0, limit);
    res.json(messages);
  });

  // GET /api/metacrisis/stats
  router.get("/stats", (req: Request, res: Response) => {
    const stats = store.getStats();
    const health = store.getHealth();
    res.json({ ...stats, ...health });
  });

  // GET /api/metacrisis/health
  router.get("/health", (req: Request, res: Response) => {
    const health = store.getHealth();
    res.json(health);
  });

  // GET /api/metacrisis/capture-health — handler diagnostics
  router.get("/capture-health", (_req: Request, res: Response) => {
    const storeHealth = store.getHealth();
    const capture = handlerDiagnostics ? handlerDiagnostics() : null;
    res.json({ ...storeHealth, capture });
  });

  // GET /api/metacrisis/links?category=event&limit=50
  router.get("/links", (req: Request, res: Response) => {
    const category = req.query.category as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    if (category) {
      const links = store.getLinksByCategory(category, limit);
      res.json(links);
      return;
    }
    const links = store.getLinks(limit);
    res.json(links);
  });

  // GET /api/metacrisis/leaderboard?limit=10
  router.get("/leaderboard", (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
    const leaderboard = store.getLeaderboard(limit);
    res.json(leaderboard);
  });

  // GET /api/metacrisis/events — upcoming events
  router.get("/events", (_req: Request, res: Response) => {
    store.markPastEvents(); // auto-clean on every request
    const events = store.getUpcomingEvents();
    res.json(events);
  });

  // GET /api/metacrisis/topics?period=week|month|quarter
  router.get("/topics", (req: Request, res: Response) => {
    const period = (req.query.period as string) || "week";
    const now = new Date();
    const endDate = now.toISOString().split("T")[0];
    let startDate: string;
    if (period === "month") {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      startDate = d.toISOString().split("T")[0];
    } else if (period === "quarter") {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      startDate = d.toISOString().split("T")[0];
    } else {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      startDate = d.toISOString().split("T")[0];
    }
    res.json(store.getTopicsByPeriod(startDate, endDate));
  });

  // GET /api/metacrisis/settings
  router.get("/settings", (_req: Request, res: Response) => {
    const settings = store.getAllSettings();
    res.json(settings);
  });

  // POST /api/metacrisis/summarize — trigger weekly summary
  router.post("/summarize", async (_req: Request, res: Response) => {
    try {
      await weeklySummarizeTrigger();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Summarization failed" });
    }
  });

  // POST /api/metacrisis/daily-digest — trigger daily digest manually
  router.post("/daily-digest", async (_req: Request, res: Response) => {
    try {
      await dailyDigestTrigger();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Daily digest failed" });
    }
  });

  // POST /api/metacrisis/process-events — trigger event URL processing
  router.post("/process-events", async (_req: Request, res: Response) => {
    try {
      const count = await processEventsTrigger();
      res.json({ ok: true, processed: count });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Event processing failed" });
    }
  });

  // POST /api/metacrisis/push/:date — push summary to WhatsApp
  router.post("/push/:date", async (req: Request, res: Response) => {
    try {
      const date = req.params.date as string;
      const summary = store.getSummary(date, "weekly");
      if (!summary) {
        res.status(404).json({ error: "No weekly summary for this date" });
        return;
      }
      await pushToWhatsApp(date);
      store.markPushed(date, "weekly");
      res.json({ ok: true, date, pushed: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Push failed" });
    }
  });

  // POST /api/metacrisis/backfill — fetch WhatsApp history (last 2 weeks)
  router.post("/backfill", async (_req: Request, res: Response) => {
    try {
      const count = await backfillTrigger();
      res.json({ ok: true, messagesImported: count });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Backfill failed" });
    }
  });

  // PUT /api/metacrisis/settings — update settings
  router.put("/settings", (req: Request, res: Response) => {
    const allowedKeys = [
      "push_schedule",
      "push_day",
      "push_hour",
      "format_template",
    ];
    const updates = req.body;
    if (!updates || typeof updates !== "object") {
      res.status(400).json({ error: "Request body must be a JSON object" });
      return;
    }
    const applied: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (allowedKeys.includes(key) && typeof value === "string") {
        store.setSetting(key, value);
        applied.push(key);
      }
    }
    res.json({ ok: true, updated: applied, settings: store.getAllSettings() });
  });

  return router;
}
