import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../../config";
import { RelationshipStore, RelationshipAnalysis, RelationshipMessage } from "./store";

let geminiModel: any = null;
function getModel() {
  if (!geminiModel) {
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  }
  return geminiModel;
}

export interface Recommendation {
  for: string; // config.relationshipSelfName, config.relationshipPartnerName, or "Both"
  text: string;
  window: "24h" | "48h" | "week";
}

export interface MultiWindowRecs {
  recommendations: Recommendation[];
}

/** Format messages into a readable conversation string */
function formatConversation(messages: RelationshipMessage[]): string {
  const selfName = config.relationshipSelfName;
  const partnerName = config.relationshipPartnerName;
  return messages.map((m) => {
    const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
    const speaker = m.speaker === "self" ? selfName : partnerName;
    const sourceTag = m.source === "in-person" ? "[in-person] " : "";
    const content = m.type === "voice" ? `[voice note] ${m.transcript}` : m.body;
    return `[${time}] ${sourceTag}${speaker}: ${content}`;
  }).join("\n");
}

/** Generate recommendations across multiple time windows (24h, 48h, 7d) with variable count */
async function generateMultiWindowRecommendations(
  store: RelationshipStore,
  latestAnalysis: RelationshipAnalysis | null
): Promise<MultiWindowRecs | null> {
  const msgs24h = store.getRecentMessages(24);
  const msgs48h = store.getRecentMessages(48);
  const msgs7d = store.getRecentMessages(168); // 7 * 24

  if (msgs24h.length === 0 && msgs48h.length === 0 && msgs7d.length === 0) return null;

  // Only include older messages (to avoid repeating the 24h window)
  const msgs48hOnly = msgs48h.filter((m) => {
    const ageHours = (Date.now() / 1000 - m.timestamp) / 3600;
    return ageHours > 24;
  });
  const msgs7dOnly = msgs7d.filter((m) => {
    const ageHours = (Date.now() / 1000 - m.timestamp) / 3600;
    return ageHours > 48;
  });

  const conv24h = formatConversation(msgs24h).slice(0, 6000);
  const conv48h = msgs48hOnly.length > 0 ? formatConversation(msgs48hOnly).slice(0, 4000) : "";
  const conv7d = msgs7dOnly.length > 0 ? formatConversation(msgs7dOnly).slice(0, 4000) : "";

  const analysisContext = latestAnalysis
    ? `\nLATEST ANALYSIS (${latestAnalysis.date}): ${latestAnalysis.summary}`
    : "";

  const windowSections: string[] = [];
  if (msgs24h.length > 0) {
    windowSections.push(`== LAST 24 HOURS (${msgs24h.length} messages) ==\n${conv24h}`);
  }
  if (msgs48hOnly.length > 0) {
    windowSections.push(`== 24-48 HOURS AGO (${msgs48hOnly.length} messages) ==\n${conv48h}`);
  }
  if (msgs7dOnly.length > 0) {
    windowSections.push(`== 2-7 DAYS AGO (${msgs7dOnly.length} messages) ==\n${conv7d}`);
  }

  const selfName = config.relationshipSelfName;
  const partnerName = config.relationshipPartnerName;

  const prompt = `You are a relationship coach for ${selfName} and ${partnerName} (a couple). You have their conversations from three time windows below. Generate specific, actionable recommendations based on what you see.

${windowSections.join("\n\n")}
${analysisContext}

INSTRUCTIONS:
- Generate between 2 and 6 recommendations. Vary the count based on what's actually interesting and actionable — don't force it. Some days there's more to say, some days less. Keep it organic.
- Draw from different time windows when there's something worth noting:
  - "24h" recs: based on today's conversations (always include at least 1-2 if there are recent messages)
  - "48h" recs: patterns or follow-ups from the last couple days (only if there's something notable)
  - "week" recs: trends, recurring patterns, or things that have been building over the week (only if there's a real trend worth calling out)
- Each rec should be for "${partnerName}", "${selfName}", or "Both"
- Each must reference something SPECIFIC from the conversations — no generic advice
- Keep each to 1-2 sentences max
- If a time window has no messages or nothing interesting, skip it entirely — don't pad with filler

Respond with ONLY a JSON object (no markdown code fences):
{
  "recommendations": [
    { "for": "${partnerName}"|"${selfName}"|"Both", "text": "<specific actionable recommendation>", "window": "24h"|"48h"|"week" }
  ]
}

JSON:`;

  try {
    const model = getModel();
    const result = await model.generateContent(prompt);
    let text = result.response.text().trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
    const parsed = JSON.parse(text);
    if (!parsed.recommendations || !Array.isArray(parsed.recommendations)) return null;
    // Validate individual items and clamp to 6 max
    const validFor = new Set([config.relationshipPartnerName, config.relationshipSelfName, "Both"]);
    const validWindow = new Set(["24h", "48h", "week"]);
    parsed.recommendations = parsed.recommendations
      .filter((r: any) =>
        r && typeof r.text === "string" && r.text.length > 0 &&
        validFor.has(r.for) && validWindow.has(r.window)
      )
      .slice(0, 6);
    if (parsed.recommendations.length === 0) return null;
    return parsed as MultiWindowRecs;
  } catch (err) {
    console.error("[updater] Failed to generate multi-window recommendations:", err);
    return null;
  }
}

