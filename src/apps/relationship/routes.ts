import { Router, Request, Response } from "express";
import { RelationshipStore, RelationshipAnalysis } from "./store";
import { runDailyAnalysis } from "./analyzer";

/** Parse a stored analysis into a frontend-friendly shape */
function parseAnalysisForFrontend(a: RelationshipAnalysis) {
  try {
    const m = JSON.parse(a.metricsJson);
    return {
      date: a.date,
      overallScore: m.overallHealthScore ?? 0,
      summary: a.summary,
      messageCount: a.messageCount,
      voiceMinutes: a.voiceMinutes,
      emotionalTone: m.emotionalTone ?? "neutral",
      horsemen: {
        criticism: (m.criticism ?? 0) * 10,
        contempt: (m.contempt ?? 0) * 10,
        stonewalling: (m.stonewalling ?? 0) * 10,
        defensiveness: (m.defensiveness ?? 0) * 10,
      },
      positives: {
        fondness: (m.fondnessAdmiration ?? 0) * 10,
        turningToward: (m.turningToward ?? 0) * 10,
        repair: (m.repairAttempts ?? 0) * 10,
      },
      perel: {
        curiosity: (m.curiosity ?? 0) * 10,
        playfulness: (m.playfulness ?? 0) * 10,
        autonomyBalance: (m.autonomyTogetherness ?? 0) * 10,
      },
    };
  } catch {
    return {
      date: a.date, overallScore: 0, summary: a.summary,
      messageCount: a.messageCount, voiceMinutes: a.voiceMinutes,
      emotionalTone: "neutral",
      horsemen: { criticism: 0, contempt: 0, stonewalling: 0, defensiveness: 0 },
      positives: { fondness: 0, turningToward: 0, repair: 0 },
      perel: { curiosity: 0, playfulness: 0, autonomyBalance: 0 },
    };
  }
}

export function createRelationshipRouter(
  store: RelationshipStore,
  analyzeTrigger: () => Promise<void>
): Router {
  const router = Router();

  // GET /api/relationship/dashboard — shaped for frontend consumption
  router.get("/dashboard", (req: Request, res: Response) => {
    const analyses = store.getAnalyses(30);
    const stats = store.getStats() as any;
    const health = store.getHealth();

    const latestAnalysis = analyses.length > 0
      ? parseAnalysisForFrontend(analyses[0])
      : null;

    const trend = analyses
      .map((a) => {
        try {
          const m = JSON.parse(a.metricsJson);
          return { date: a.date, score: m.overallHealthScore ?? 0 };
        } catch { return null; }
      })
      .filter(Boolean)
      .reverse(); // oldest first for chart

    const dailyAnalyses = analyses.map((a) => parseAnalysisForFrontend(a));

    const totalMessages = stats.totalMessages ?? 0;
    const selfMessages = stats.selfMessages ?? 0;
    const hopeMessages = stats.hopeMessages ?? 0;
    const totalForRatio = selfMessages + hopeMessages || 1;

    const daysTracked = stats.firstTimestamp && stats.lastTimestamp
      ? Math.max(1, Math.ceil((stats.lastTimestamp - stats.firstTimestamp) / 86400))
      : 0;

    // Sum voice minutes from all analyses
    const totalVoiceMinutes = analyses.reduce((sum, a) => sum + (a.voiceMinutes || 0), 0);

    res.json({
      monitoring: {
        lastMessageAt: health.lastMessageTimestamp
          ? new Date(health.lastMessageTimestamp * 1000).toISOString()
          : null,
        messagesToday: health.todayMessageCount,
      },
      stats: {
        totalMessages,
        voiceMinutes: Math.round(totalVoiceMinutes * 10) / 10,
        daysTracked,
        messageRatio: {
          benPercent: (selfMessages / totalForRatio) * 100,
          hopePercent: (hopeMessages / totalForRatio) * 100,
        },
      },
      latestAnalysis,
      trend,
      dailyAnalyses,
    });
  });

  // GET /api/relationship/analyses?days=30
  router.get("/analyses", (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query.days as string) || 30, 365);
    const analyses = store.getAnalyses(days);
    res.json(analyses);
  });

  // GET /api/relationship/analyses/:date
  router.get("/analyses/:date", (req: Request, res: Response) => {
    const analysis = store.getAnalysis(req.params.date as string);
    if (!analysis) {
      res.status(404).json({ error: "No analysis for this date" });
      return;
    }
    res.json(analysis);
  });

  // GET /api/relationship/messages?date=YYYY-MM-DD&limit=50
  router.get("/messages", (req: Request, res: Response) => {
    const date = req.query.date as string;
    if (date) {
      const messages = store.getMessagesByDate(date);
      res.json(messages);
      return;
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const messages = store.getMessages(limit);
    res.json(messages);
  });

  // GET /api/relationship/stats
  router.get("/stats", (req: Request, res: Response) => {
    const stats = store.getStats();
    const health = store.getHealth();
    res.json({ ...stats, ...health });
  });

  // GET /api/relationship/health — monitoring
  router.get("/health", (req: Request, res: Response) => {
    const health = store.getHealth();
    res.json(health);
  });

  // POST /api/relationship/analyze — force immediate analysis
  router.post("/analyze", async (req: Request, res: Response) => {
    try {
      await analyzeTrigger();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Analysis failed" });
    }
  });

  return router;
}
