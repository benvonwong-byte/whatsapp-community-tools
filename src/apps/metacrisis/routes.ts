import { Router, Request, Response } from "express";
import { MetacrisisStore } from "./store";

export function createMetacrisisRouter(
  store: MetacrisisStore,
  summarizeTrigger: () => Promise<void>,
  pushToWhatsApp: (date: string) => Promise<void>
): Router {
  const router = Router();

  // GET /api/metacrisis/summaries?days=30
  router.get("/summaries", (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query.days as string) || 30, 365);
    const summaries = store.getSummaries(days);
    res.json(summaries);
  });

  // GET /api/metacrisis/summaries/:date
  router.get("/summaries/:date", (req: Request, res: Response) => {
    const summary = store.getSummary(req.params.date as string);
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
    // If no date provided, return recent messages
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

  // GET /api/metacrisis/settings
  router.get("/settings", (req: Request, res: Response) => {
    const settings = store.getAllSettings();
    res.json(settings);
  });

  // POST /api/metacrisis/summarize — trigger immediate summarization
  router.post("/summarize", async (req: Request, res: Response) => {
    try {
      await summarizeTrigger();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Summarization failed" });
    }
  });

  // POST /api/metacrisis/push/:date — push summary to WhatsApp
  router.post("/push/:date", async (req: Request, res: Response) => {
    try {
      const date = req.params.date as string;
      const summary = store.getSummary(date);
      if (!summary) {
        res.status(404).json({ error: "No summary for this date" });
        return;
      }
      await pushToWhatsApp(date);
      store.markPushed(date);
      res.json({ ok: true, date, pushed: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Push failed" });
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
