import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config";
import { RelationshipStore, RelationshipMessage } from "./store";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

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
  "summary": "2-4 sentence analysis of today's communication patterns, noting strengths and areas of concern. Be specific about what you observed."
}

JSON:`;
}

export async function runDailyAnalysis(store: RelationshipStore): Promise<void> {
  const messages = store.getUnanalyzedMessages();
  if (messages.length === 0) {
    console.log("[relationship-analysis] No new messages to analyze.");
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const conversation = formatConversation(messages);

  // Truncate if extremely long (cap at ~12K chars for cost efficiency)
  const truncated = conversation.slice(0, 12000);

  console.log(`[relationship-analysis] Analyzing ${messages.length} messages for ${today}...`);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: buildAnalysisPrompt(truncated, messages.length, today) }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);

    // Calculate voice minutes
    const voiceCount = messages.filter((m) => m.type === "voice").length;
    const estimatedVoiceMinutes = voiceCount * 0.5; // rough estimate: 30s avg per voice note

    store.saveAnalysis(
      today,
      JSON.stringify(parsed.metrics),
      parsed.summary,
      messages.length,
      estimatedVoiceMinutes
    );

    // Mark messages as analyzed
    store.markAnalyzed(messages.map((m) => m.id));

    console.log(`[relationship-analysis] Analysis complete. Score: ${parsed.metrics.overallHealthScore}/100`);
    console.log(`[relationship-analysis] ${parsed.summary}`);
  } catch (err: any) {
    console.error(`[relationship-analysis] Failed:`, err?.message || err);
  }
}
