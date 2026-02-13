import { Router, Request, Response } from "express";
import { RelationshipStore, RelationshipAnalysis } from "./store";
import { config } from "../../config";

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

// ── WhatsApp .txt export parser ──

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function parseWhatsAppDate(dateStr: string, timeStr: string): number {
  const parts = dateStr.split("/");
  if (parts.length !== 3) return 0;

  let month = parseInt(parts[0]);
  let day = parseInt(parts[1]);
  let year = parseInt(parts[2]);
  if (year < 100) year += 2000;

  const timeParts = timeStr.trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/);
  if (!timeParts) return 0;

  let hour = parseInt(timeParts[1]);
  const minute = parseInt(timeParts[2]);
  const second = timeParts[3] ? parseInt(timeParts[3]) : 0;
  const ampm = timeParts[4]?.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  const date = new Date(year, month - 1, day, hour, minute, second);
  if (isNaN(date.getTime())) return 0;
  return Math.floor(date.getTime() / 1000);
}

/**
 * Parse a WhatsApp .txt chat export into messages.
 * Handles formats like:
 *   1/14/25, 7:30 PM - Sender: Message
 *   [1/14/25, 7:30:45 PM] Sender: Message
 */
function parseWhatsAppExport(text: string): Array<{
  id: string; speaker: string; body: string;
  transcript: string; timestamp: number; type: string;
}> {
  const lines = text.split("\n");
  const messages: Array<{
    id: string; speaker: string; body: string;
    transcript: string; timestamp: number; type: string;
  }> = [];

  // Match WhatsApp export line start
  const lineRegex = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)\]?\s*[-–]?\s*(.*)/;
  const partnerLower = config.relationshipChatName.toLowerCase();

  let current: (typeof messages)[number] | null = null;

  for (const line of lines) {
    const match = line.match(lineRegex);
    if (match) {
      if (current) messages.push(current);

      const [, dateStr, timeStr, rest] = match;
      const colonIdx = rest.indexOf(": ");
      if (colonIdx === -1) {
        // System message (no colon separator)
        current = null;
        continue;
      }

      const sender = rest.slice(0, colonIdx).trim();
      const body = rest.slice(colonIdx + 2);

      // Skip media/deleted messages
      if (body === "<Media omitted>" || body === "This message was deleted" ||
          body === "You deleted this message") {
        current = null;
        continue;
      }

      const timestamp = parseWhatsAppDate(dateStr, timeStr);
      if (!timestamp) { current = null; continue; }

      // Determine speaker: if sender name contains partner name → "hope", else "self"
      const speaker = sender.toLowerCase().includes(partnerLower) ? "hope" : "self";
      const hash = simpleHash(timestamp + sender + body);

      current = {
        id: `import_${timestamp}_${hash}`,
        speaker,
        body,
        transcript: "",
        timestamp,
        type: "text",
      };
    } else if (current && line.trim()) {
      // Continuation line for multi-line messages
      current.body += "\n" + line;
    }
  }

  if (current) messages.push(current);
  return messages;
}

// ── Router ──

export function createRelationshipRouter(
  store: RelationshipStore,
  analyzeTrigger: () => Promise<void>,
  backfillTrigger: () => Promise<number>
): Router {
  const router = Router();

  // GET /api/relationship/dashboard — shaped for frontend consumption
  // Accepts optional ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD for date range filtering
  router.get("/dashboard", (req: Request, res: Response) => {
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    let analyses: RelationshipAnalysis[];
    let stats: any;

    if (startDate && endDate) {
      analyses = store.getAnalysesByRange(startDate, endDate);
      const startTs = Math.floor(new Date(startDate + "T00:00:00").getTime() / 1000);
      const endTs = Math.floor(new Date(endDate + "T23:59:59").getTime() / 1000);
      stats = store.getStatsByRange(startTs, endTs);
    } else {
      analyses = store.getAnalyses(30);
      stats = store.getStats();
    }

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

  // POST /api/relationship/backfill — fetch WhatsApp history for Hope's chat
  router.post("/backfill", async (req: Request, res: Response) => {
    try {
      const count = await backfillTrigger();
      res.json({ ok: true, messagesImported: count });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Backfill failed" });
    }
  });

  // POST /api/relationship/import — import WhatsApp .txt export
  // Body: { text: "...raw .txt file content..." }
  router.post("/import", (req: Request, res: Response) => {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing 'text' field with .txt file content" });
      return;
    }

    const parsed = parseWhatsAppExport(text);
    let imported = 0;
    for (const msg of parsed) {
      if (!store.isDuplicate(msg.id)) {
        store.saveMessage(msg);
        imported++;
      }
    }

    res.json({
      ok: true,
      imported,
      total: parsed.length,
      duplicates: parsed.length - imported,
    });
  });

  return router;
}
