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

/** Format messages into a readable conversation string */
function formatConversation(messages: RelationshipMessage[]): string {
  return messages.map((m) => {
    const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    const speaker = m.speaker === "self" ? "Ben" : "Hope";
    const sourceTag = m.source === "in-person" ? "[in-person] " : "";
    const content = m.type === "voice" ? `[voice note] ${m.transcript}` : m.body;
    return `[${time}] ${sourceTag}${speaker}: ${content}`;
  }).join("\n");
}

/** Ask Gemini for fresh recommendations based on last 24h of chat */
async function generateFreshRecommendations(
  messages: RelationshipMessage[],
  latestAnalysis: RelationshipAnalysis | null
): Promise<{ forHope: string; forBen: string; forBoth: string } | null> {
  if (messages.length === 0) return null;

  const conversation = formatConversation(messages).slice(0, 8000);
  const analysisContext = latestAnalysis
    ? `\nLATEST ANALYSIS (${latestAnalysis.date}): ${latestAnalysis.summary}`
    : "";

  const prompt = `You are a relationship coach for Ben and Hope (a couple). Based on their last 24 hours of conversation, give 3 brief, specific, actionable recommendations.

LAST 24 HOURS (${messages.length} messages):
${conversation}
${analysisContext}

Each recommendation must reference something specific from the conversation above — not generic advice. Keep each to 1-2 sentences max.

Respond with ONLY a JSON object (no markdown code fences):
{
  "forHope": "<one specific thing Hope could do based on the last 24h>",
  "forBen": "<one specific thing Ben could do based on the last 24h>",
  "forBoth": "<one shared activity or practice to try together>"
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
    return JSON.parse(text);
  } catch (err) {
    console.error("[updater] Failed to generate fresh recommendations:", err);
    return null;
  }
}

/**
 * Format a concise daily check-in message.
 * Uses fresh AI recommendations based on last 24h of chat.
 */
function formatDailyUpdate(
  analysis: RelationshipAnalysis,
  freshRecs: { forHope: string; forBen: string; forBoth: string } | null,
  recentMsgCount: number
): string {
  const m = JSON.parse(analysis.metricsJson);
  const score = m.overallHealthScore ?? 0;
  const scoreEmoji = score >= 70 ? "🟢" : score >= 40 ? "🟡" : "🔴";

  const lines: string[] = [];
  lines.push(`💕 *Daily Check-in* — ${formatDateStr(analysis.date)}`);
  lines.push("");

  // Use fresh recommendations from last 24h if available, fall back to stored analysis
  const recs = freshRecs || m.recommendations || {};
  const hopeRec = freshRecs ? freshRecs.forHope : (recs.forHope && recs.forHope[0]) || null;
  const benRec = freshRecs ? freshRecs.forBen : (recs.forBen && recs.forBen[0]) || null;
  const togetherRec = freshRecs ? freshRecs.forBoth : (recs.forBoth && recs.forBoth[0]) || null;

  if (hopeRec) lines.push(`💗 *Hope:* ${hopeRec}`);
  if (benRec) lines.push(`💙 *Ben:* ${benRec}`);
  if (togetherRec) lines.push(`🌱 *Together:* ${togetherRec}`);

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

  lines.push("");
  if (freshRecs && recentMsgCount > 0) {
    lines.push(`_Based on ${recentMsgCount} msgs in last 24h_`);
  } else {
    lines.push(`_${analysis.messageCount} msgs analyzed_`);
  }

  return lines.join("\n");
}

/**
 * Format a weekly summary — same concise structure with trend line.
 * Uses fresh AI recommendations based on last 24h of chat.
 */
function formatWeeklyUpdate(
  analyses: RelationshipAnalysis[],
  freshRecs: { forHope: string; forBen: string; forBoth: string } | null,
  recentMsgCount: number
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

  const lines: string[] = [];
  lines.push(`💕 *Weekly Summary* — ${formatDateStr(startDate)} to ${formatDateStr(endDate)}`);
  lines.push("");

  // Use fresh recommendations from last 24h if available, fall back to stored analysis
  const latestM = JSON.parse(analyses[0].metricsJson);
  const recs = freshRecs || latestM.recommendations || {};
  const hopeRec = freshRecs ? freshRecs.forHope : (recs.forHope && recs.forHope[0]) || null;
  const benRec = freshRecs ? freshRecs.forBen : (recs.forBen && recs.forBen[0]) || null;
  const togetherRec = freshRecs ? freshRecs.forBoth : (recs.forBoth && recs.forBoth[0]) || null;

  if (hopeRec) lines.push(`💗 *Hope:* ${hopeRec}`);
  if (benRec) lines.push(`💙 *Ben:* ${benRec}`);
  if (togetherRec) lines.push(`🌱 *Together:* ${togetherRec}`);

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

  lines.push("");
  if (freshRecs && recentMsgCount > 0) {
    lines.push(`_${totalMsgs} msgs across ${analyses.length} days · recs from last 24h (${recentMsgCount} msgs)_`);
  } else {
    lines.push(`_${totalMsgs} msgs across ${analyses.length} days_`);
  }

  return lines.join("\n");
}

function formatDateStr(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Build the update message based on frequency setting.
 * Fetches last 24h of chat history and generates fresh AI recommendations.
 * Falls back to stored analysis recommendations if Gemini call fails or no recent messages.
 */
export async function buildUpdateMessage(
  store: RelationshipStore,
  frequency: "daily" | "weekly"
): Promise<string | null> {
  // Fetch last 24h of messages for fresh recommendations
  const recentMessages = store.getRecentMessages(24);
  const latestAnalysis = store.getAnalyses(1)[0] || null;

  // Generate fresh recommendations from last 24h (falls back gracefully)
  const freshRecs = recentMessages.length > 0
    ? await generateFreshRecommendations(recentMessages, latestAnalysis)
    : null;

  if (frequency === "weekly") {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const analyses = store.getAnalysesByRange(startDate, endDate);
    if (analyses.length === 0) return null;
    return formatWeeklyUpdate(analyses, freshRecs, recentMessages.length);
  }

  // Daily: get most recent analysis
  if (!latestAnalysis) return null;
  return formatDailyUpdate(latestAnalysis, freshRecs, recentMessages.length);
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
