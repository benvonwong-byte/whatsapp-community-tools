/**
 * Gemini LLM provider — wraps @google/generative-ai with rate limiting.
 *
 * Rate limiting: 2 s minimum interval between calls, exponential backoff
 * on 429 (rate-limit) errors, up to 3 retries.
 */

import {
  GoogleGenerativeAI,
  GenerateContentResult,
} from "@google/generative-ai";
import {
  LLMProvider,
  ChatMessage,
  ChatResponse,
  ToolCall,
  ToolDefinition,
  parseJSONResponse,
} from "./types";

// ── Rate limiter (shared across all calls) ──

let lastCallTs = 0;
const MIN_INTERVAL = 2_000; // 2 s between calls

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - lastCallTs);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallTs = Date.now();
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForRateLimit();
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status || err?.httpStatusCode;
      if (status === 429 && attempt < retries) {
        const backoff = Math.min(30_000, 10_000 * (attempt + 1));
        console.log(
          `[gemini] Rate limited (429), retrying in ${(backoff / 1000).toFixed(0)}s (attempt ${attempt + 1}/${retries})`,
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
  throw new Error("[gemini] Rate limit retries exhausted");
}

// ── Helpers ──

/** Convert our generic ToolDefinition[] to Gemini's functionDeclarations format */
function toGeminiFunctionDeclarations(
  tools: ToolDefinition[],
): { functionDeclarations: any[] }[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

/** Convert our ChatMessage[] to Gemini's history format */
function toGeminiHistory(
  messages: ChatMessage[],
): Array<{ role: string; parts: Array<{ text: string }> }> {
  return messages
    .filter((m) => m.role !== "system") // system handled separately
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
}

// ── Provider class ──

export class GeminiProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private modelName: string;

  constructor(apiKey: string, modelName = "gemini-2.5-flash") {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
    this.model = this.genAI.getGenerativeModel({ model: modelName });
  }

  async generateJSON<T>(prompt: string): Promise<T> {
    const text = await this.generateText(prompt);
    return parseJSONResponse<T>(text);
  }

  async generateText(prompt: string): Promise<string> {
    return withRetry(async () => {
      const result: GenerateContentResult =
        await this.model.generateContent(prompt);
      return result.response.text();
    });
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse> {
    return withRetry(async () => {
      // Build model options for chat
      const modelOpts: any = {
        model: this.modelName,
      };
      if (systemPrompt) {
        modelOpts.systemInstruction = systemPrompt;
      }
      if (tools && tools.length > 0) {
        modelOpts.tools = toGeminiFunctionDeclarations(tools);
      }

      const chatModel = this.genAI.getGenerativeModel(modelOpts);

      // Split messages into history (all but last) and current
      const allMessages = messages.filter((m) => m.role !== "system");
      const history = toGeminiHistory(allMessages.slice(0, -1));
      const lastMessage = allMessages[allMessages.length - 1];

      const chat = chatModel.startChat({ history });
      const result = await chat.sendMessage(lastMessage?.content || "");

      const calls = result.response.functionCalls();
      const toolCalls: ToolCall[] = (calls || []).map(
        (fc: any, idx: number) => ({
          id: `gemini_fc_${Date.now()}_${idx}`,
          name: fc.name,
          args: fc.args as Record<string, unknown>,
        }),
      );

      const text = !calls || calls.length === 0 ? result.response.text() : null;

      return { text, toolCalls };
    });
  }

  async chatWithToolResult(
    messages: ChatMessage[],
    toolCall: ToolCall,
    toolResult: string,
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse> {
    return withRetry(async () => {
      const modelOpts: any = {
        model: this.modelName,
      };
      if (systemPrompt) {
        modelOpts.systemInstruction = systemPrompt;
      }
      if (tools && tools.length > 0) {
        modelOpts.tools = toGeminiFunctionDeclarations(tools);
      }

      const chatModel = this.genAI.getGenerativeModel(modelOpts);

      // Build history including the tool call exchange
      const allMessages = messages.filter((m) => m.role !== "system");
      const history = toGeminiHistory(allMessages);

      // Append the model's function call turn
      history.push({
        role: "model",
        parts: [
          {
            functionCall: {
              name: toolCall.name,
              args: toolCall.args,
            },
          },
        ] as any,
      });

      const chat = chatModel.startChat({ history });

      // Send the function response
      const result = await chat.sendMessage([
        {
          functionResponse: {
            name: toolCall.name,
            response: { result: toolResult },
          },
        },
      ] as any);

      const calls = result.response.functionCalls();
      const newToolCalls: ToolCall[] = (calls || []).map(
        (fc: any, idx: number) => ({
          id: `gemini_fc_${Date.now()}_${idx}`,
          name: fc.name,
          args: fc.args as Record<string, unknown>,
        }),
      );

      const text =
        !calls || calls.length === 0 ? result.response.text() : null;

      return { text, toolCalls: newToolCalls };
    });
  }
}
