export interface QualityMetrics {
  initiationBalance: number;
  responseTimeScore: number;
  frequencyScore: number;
  consistencyScore: number;
  totalScore: number;
}

export function computeQualityScore(stats: {
  initiationRatio: number;
  myAvgResponseSec: number;
  theirAvgResponseSec: number;
  messages30d: number;
  weeklyStdDev: number;
}): QualityMetrics {
  // Initiation balance: closer to 50/50 = better (0-25 points)
  const initiationBalance = Math.max(0, 25 - Math.abs(50 - stats.initiationRatio) * 0.5);

  // Response time: faster mutual response = better (0-25 points)
  const avgResponseMin = ((stats.myAvgResponseSec || 3600) + (stats.theirAvgResponseSec || 3600)) / 2 / 60;
  const responseTimeScore = Math.max(0, 25 - avgResponseMin * 0.25);

  // Frequency: more messages in last 30 days = better, capped (0-25 points)
  const weeklyMessages = stats.messages30d / 4.3;
  const frequencyScore = Math.min(25, weeklyMessages * 2.5);

  // Consistency: lower weekly stddev = better (0-25 points)
  const consistencyScore = Math.max(0, 25 - (stats.weeklyStdDev || 0) * 2);

  const totalScore = Math.round(
    Math.max(0, Math.min(100, initiationBalance + responseTimeScore + frequencyScore + consistencyScore))
  );

  return { initiationBalance, responseTimeScore, frequencyScore, consistencyScore, totalScore };
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
