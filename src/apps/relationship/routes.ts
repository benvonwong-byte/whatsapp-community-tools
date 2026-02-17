import { Router, Request, Response } from "express";
import { RelationshipStore, RelationshipAnalysis } from "./store";
import { AnalyzeProgress } from "./analyzer";
import { buildUpdateMessage } from "./updater";
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
      evidence: m.evidence || {},
      emotionalBankAccount: m.emotionalBankAccount || null,
      bids: m.bids || null,
      pursueWithdraw: m.pursueWithdraw || null,
      recommendations: m.recommendations || null,
      notableQuotes: m.notableQuotes || [],
      languageEmotionAnalysis: m.languageEmotionAnalysis || null,
    };
  } catch {
    return {
      date: a.date, overallScore: 0, summary: a.summary,
      messageCount: a.messageCount, voiceMinutes: a.voiceMinutes,
      emotionalTone: "neutral",
      horsemen: { criticism: 0, contempt: 0, stonewalling: 0, defensiveness: 0 },
      positives: { fondness: 0, turningToward: 0, repair: 0 },
      perel: { curiosity: 0, playfulness: 0, autonomyBalance: 0 },
      evidence: {},
      emotionalBankAccount: null,
      bids: null,
      pursueWithdraw: null,
      recommendations: null,
      notableQuotes: [],
      languageEmotionAnalysis: null,
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
  backfillTrigger: () => Promise<number>,
  transcribeTrigger: () => Promise<number>,
  sendUpdateTrigger: (message: string) => Promise<void>,
  analyzeProgress: AnalyzeProgress
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

    // Computed metrics from raw message data
    const startTs = stats.firstTimestamp || 0;
    const endTs = stats.lastTimestamp || Math.floor(Date.now() / 1000);
    const initiatorRows = store.getInitiatorStats(startTs, endTs);
    const initiators: Record<string, number> = {};
    for (const row of initiatorRows) initiators[row.speaker] = row.initiations;

    const responseTimeRows = store.getResponseTimes(startTs, endTs);
    const responseTimes: Record<string, { avgSec: number; count: number }> = {};
    for (const row of responseTimeRows) {
      responseTimes[row.speaker] = { avgSec: Math.round(row.avg_response_sec), count: row.responses };
    }

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
        initiators,
        responseTimes,
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

  // GET /api/relationship/analyze-status — poll analysis progress
  router.get("/analyze-status", (_req: Request, res: Response) => {
    res.json(analyzeProgress);
  });

  // POST /api/relationship/reset-analyzed — reset all messages to unanalyzed
  router.post("/reset-analyzed", (_req: Request, res: Response) => {
    const count = store.resetAnalyzedFlags();
    res.json({ ok: true, messagesReset: count });
  });

  // POST /api/relationship/analyze — start analysis in background
  router.post("/analyze", (req: Request, res: Response) => {
    if (analyzeProgress.active) {
      res.status(409).json({ error: "Analysis already in progress" });
      return;
    }

    // Respond immediately, run in background
    res.json({ ok: true, message: "Analysis started" });

    analyzeTrigger().catch((err: any) => {
      console.error("[relationship-analyze] Background error:", err);
    });
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

  // POST /api/relationship/transcribe — retro-transcribe voice messages with empty transcripts
  router.post("/transcribe", async (req: Request, res: Response) => {
    try {
      const count = await transcribeTrigger();
      res.json({ ok: true, transcribed: count });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Transcription failed" });
    }
  });

  // POST /api/relationship/fix-voice-minutes — recalculate voice_minutes in analyses from actual message data
  router.post("/fix-voice-minutes", (_req: Request, res: Response) => {
    const analyses = store.getAnalyses(999);
    let fixed = 0;
    for (const a of analyses) {
      const counts = store.getDayMessageCounts(a.date);
      const correctVoiceMin = counts.voice * 0.5;
      if (a.voiceMinutes !== correctVoiceMin) {
        store.saveAnalysis(a.date, a.metricsJson, a.summary, counts.total, correctVoiceMin);
        fixed++;
      }
    }
    res.json({ ok: true, fixed, total: analyses.length });
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

  // POST /api/relationship/import-json — import structured JSON messages (for external apps)
  // Body: { messages: [{ speaker, body, timestamp, type?, source? }], source?: "in-person" }
  router.post("/import-json", (req: Request, res: Response) => {
    const { messages, source } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "Missing 'messages' array" });
      return;
    }

    const msgSource = source || "in-person";
    let imported = 0;
    const errors: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m.speaker || !["self", "hope"].includes(m.speaker)) {
        errors.push(`msg[${i}]: invalid speaker (must be "self" or "hope")`);
        continue;
      }
      if (!m.body || typeof m.body !== "string") {
        errors.push(`msg[${i}]: missing body`);
        continue;
      }
      if (!m.timestamp || typeof m.timestamp !== "number") {
        errors.push(`msg[${i}]: missing/invalid timestamp (unix seconds)`);
        continue;
      }

      const hash = simpleHash(m.timestamp + m.speaker + m.body);
      const id = `${msgSource}_${m.timestamp}_${hash}`;

      if (!store.isDuplicate(id)) {
        store.saveMessage({
          id,
          speaker: m.speaker,
          body: m.body,
          transcript: m.transcript || "",
          timestamp: m.timestamp,
          type: m.type || "text",
          source: msgSource,
        });
        imported++;
      }
    }

    res.json({
      ok: true,
      imported,
      total: messages.length,
      duplicates: messages.length - imported - errors.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  });

  // GET /api/relationship/settings — get update settings
  router.get("/settings", (_req: Request, res: Response) => {
    res.json({
      updateFrequency: store.getSetting("update_frequency") || "off",
      updateSendHour: parseInt(store.getSetting("update_send_hour") || "7", 10),
      updateLastSent: store.getSetting("update_last_sent") || null,
    });
  });

  // POST /api/relationship/settings — update settings
  // Body: { updateFrequency?, updateSendHour? }
  router.post("/settings", (req: Request, res: Response) => {
    const { updateFrequency, updateSendHour } = req.body;
    if (updateFrequency && ["daily", "weekly", "off"].includes(updateFrequency)) {
      store.setSetting("update_frequency", updateFrequency);
    }
    if (updateSendHour !== undefined) {
      const hour = parseInt(updateSendHour, 10);
      if (!isNaN(hour) && hour >= 0 && hour <= 23) {
        store.setSetting("update_send_hour", String(hour));
      }
    }
    res.json({
      ok: true,
      updateFrequency: store.getSetting("update_frequency") || "off",
      updateSendHour: parseInt(store.getSetting("update_send_hour") || "7", 10),
    });
  });

  // POST /api/relationship/send-update — manually send a dashboard update to Hope
  // Optional body: { frequency: "daily" | "weekly" } — defaults to current setting
  router.post("/send-update", async (req: Request, res: Response) => {
    const freq = req.body.frequency || store.getSetting("update_frequency") || "daily";
    const message = buildUpdateMessage(store, freq as "daily" | "weekly");
    if (!message) {
      res.status(404).json({ error: "No analysis data available to send" });
      return;
    }
    try {
      await sendUpdateTrigger(message);
      store.setSetting("update_last_sent", new Date().toISOString());
      res.json({ ok: true, message });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to send update" });
    }
  });

  // GET /api/relationship/preview-update — preview the update message without sending
  router.get("/preview-update", (req: Request, res: Response) => {
    const freq = (req.query.frequency as string) || store.getSetting("update_frequency") || "daily";
    const message = buildUpdateMessage(store, freq as "daily" | "weekly");
    res.json({ message: message || "No analysis data available." });
  });

  // POST /api/relationship/send-custom — send a custom message to Hope via WhatsApp
  router.post("/send-custom", async (req: Request, res: Response) => {
    const { message } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "Message body is required" });
      return;
    }
    try {
      await sendUpdateTrigger(message.trim());
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to send message" });
    }
  });

  return router;
}
