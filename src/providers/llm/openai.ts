/**
 * OpenAI-compatible LLM provider — wraps the openai SDK.
 *
 * Works with any provider that exposes an OpenAI-compatible API:
 * OpenAI, xAI Grok, DeepSeek, Groq, Together.ai, Mistral, OpenRouter, Qwen, etc.
 * Just pass a different `baseURL` and `model` to the constructor.
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import {
  LLMProvider,
  ChatMessage,
  ChatResponse,
  ToolCall,
  ToolDefinition,
  parseJSONResponse,
} from "./types";

const MAX_TOKENS = 4096;

// ── Helpers ──

/** Convert our ToolDefinition[] to OpenAI's ChatCompletionTool[] format */
function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Convert our ChatMessage[] to OpenAI's ChatCompletionMessageParam[] */
function toOpenAIMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

/** Extract text and tool calls from an OpenAI chat completion */
function parseOpenAIResponse(choice: OpenAI.Chat.Completions.ChatCompletion.Choice): ChatResponse {
  const msg = choice.message;
  const text = msg.content ?? null;
  const toolCalls: ToolCall[] = [];

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}"),
      });
    }
  }

  return { text, toolCalls };
}

// ── Provider class ──

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private modelName: string;

  constructor(apiKey: string, baseURL?: string, modelName = "gpt-4o-mini") {
    const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
    if (baseURL) {
      opts.baseURL = baseURL;
    }
    this.client = new OpenAI(opts);
    this.modelName = modelName;
  }

  async generateJSON<T>(prompt: string): Promise<T> {
    const text = await this.generateText(prompt);
    return parseJSONResponse<T>(text);
  }

  async generateText(prompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.modelName,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });

    return response.choices[0]?.message?.content ?? "";
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse> {
    const openaiMsgs = toOpenAIMessages(messages);

    // Inject system prompt if provided (and not already present)
    if (systemPrompt && !messages.some((m) => m.role === "system")) {
      openaiMsgs.unshift({ role: "system", content: systemPrompt });
    }

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.modelName,
      max_tokens: MAX_TOKENS,
      messages: openaiMsgs,
    };

    if (tools && tools.length > 0) {
      params.tools = toOpenAITools(tools);
    }

    const response = await this.client.chat.completions.create(params);
    return parseOpenAIResponse(response.choices[0]);
  }

  async chatWithToolResult(
    messages: ChatMessage[],
    toolCall: ToolCall,
    toolResult: string,
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse> {
    const openaiMsgs = toOpenAIMessages(messages);

    if (systemPrompt && !messages.some((m) => m.role === "system")) {
      openaiMsgs.unshift({ role: "system", content: systemPrompt });
    }

    // Append the assistant turn containing the tool call
    openaiMsgs.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.args),
          },
        },
      ],
    });

    // Append the tool result
    const toolMsg: ChatCompletionToolMessageParam = {
      role: "tool",
      tool_call_id: toolCall.id,
      content: toolResult,
    };
    openaiMsgs.push(toolMsg);

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.modelName,
      max_tokens: MAX_TOKENS,
      messages: openaiMsgs,
    };

    if (tools && tools.length > 0) {
      params.tools = toOpenAITools(tools);
    }

    const response = await this.client.chat.completions.create(params);
    return parseOpenAIResponse(response.choices[0]);
  }
}
