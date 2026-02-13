import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config";
import { MetacrisisStore, MetacrisisMessage } from "./store";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

function formatMessages(messages: MetacrisisMessage[]): string {
  return messages
    .map((m) => {
      const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
      const sender = m.sender_name || "Unknown";
      return `[${time}] ${sender}: ${m.body}`;
    })
    .join("\n");
}

function buildSummaryPrompt(
  conversation: string,
  messageCount: number,
  date: string
): string {
  return `You are a community discussion summarizer for the Metacrisis Community Chat — a WhatsApp group focused on existential risks, systems thinking, coordination failures, and civilizational resilience.

DATE: ${date}
MESSAGES: ${messageCount}

CONVERSATION:
${conversation}

Please analyze this group conversation and produce a structured summary:

1. **Key Discussions & Themes**: Summarize the main topics discussed, grouping related messages together.
2. **Action Items or Decisions**: Note any concrete action items, decisions made, or commitments by members.
3. **Notable Quotes or Insights**: Highlight any particularly insightful comments or notable perspectives shared.
4. **Links & Resources**: Briefly note any links or resources shared and their context.

Respond with ONLY a JSON object (no markdown code fences):
{
  "summary": "A 3-6 paragraph summary covering the key discussions, action items, and insights from today's conversation. Use plain text, no markdown.",
  "keyTopics": ["topic1", "topic2", "topic3"]
}

JSON:`;
}

/**
 * Run a daily summary of unprocessed messages using Claude Haiku.
 * Saves the summary to the store and marks messages as processed.
 */
export async function runDailySummary(
  store: MetacrisisStore
): Promise<void> {
  const messages = store.getUnprocessedMessages();
  if (messages.length === 0) {
    console.log("[metacrisis-summary] No new messages to summarize.");
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const conversation = formatMessages(messages);

  // Truncate if extremely long (cap at ~15K chars for cost efficiency)
  const truncated = conversation.slice(0, 15000);

  console.log(
    `[metacrisis-summary] Summarizing ${messages.length} messages for ${today}...`
  );

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: buildSummaryPrompt(truncated, messages.length, today),
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);

    store.saveSummary(
      today,
      parsed.summary,
      JSON.stringify(parsed.keyTopics),
      messages.length
    );

    // Mark messages as processed AFTER extraction succeeds
    store.markProcessed(messages.map((m) => m.id));

    console.log(
      `[metacrisis-summary] Summary complete. Topics: ${parsed.keyTopics.join(", ")}`
    );
  } catch (err: any) {
    console.error(
      `[metacrisis-summary] Failed:`,
      err?.message || err
    );
  }
}

/**
 * Format a summary for WhatsApp delivery using the template.
 * Replaces {{date}}, {{summary}}, and {{topics}} placeholders.
 */
export function formatSummaryForWhatsApp(
  summary: string,
  topics: string[],
  date: string,
  template: string
): string {
  return template
    .replace("{{date}}", date)
    .replace("{{summary}}", summary)
    .replace("{{topics}}", topics.join(", "));
}
