/**
 * LLM Provider Abstraction Layer — shared types and helpers.
 *
 * Every concrete provider (Gemini, Anthropic, Ollama) implements the
 * `LLMProvider` interface so call sites can swap backends without changes.
 */

// ── Chat types ──

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResponse {
  text: string | null;
  toolCalls: ToolCall[];
}

// ── Provider interface ──

export interface LLMProvider {
  /**
   * Generate a structured JSON response and parse it into `T`.
   * The prompt should instruct the model to reply with JSON only.
   */
  generateJSON<T>(prompt: string): Promise<T>;

  /**
   * Generate a plain-text response.
   */
  generateText(prompt: string): Promise<string>;

  /**
   * Multi-turn chat, optionally with tool definitions.
   * Returns the assistant's reply which may contain tool calls.
   */
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse>;

  /**
   * Continue a chat after the caller has executed a tool.
   * Sends the tool result back to the model so it can produce a final answer.
   */
  chatWithToolResult(
    messages: ChatMessage[],
    toolCall: ToolCall,
    toolResult: string,
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse>;
}

// ── Helpers ──

/**
 * Strip markdown code fences and extract the first JSON object or array
 * from a raw LLM text response.
 *
 * Handles patterns like:
 *   ```json\n{...}\n```
 *   ```\n[...]\n```
 *   Some preamble text {actual: "json"} trailing text
 */
export function parseJSONResponse<T = unknown>(raw: string): T {
  let text = raw.trim();

  // Strip markdown fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  // Try direct parse first (fastest path)
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through to extraction
  }

  // Find outermost JSON object
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as T;
    } catch {
      // Fall through to array check
    }
  }

  // Find outermost JSON array
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1)) as T;
    } catch {
      // Fall through
    }
  }

  // Last resort: throw with context
  throw new Error(
    `Failed to parse JSON from LLM response: ${text.slice(0, 200)}...`,
  );
}