/** Map a Recommendation to its emoji prefix */
function recEmoji(rec: Recommendation): string {
  if (rec.for === config.relationshipPartnerName) return "💗";
  if (rec.for === config.relationshipSelfName) return "💙";
  return "🌱";
}

/** Map a window label to a short tag */
function windowTag(window: string): string {
  if (window === "48h") return " _(last 2 days)_";
  if (window === "week") return " _(this week)_";
  return "";
}

/**
 * Format a concise daily check-in message.
 * Uses multi-window AI recommendations with variable count.
 */
function formatDailyUpdate(
  analysis: RelationshipAnalysis,
  multiRecs: MultiWindowRecs | null
): string {
  const m = JSON.parse(analysis.metricsJson);
  const score = m.overallHealthScore ?? 0;
  const scoreEmoji = score >= 70 ? "🟢" : score >= 40 ? "🟡" : "🔴";

  const lines: string[] = [];
  lines.push(`💕 *Daily Check-in* — ${formatDateStr(analysis.date)}`);
  lines.push("");

  if (multiRecs && multiRecs.recommendations.length > 0) {
    for (const rec of multiRecs.recommendations) {
      const tag = windowTag(rec.window);
      lines.push(`${recEmoji(rec)} *${rec.for}:* ${rec.text}${tag}`);
    }
  } else {
    // Fall back to stored analysis recommendations
    const recs = m.recommendations || {};
    const partnerRec = (recs.forPartner && recs.forPartner[0]) || null;
    const selfRec = (recs.forSelf && recs.forSelf[0]) || null;
    const togetherRec = (recs.forBoth && recs.forBoth[0]) || null;
    if (partnerRec) lines.push(`💗 *${config.relationshipPartnerName}:* ${partnerRec}`);
    if (selfRec) lines.push(`💙 *${config.relationshipSelfName}:* ${selfRec}`);
    if (togetherRec) lines.push(`🌱 *Together:* ${togetherRec}`);
  }

  // Brief stats
  lines.push("");
  lines.push(`${scoreEmoji} Health: ${score}/100`);

  if (m.emotionalBankAccount) {
    const bank = m.emotionalBankAccount;
    const bankEmoji = bank.status === "healthy" ? "✅" : bank.status === "watch" ? "⚠️" : "🚨";
    lines.push(`🏦 Bank: ${bank.ratio.toFixed(1)}:1 ${bankEmoji}`);
  }

  if (m.bids) {
    const total = (m.bids.turnedToward || 0) + (m.bids.turnedAway || 0) + (m.bids.turnedAgainst || 0);
    if (total > 0) {
      const towardPct = Math.round((m.bids.turnedToward / total) * 100);
      lines.push(`🤝 Bids: ${towardPct}% toward (${m.bids.turnedToward}/${total})`);
    }
  }

  if (multiRecs && multiRecs.recommendations.length > 0) {
    const windows = [...new Set(multiRecs.recommendations.map((r) => r.window))];
    const windowLabels = windows.map((w) => w === "24h" ? "today" : w === "48h" ? "last 2 days" : "this week");
    lines.push("");
    lines.push(`_${multiRecs.recommendations.length} recs from ${windowLabels.join(", ")}_`);
  } else {
    lines.push("");
    lines.push(`_${analysis.messageCount} msgs analyzed_`);
  }

  return lines.join("\n");
}

/**
 * Format a weekly summary with multi-window recommendations.
 */
