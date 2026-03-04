/**
 * Anthropic LLM provider — wraps @anthropic-ai/sdk.
 *
 * Uses claude-sonnet-4-6 by default.  Supports tool_use for chat-with-tools.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
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

/** Convert our ToolDefinition[] to Anthropic's Tool[] format */
function toAnthropicTools(tools: ToolDefinition[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: (t.parameters as any).properties ?? {},
      required: (t.parameters as any).required ?? [],
    },
  }));
}

/** Convert our ChatMessage[] to Anthropic's MessageParam[] format.
 *  System messages are extracted separately (Anthropic uses a top-level `system` param). */
function toAnthropicMessages(
  messages: ChatMessage[],
): { system: string | undefined; messages: MessageParam[] } {
  let system: string | undefined;
  const msgs: MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      // Anthropic supports only one system prompt; concatenate if multiple
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }
    msgs.push({
      role: m.role as "user" | "assistant",
      content: m.content,
    });
  }

  return { system, messages: msgs };
}

/** Extract text and tool calls from an Anthropic Message response */
function parseAnthropicResponse(content: Anthropic.Messages.ContentBlock[]): ChatResponse {
  let text: string | null = null;
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text") {
      text = (text ?? "") + block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input as Record<string, unknown>,
      });
    }
  }

  return { text, toolCalls };
}

// ── Provider class ──

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private modelName: string;

  constructor(apiKey: string, modelName = "claude-sonnet-4-6") {
    this.client = new Anthropic({ apiKey });
    this.modelName = modelName;
  }

  async generateJSON<T>(prompt: string): Promise<T> {
    const text = await this.generateText(prompt);
    return parseJSONResponse<T>(text);
  }

  async generateText(prompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });

    const textParts = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text);

    return textParts.join("");
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse> {
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);

    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.modelName,
      max_tokens: MAX_TOKENS,
      messages: anthropicMsgs,
    };

    // Use explicit systemPrompt if provided, otherwise use extracted system message
    const effectiveSystem = systemPrompt ?? system;
    if (effectiveSystem) {
      params.system = effectiveSystem;
    }

    if (tools && tools.length > 0) {
      params.tools = toAnthropicTools(tools);
    }

    const response = await this.client.messages.create(params);
    return parseAnthropicResponse(response.content);
  }

  async chatWithToolResult(
    messages: ChatMessage[],
    toolCall: ToolCall,
    toolResult: string,
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse> {
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);

    // Append the assistant turn containing the tool_use block
    const assistantContent: (TextBlockParam | ToolUseBlockParam)[] = [
      {
        type: "tool_use" as const,
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.args,
      },
    ];
    anthropicMsgs.push({ role: "assistant", content: assistantContent });

    // Append the user turn with the tool_result
    const toolResultContent: ToolResultBlockParam[] = [
      {
        type: "tool_result" as const,
        tool_use_id: toolCall.id,
        content: toolResult,
      },
    ];
    anthropicMsgs.push({ role: "user", content: toolResultContent });

    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.modelName,
      max_tokens: MAX_TOKENS,
      messages: anthropicMsgs,
    };

    const effectiveSystem = systemPrompt ?? system;
    if (effectiveSystem) {
      params.system = effectiveSystem;
    }

    if (tools && tools.length > 0) {
      params.tools = toAnthropicTools(tools);
    }

    const response = await this.client.messages.create(params);
    return parseAnthropicResponse(response.content);
  }
}
