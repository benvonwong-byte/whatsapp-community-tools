/**
 * Ollama LLM provider — uses the Ollama REST API.
 *
 * Endpoints used:
 *   POST /api/generate  — single-shot text generation
 *   POST /api/chat      — multi-turn chat
 *
 * Tool calling is NOT supported; `chat()` and `chatWithToolResult()` always
 * return an empty `toolCalls` array and the model's text response.
 */

import {
  LLMProvider,
  ChatMessage,
  ChatResponse,
  ToolCall,
  ToolDefinition,
  parseJSONResponse,
} from "./types";

// ── Provider class ──

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private modelName: string;

  constructor(
    modelName = "llama3",
    baseUrl = "http://localhost:11434",
  ) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.modelName = modelName;
  }

  async generateJSON<T>(prompt: string): Promise<T> {
    const text = await this.generateText(prompt);
    return parseJSONResponse<T>(text);
  }

  async generateText(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        prompt,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `[ollama] /api/generate failed (${res.status}): ${body.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as { response: string };
    return json.response;
  }

  async chat(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse> {
    // Ollama's /api/chat accepts { role, content } messages directly
    const ollamaMessages: Array<{ role: string; content: string }> = [];

    if (systemPrompt) {
      ollamaMessages.push({ role: "system", content: systemPrompt });
    }

    for (const m of messages) {
      ollamaMessages.push({ role: m.role, content: m.content });
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        messages: ollamaMessages,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `[ollama] /api/chat failed (${res.status}): ${body.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as { message: { content: string } };
    return {
      text: json.message.content,
      toolCalls: [], // Ollama does not support tool calling through this adapter
    };
  }

  async chatWithToolResult(
    messages: ChatMessage[],
    _toolCall: ToolCall,
    toolResult: string,
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse> {
    // Since Ollama doesn't support tool calling, we inject the tool result
    // as a user message and continue the conversation.
    const augmented: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content: `[Tool result]: ${toolResult}`,
      },
    ];
    return this.chat(augmented, tools, systemPrompt);
  }
}