function formatWeeklyUpdate(
  analyses: RelationshipAnalysis[],
  multiRecs: MultiWindowRecs | null
): string {
  if (analyses.length === 0) return "";

  const scores = analyses.map((a) => {
    try { return JSON.parse(a.metricsJson).overallHealthScore ?? 0; } catch { return 0; }
  });
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const scoreEmoji = avgScore >= 70 ? "🟢" : avgScore >= 40 ? "🟡" : "🔴";
  const totalMsgs = analyses.reduce((s, a) => s + (a.messageCount || 0), 0);
  const startDate = analyses[analyses.length - 1].date;
  const endDate = analyses[0].date;

  const latestM = JSON.parse(analyses[0].metricsJson);

  const lines: string[] = [];
  lines.push(`💕 *Weekly Summary* — ${formatDateStr(startDate)} to ${formatDateStr(endDate)}`);
  lines.push("");

  if (multiRecs && multiRecs.recommendations.length > 0) {
    for (const rec of multiRecs.recommendations) {
      const tag = windowTag(rec.window);
      lines.push(`${recEmoji(rec)} *${rec.for}:* ${rec.text}${tag}`);
    }
  } else {
    // Fall back to stored analysis recommendations
    const recs = latestM.recommendations || {};
    const partnerRec = (recs.forPartner && recs.forPartner[0]) || null;
    const selfRec = (recs.forSelf && recs.forSelf[0]) || null;
    const togetherRec = (recs.forBoth && recs.forBoth[0]) || null;
    if (partnerRec) lines.push(`💗 *${config.relationshipPartnerName}:* ${partnerRec}`);
    if (selfRec) lines.push(`💙 *${config.relationshipSelfName}:* ${selfRec}`);
    if (togetherRec) lines.push(`🌱 *Together:* ${togetherRec}`);
  }

  // Brief stats
  lines.push("");
  lines.push(`${scoreEmoji} Avg Score: ${avgScore}/100 (${analyses.length} days)`);

  if (scores.length >= 2) {
    const first = scores[scores.length - 1];
    const last = scores[0];
    const diff = last - first;
    const trendEmoji = diff > 5 ? "📈" : diff < -5 ? "📉" : "➡️";
    lines.push(`${trendEmoji} Trend: ${first} → ${last} (${diff > 0 ? "+" : ""}${diff})`);
  }

  if (latestM.emotionalBankAccount) {
    const bank = latestM.emotionalBankAccount;
    const bankEmoji = bank.status === "healthy" ? "✅" : bank.status === "watch" ? "⚠️" : "🚨";
    lines.push(`🏦 Bank: ${bank.ratio.toFixed(1)}:1 ${bankEmoji}`);
  }

  if (multiRecs && multiRecs.recommendations.length > 0) {
    const windows = [...new Set(multiRecs.recommendations.map((r) => r.window))];
    const windowLabels = windows.map((w) => w === "24h" ? "today" : w === "48h" ? "last 2 days" : "this week");
    lines.push("");
    lines.push(`_${totalMsgs} msgs across ${analyses.length} days · ${multiRecs.recommendations.length} recs from ${windowLabels.join(", ")}_`);
  } else {
    lines.push("");
    lines.push(`_${totalMsgs} msgs across ${analyses.length} days_`);
  }

  return lines.join("\n");
}

function formatDateStr(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

/**
 * Build the update message based on frequency setting.
 * Fetches messages from multiple time windows (24h, 48h, 7d) and generates
 * a variable number of AI recommendations. Falls back to stored analysis
 * recommendations if Gemini call fails or no recent messages.
 */
export async function buildUpdateMessage(
  store: RelationshipStore,
  frequency: "daily" | "weekly"
): Promise<string | null> {
  const latestAnalysis = store.getAnalyses(1)[0] || null;

  // Generate multi-window recommendations (24h, 48h, 7d)
  const multiRecs = await generateMultiWindowRecommendations(store, latestAnalysis);

  if (frequency === "weekly") {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const analyses = store.getAnalysesByRange(startDate, endDate);
    if (analyses.length === 0) return null;
    return formatWeeklyUpdate(analyses, multiRecs);
  }

  // Daily: get most recent analysis
  if (!latestAnalysis) return null;
  return formatDailyUpdate(latestAnalysis, multiRecs);
}

/**
 * Check if it's time to send an update based on frequency and last sent time.
 */
export function shouldSendUpdate(store: RelationshipStore): boolean {
  const frequency = store.getSetting("update_frequency");
  if (!frequency || frequency === "off") return false;

  const lastSent = store.getSetting("update_last_sent");
  if (!lastSent) return true; // never sent before

  const lastSentDate = new Date(lastSent);
  const now = new Date();
  const hoursSince = (now.getTime() - lastSentDate.getTime()) / (1000 * 60 * 60);

  if (frequency === "daily") return hoursSince >= 20; // at least 20 hours gap
  if (frequency === "weekly") return hoursSince >= 144; // at least 6 days gap

  return false;
}
