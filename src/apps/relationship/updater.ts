import { RelationshipStore, RelationshipAnalysis } from "./store";

/**
 * Format a single day's analysis into a concise WhatsApp message.
 */
function formatDailyUpdate(analysis: RelationshipAnalysis): string {
  const m = JSON.parse(analysis.metricsJson);
  const score = m.overallHealthScore ?? 0;
  const scoreEmoji = score >= 70 ? "🟢" : score >= 40 ? "🟡" : "🔴";

  const lines: string[] = [];
  lines.push(`💕 *Relationship Check-in* — ${formatDate(analysis.date)}`);
  lines.push("");
  lines.push(`${scoreEmoji} *Health Score: ${score}/100*`);

  // Emotional bank account
  if (m.emotionalBankAccount) {
    const bank = m.emotionalBankAccount;
    const bankEmoji = bank.status === "healthy" ? "✅" : bank.status === "watch" ? "⚠️" : "🚨";
    lines.push(`🏦 Bank Account: ${bank.ratio.toFixed(1)}:1 ${bankEmoji} (${bank.deposits} deposits, ${bank.withdrawals} withdrawals)`);
  }

  // Bids
  if (m.bids) {
    const total = (m.bids.turnedToward || 0) + (m.bids.turnedAway || 0) + (m.bids.turnedAgainst || 0);
    const towardPct = total > 0 ? Math.round((m.bids.turnedToward / total) * 100) : 0;
    lines.push(`🤝 Bids: ${towardPct}% turned toward (${m.bids.turnedToward}/${total})`);
  }

  // Pursue-withdraw
  if (m.pursueWithdraw && m.pursueWithdraw.pattern !== "balanced") {
    lines.push(`🔄 Pattern: ${m.pursueWithdraw.description}`);
  }

  // Summary
  if (analysis.summary) {
    lines.push("");
    lines.push(`📝 ${analysis.summary}`);
  }

  // Recommendations
  if (m.recommendations) {
    const recs = m.recommendations;
    if (recs.forBoth && recs.forBoth.length > 0) {
      lines.push("");
      lines.push("🌱 *Together:*");
      for (const rec of recs.forBoth) {
        lines.push(`• ${rec}`);
      }
    }
    if (recs.forBen && recs.forBen.length > 0) {
      lines.push("");
      lines.push("💙 *For Ben:*");
      for (const rec of recs.forBen) {
        lines.push(`• ${rec}`);
      }
    }
    if (recs.forHope && recs.forHope.length > 0) {
      lines.push("");
      lines.push("💗 *For Hope:*");
      for (const rec of recs.forHope) {
        lines.push(`• ${rec}`);
      }
    }
  }

  lines.push("");
  lines.push(`_${analysis.messageCount} messages analyzed_`);

  return lines.join("\n");
}

/**
 * Format a weekly summary from the last 7 days of analyses.
 */
function formatWeeklyUpdate(analyses: RelationshipAnalysis[]): string {
  if (analyses.length === 0) return "";

  const lines: string[] = [];
  const scores = analyses.map((a) => {
    try { return JSON.parse(a.metricsJson).overallHealthScore ?? 0; } catch { return 0; }
  });
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const scoreEmoji = avgScore >= 70 ? "🟢" : avgScore >= 40 ? "🟡" : "🔴";
  const totalMsgs = analyses.reduce((s, a) => s + (a.messageCount || 0), 0);

  const startDate = analyses[analyses.length - 1].date;
  const endDate = analyses[0].date;

  lines.push(`💕 *Weekly Relationship Summary*`);
  lines.push(`📅 ${formatDate(startDate)} — ${formatDate(endDate)}`);
  lines.push("");
  lines.push(`${scoreEmoji} *Average Score: ${avgScore}/100* (${analyses.length} days)`);

  // Trend
  if (scores.length >= 2) {
    const first = scores[scores.length - 1];
    const last = scores[0];
    const diff = last - first;
    const trendEmoji = diff > 5 ? "📈" : diff < -5 ? "📉" : "➡️";
    lines.push(`${trendEmoji} Trend: ${first} → ${last} (${diff > 0 ? "+" : ""}${diff})`);
  }

  // Aggregate bank account from most recent
  const latest = analyses[0];
  const latestM = JSON.parse(latest.metricsJson);
  if (latestM.emotionalBankAccount) {
    const bank = latestM.emotionalBankAccount;
    const bankEmoji = bank.status === "healthy" ? "✅" : bank.status === "watch" ? "⚠️" : "🚨";
    lines.push(`🏦 Latest Bank Account: ${bank.ratio.toFixed(1)}:1 ${bankEmoji}`);
  }

  // Day-by-day scores
  lines.push("");
  lines.push("*Daily Scores:*");
  for (const a of [...analyses].reverse()) {
    const s = scores[analyses.indexOf(a)];
    const dayEmoji = s >= 70 ? "🟢" : s >= 40 ? "🟡" : "🔴";
    const dayName = new Date(a.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    lines.push(`${dayEmoji} ${dayName}: ${s}/100 (${a.messageCount} msgs)`);
  }

  // Recommendations from latest analysis
  if (latestM.recommendations) {
    const recs = latestM.recommendations;
    if (recs.forBoth && recs.forBoth.length > 0) {
      lines.push("");
      lines.push("🌱 *Focus for next week:*");
      for (const rec of recs.forBoth) {
        lines.push(`• ${rec}`);
      }
    }
  }

  lines.push("");
  lines.push(`_${totalMsgs} messages across ${analyses.length} days_`);

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
