import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config";
import { RelationshipStore, RelationshipMessage } from "./store";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// ── Progress tracking ──

export interface AnalyzeProgress {
  active: boolean;
  phase: "idle" | "collecting" | "analyzing" | "saving" | "done" | "error";
  messageCount: number;
  log: string[];
  errorMessage?: string;
}

function logProgress(progress: AnalyzeProgress | undefined, msg: string) {
  console.log(`[relationship-analysis] ${msg}`);
  if (progress) progress.log.push(msg);
}

// ── Conversation formatting ──

function formatConversation(messages: RelationshipMessage[]): string {
  return messages.map((m) => {
    const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    const speaker = m.speaker === "self" ? "Ben" : "Hope";
    const content = m.type === "voice" ? `[voice note] ${m.transcript}` : m.body;
    return `[${time}] ${speaker}: ${content}`;
  }).join("\n");
}

function buildAnalysisPrompt(conversation: string, messageCount: number, date: string): string {
  return `You are a relationship communication analyst trained in the Gottman Institute's research and Esther Perel's frameworks. Analyze the following conversation between Ben and Hope (a couple).

DATE: ${date}
MESSAGES: ${messageCount}

CONVERSATION:
${conversation}

ANALYSIS FRAMEWORKS:

1. **Gottman Four Horsemen** (rate 0-10, lower is better — 0 means absent):
   - Criticism: attacking character rather than specific behavior
   - Contempt: disrespect, mockery, sarcasm, eye-rolling, name-calling
   - Stonewalling: withdrawing, shutting down, going silent during conflict
   - Defensiveness: deflecting responsibility, making excuses, counter-attacking

2. **Gottman Positives** (rate 0-10, higher is better):
   - Fondness & Admiration: expressions of appreciation, affection, gratitude
   - Turning Toward: responding positively to bids for connection/attention
   - Repair Attempts: efforts to de-escalate tension, use humor, apologize

3. **Esther Perel Dimensions** (rate 0-10, higher is better):
   - Curiosity: genuine questions, interest in the other's inner world
   - Playfulness: humor, lightness, teasing, fun
   - Autonomy vs Togetherness: balance between independence and closeness (5 = balanced)

4. **Conversation Dynamics**:
   - Who initiates more conversations?
   - Ratio of message volume (Ben vs Hope)
   - Emotional tone (positive, neutral, negative, mixed)

5. **Overall Health Score** (0-100): composite assessment

6. **Evidence**: For each metric, provide 1-2 direct quotes or short paraphrases from the conversation that best illustrate why you gave that score. If a metric scores 0 (absent), use an empty array. Keep each quote under 120 characters.

Respond with ONLY a JSON object (no markdown):
{
  "metrics": {
    "criticism": <0-10>,
    "contempt": <0-10>,
    "stonewalling": <0-10>,
    "defensiveness": <0-10>,
    "fondnessAdmiration": <0-10>,
    "turningToward": <0-10>,
    "repairAttempts": <0-10>,
    "curiosity": <0-10>,
    "playfulness": <0-10>,
    "autonomyTogetherness": <0-10>,
    "overallHealthScore": <0-100>,
    "emotionalTone": "positive" | "neutral" | "negative" | "mixed"
  },
  "evidence": {
    "criticism": ["quote or paraphrase...", "..."],
    "contempt": [],
    "stonewalling": [],
    "defensiveness": [],
    "fondnessAdmiration": ["quote...", "..."],
    "turningToward": ["quote..."],
    "repairAttempts": ["quote..."],
    "curiosity": ["quote..."],
    "playfulness": ["quote..."],
    "autonomyTogetherness": ["quote..."]
  },
  "summary": "2-4 sentence analysis of today's communication patterns, noting strengths and areas of concern. Be specific about what you observed."
}

JSON:`;
}

export async function runDailyAnalysis(
  store: RelationshipStore,
  progress?: AnalyzeProgress
): Promise<void> {
  // Reset progress
  if (progress) {
    progress.active = true;
    progress.phase = "collecting";
    progress.messageCount = 0;
    progress.log = [];
    progress.errorMessage = undefined;
  }

  try {
    logProgress(progress, "Collecting unanalyzed messages...");
    const messages = store.getUnanalyzedMessages();

    if (messages.length === 0) {
      logProgress(progress, "No new messages to analyze.");
      if (progress) {
        progress.phase = "done";
        progress.active = false;
        setTimeout(() => { if (progress.phase === "done") progress.phase = "idle"; }, 15000);
      }
      return;
    }

    if (progress) progress.messageCount = messages.length;
    logProgress(progress, `Found ${messages.length} unanalyzed messages.`);

    const today = new Date().toISOString().split("T")[0];
    const conversation = formatConversation(messages);
    const truncated = conversation.slice(0, 12000);

    if (progress) progress.phase = "analyzing";
    logProgress(progress, `Sending ${messages.length} messages to Claude for analysis...`);

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [
        { role: "user", content: buildAnalysisPrompt(truncated, messages.length, today) },
        { role: "assistant", content: "{" },  // Prefill forces clean JSON output
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    // Reconstruct full JSON (prefill started with "{")
    let jsonStr = "{" + text.trim();
    // Strip markdown fences if present
    if (jsonStr.includes("```")) {
      jsonStr = jsonStr.replace(/```(?:json)?\n?/g, "").replace(/\n?```/g, "");
    }
    // Remove trailing content after the last }
    const lastBrace = jsonStr.lastIndexOf("}");
    if (lastBrace !== -1) jsonStr = jsonStr.slice(0, lastBrace + 1);

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Attempt to salvage: strip evidence (most common source of broken JSON)
      logProgress(progress, `JSON parse failed, retrying without evidence...`);
      const noEvidence = jsonStr.replace(/"evidence"\s*:\s*\{[^}]*(?:\{[^}]*\}[^}]*)*\}/s, '"evidence": {}');
      try {
        parsed = JSON.parse(noEvidence);
      } catch {
        throw parseErr; // Give up with original error
      }
    }
    logProgress(progress, `Analysis received. Health score: ${parsed.metrics.overallHealthScore}/100`);

    if (progress) progress.phase = "saving";
    logProgress(progress, "Saving analysis results...");

    const voiceCount = messages.filter((m) => m.type === "voice").length;
    const estimatedVoiceMinutes = voiceCount * 0.5;

    // Store metrics + evidence together in metrics_json
    const metricsWithEvidence = {
      ...parsed.metrics,
      evidence: parsed.evidence || {},
    };

    store.saveAnalysis(
      today,
      JSON.stringify(metricsWithEvidence),
      parsed.summary,
      messages.length,
      estimatedVoiceMinutes
    );

    store.markAnalyzed(messages.map((m) => m.id));

    logProgress(progress, `Done! Score: ${parsed.metrics.overallHealthScore}/100`);
    logProgress(progress, parsed.summary);

    if (progress) {
      progress.phase = "done";
      progress.active = false;
      setTimeout(() => { if (progress.phase === "done") progress.phase = "idle"; }, 15000);
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error(`[relationship-analysis] Failed:`, errMsg);
    if (progress) {
      progress.phase = "error";
      progress.active = false;
      progress.errorMessage = errMsg;
      progress.log.push(`Error: ${errMsg}`);
      setTimeout(() => { if (progress.phase === "error") progress.phase = "idle"; }, 60000);
    }
  }
}
