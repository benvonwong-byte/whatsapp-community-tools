import { RelationshipStore, RelationshipAnalysis } from "./store";

/**
 * Format a concise daily check-in message.
 * Structure: 1 thing for Hope, 1 for Ben, 1 for the relationship, brief stats.
 */
function formatDailyUpdate(analysis: RelationshipAnalysis): string {
  const m = JSON.parse(analysis.metricsJson);
  const score = m.overallHealthScore ?? 0;
  const scoreEmoji = score >= 70 ? "🟢" : score >= 40 ? "🟡" : "🔴";

  const lines: string[] = [];
  lines.push(`💕 *Daily Check-in* — ${formatDate(analysis.date)}`);
  lines.push("");

  // One thing for each person + relationship
  const recs = m.recommendations || {};
  const hopeRec = (recs.forHope && recs.forHope[0]) || null;
  const benRec = (recs.forBen && recs.forBen[0]) || null;
  const togetherRec = (recs.forBoth && recs.forBoth[0]) || null;

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
  lines.push(`_${analysis.messageCount} msgs analyzed_`);

  return lines.join("\n");
}

/**
 * Format a weekly summary — same concise structure with trend line.
 */
function formatWeeklyUpdate(analyses: RelationshipAnalysis[]): string {
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
  lines.push(`💕 *Weekly Summary* — ${formatDate(startDate)} to ${formatDate(endDate)}`);
  lines.push("");

  // One thing for each person + relationship from most recent analysis
  const latestM = JSON.parse(analyses[0].metricsJson);
  const recs = latestM.recommendations || {};
  const hopeRec = (recs.forHope && recs.forHope[0]) || null;
  const benRec = (recs.forBen && recs.forBen[0]) || null;
  const togetherRec = (recs.forBoth && recs.forBoth[0]) || null;

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
  lines.push(`_${totalMsgs} msgs across ${analyses.length} days_`);

  return lines.join("\n");
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Build the update message based on frequency setting.
 * Returns the formatted message or null if no data available.
 */
export function buildUpdateMessage(
  store: RelationshipStore,
  frequency: "daily" | "weekly"
): string | null {
  if (frequency === "weekly") {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const analyses = store.getAnalysesByRange(startDate, endDate);
    if (analyses.length === 0) return null;
    return formatWeeklyUpdate(analyses);
  }

  // Daily: get yesterday's analysis (most recent)
  const analyses = store.getAnalyses(1);
  if (analyses.length === 0) return null;
  return formatDailyUpdate(analyses[0]);
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
